// HTTP server: health, status/legal pages, OAuth callbacks, YouTube WebSub endpoints, keep-alive.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { URL } = require('url');
const http = require('http');
const https = require('https');
const { SEEN_HISTORY_SIZE, WEBSUB_VERIFY_TOKEN } = require('../config.js');
const { xmlParser } = require('../net.js');
const { getWatchesByYouTubeChannel, setWatchLiveMessage, setWatchYouTubeLiveVideo, updateLastPost, upsertSocialLink } = require('../db.js');
const { classifyYouTubeVideos } = require('../platforms/youtube.js');
const { sendNotification, shouldNotify } = require('../notify.js');
const { sendOrExtendBatch } = require('../batch.js');
const { consumeOAuthState } = require('../state.js');
const { exchangeInstagramCode, exchangeTikTokCode } = require('../platforms/social.js');
const { PRIVACY_HTML, TERMS_HTML, buildStatusHTML } = require('./pages.js');

// Escapes text that gets interpolated into htmlResponse's message/title strings.
// htmlResponse itself can't escape blindly — its `message` argument is a mix of
// HTML we wrote on purpose (e.g. <code>, <b>, <br>) and dynamic values baked into
// that string — so each dynamic value has to be escaped individually before it's
// interpolated, at the call site, not the whole final string.
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function htmlResponse(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>${title}</h2><p>${message}</p></body></html>`);
}

// ── YouTube WebSub (PubSubHubbub) callback ──────────────────────────────────
// GET: the hub's subscribe/unsubscribe verification handshake — echo back
// hub.challenge if hub.verify_token matches what we sent when subscribing.
function handleYouTubeWebSubVerify(req, res) {
    const u = new URL(req.url, `https://${req.headers.host}`);
    const mode = u.searchParams.get('hub.mode');
    const challenge = u.searchParams.get('hub.challenge');
    const verifyToken = u.searchParams.get('hub.verify_token');
    if ((mode === 'subscribe' || mode === 'unsubscribe') && verifyToken === WEBSUB_VERIFY_TOKEN && challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(challenge);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}

// POST: the actual push — an Atom feed with one or more <entry> elements. Each
// entry means "this video is new or was just updated" (a live stream typically
// triggers this the moment it starts). We still share the same seen_post_ids
// dedup as routine polling, so if a poll and a push both catch the same video,
// only the first one to arrive actually sends anything.
async function handleYouTubeWebSubPush(req, res) {
    let body = '';
    // Without this, a client that aborts mid-upload emits an unhandled 'error' on
    // req — which (unlike a rejected promise) isn't caught anywhere and crashes
    // the whole process, the same class of issue as the top-level HTTP try/catch.
    req.on('error', e => console.error('YouTube WebSub push request:', e.message));
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); // ack immediately, hub expects a quick 2xx
        try {
            const data = xmlParser.parse(body);
            const rawEntries = data?.feed?.entry;
            if (!rawEntries) return;
            const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
            // Non-live entries go through the same rolling batch window as routine
            // polling (see sendOrExtendBatch) — a single push can carry several
            // <entry> elements at once (e.g. a channel bulk-uploading), and this
            // makes sure a burst still collapses into one message the same way.
            for (const entry of entries) {
                const videoId = entry['yt:videoId'];
                const channelId = entry['yt:channelId'];
                if (!videoId || !channelId) continue;
                const watches = await getWatchesByYouTubeChannel(channelId);
                // Classify once per video, not once per watch — several servers can
                // track the same channel, and classifyYouTubeVideos is a real,
                // quota-costed API call, so doing it per-watch was hitting the same
                // endpoint N times for what's always the same answer. Lazy (only
                // fires if at least one watch actually needs it) so a video that's
                // already-seen/pre-baseline for every watch still skips it entirely,
                // same as before.
                let classified = null;
                for (const w of watches) {
                    const seenIds = Array.isArray(w.seen_post_ids) ? w.seen_post_ids : [];
                    if (w.last_post_id === null || seenIds.includes(videoId)) continue; // baseline not seeded yet, or already handled
                    if (!classified) classified = await classifyYouTubeVideos([videoId]);
                    const c = classified[videoId];
                    const post = {
                        id: videoId,
                        url: c?.postType === 'shorts' ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
                        title: entry.title,
                        author: entry.author?.name,
                        thumbnail: null,
                        timestamp: entry.published,
                        postType: c?.postType || 'videos',
                        isLive: Boolean(c?.isLive),
                    };
                    const mergedSeen = [...new Set([videoId, ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
                    await updateLastPost(w.id, videoId, mergedSeen, true);
                    if (!shouldNotify(w, post)) continue;
                    if (post.isLive) {
                        // Live entries always send individually and immediately, with their
                        // own message-edit tracking — never batched, same rule as pollAll.
                        const sent = await sendNotification(w, post);
                        if (sent) { await setWatchLiveMessage(w.id, sent.id); await setWatchYouTubeLiveVideo(w.id, videoId); }
                    } else {
                        await sendOrExtendBatch(w, post);
                    }
                }
            }
        } catch (e) {
            console.error('YouTube WebSub push handling:', e.message);
        }
    });
}

async function handleOAuthCallback(platform, req, res) {
    const u = new URL(req.url, `https://${req.headers.host}`);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const oauthError = u.searchParams.get('error');
    const oauthErrorDescription = u.searchParams.get('error_description') || u.searchParams.get('error_reason');
    if (oauthError) return htmlResponse(res, 400, 'Authorization denied', `${platform === 'instagram' ? 'Meta' : 'TikTok'} returned: <code>${escapeHtml(oauthError)}</code>${oauthErrorDescription ? ` — ${escapeHtml(oauthErrorDescription)}` : ''}.<br>You can close this tab and run /social link again if this wasn't intentional.`);

    const stateEntry = state ? consumeOAuthState(state) : null;
    if (!stateEntry || stateEntry.platform !== platform) return htmlResponse(res, 400, 'Invalid or expired link', 'Run /social link again in Discord and try once more within 10 minutes.');
    if (!code) return htmlResponse(res, 400, 'Missing authorization code', `${platform === 'instagram' ? 'Meta' : 'TikTok'} redirected back without a code — no query parameters other than what's in the URL bar above were received. Close this tab and run /social link again.`);

    try {
        const identity = platform === 'instagram' ? await exchangeInstagramCode(code) : await exchangeTikTokCode(code);
        await upsertSocialLink({
            guildId: stateEntry.guildId, platform,
            externalUserId: identity.externalUserId, externalUsername: identity.externalUsername,
            accessToken: identity.accessToken, refreshToken: identity.refreshToken, expiresAt: identity.expiresAt,
            linkedBy: stateEntry.userId,
        });
        return htmlResponse(res, 200, 'Linked!', `<b>${escapeHtml(identity.externalUsername)}</b> is now linked. You can close this tab and go back to Discord, then use <code>/social add</code> to start tracking it.`);
    } catch (e) {
        console.error(`OAuth callback (${platform}):`, e.message);
        return htmlResponse(res, 500, 'Link failed', `${escapeHtml(e.message)} — you can close this tab and try /social link again.`);
    }
}

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    // A single malformed request (e.g. one that trips new URL(req.url, ...) in a
    // sub-handler) used to throw synchronously here with nothing to catch it,
    // which crashes the *entire* Node process — not just that one request. This
    // wraps routing so a bad request gets a 500 instead of taking the bot down.
    try {
        const path = req.url.split('?')[0];
        if (path === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK');
        }
        if (path === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(buildStatusHTML());
        }
        if (path === '/terms') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(TERMS_HTML); }
        if (path === '/privacy') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PRIVACY_HTML); }
        // TikTok (and similar) domain-ownership verification file, hardcoded from the
        // actual downloaded file's content to avoid copy/paste corruption through env vars.
        const TIKTOK_VERIFY_FILENAME = process.env.TIKTOK_VERIFY_FILENAME || 'tiktok54ye0zN8LYl3cx2fMAolswrgKzdRfnvK.txt';
        const TIKTOK_VERIFY_CONTENT = process.env.TIKTOK_VERIFY_CONTENT || 'tiktok-developers-site-verification=54ye0zN8LYl3cx2fMAolswrgKzdRfnvK';
        if (path === `/${TIKTOK_VERIFY_FILENAME}`) {
            res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(TIKTOK_VERIFY_CONTENT);
        }
        if (path === '/oauth/instagram/callback') return handleOAuthCallback('instagram', req, res);
        if (path === '/oauth/tiktok/callback') return handleOAuthCallback('tiktok', req, res);
        if (path === '/youtube/websub') {
            if (req.method === 'GET') return handleYouTubeWebSubVerify(req, res);
            if (req.method === 'POST') return handleYouTubeWebSubPush(req, res);
        }
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
    } catch (e) {
        console.error('HTTP request handling:', e.message);
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal error'); }
    }
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

// Keep-alive: ping our own URL periodically so Render's free tier doesn't spin down.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;

if (KEEP_ALIVE_URL) {
    setInterval(() => {
        https.get(`${KEEP_ALIVE_URL.replace(/\/$/, '')}/health`, res => res.resume())
            .on('error', e => console.error('⚠️ Keep-alive ping failed:', e.message));
    }, 10 * 60 * 1000); // every 10 minutes
} else {
    console.log('ℹ️ KEEP_ALIVE_URL/RENDER_EXTERNAL_URL not set — self-ping disabled.');
}
