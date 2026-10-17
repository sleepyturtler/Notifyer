// Instagram + TikTok: OAuth code exchange, token refresh, post fetchers.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { fetchJson, postForm, postJson } = require('../net.js');
const { updateSocialLinkTokens } = require('../db.js');
const { OAUTH_CONFIG } = require('../config.js');

// ── OAuth token refresh (Instagram / TikTok) ───────────────────────────────
// Refreshes a stored social_links row's access token if it's near expiry.
// Returns the (possibly updated) row, or throws if refresh fails — callers
// should treat a throw as "the link is dead, tell the person to /social link again".
// TikTok access tokens live exactly 24h, so the margin has to be much shorter than that: with a 24h
// margin every token was always "about to expire" and was refreshed on EVERY poll (~720 times a day).
// Refreshing in the last hour means about once a day. Instagram's tokens last ~60 days, so 24h is fine there.
const REFRESH_MARGIN_MS = { instagram: 24 * 60 * 60 * 1000, tiktok: 60 * 60 * 1000 };

// TikTok reports problems as { error, error_description } (sometimes { error: { code, message } }).
// 429 and 5xx are TikTok's side and clear up by themselves; other 4xx mean the token was rejected, and
// only then does re-linking help. The old code threw one generic "re-link" message for every failure.
// An error flagged relinkNeeded means the platform definitively rejected the saved login (not a hiccup), so retrying
// every poll is pointless: the poller marks the link dead and the owner is asked to run /social link again.
function relinkError(message) { const e = new Error(message); e.relinkNeeded = true; return e; }

function tiktokRefreshError(status, json) {
    const e = json?.error;
    const code = typeof e === 'string' ? e : e?.code;
    const desc = json?.error_description || (typeof e === 'object' ? e?.message : null);
    const detail = [status ? `HTTP ${status}` : null, code, desc].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 200);
    if (status === 429 || status >= 500) return new Error(`TikTok is temporarily unavailable (${detail}); will retry.`);
    // invalid_grant arrives as HTTP 200 with an error body, so the code matters as much as the status. invalid_client
    // is OUR app credentials being wrong, which re-linking can't fix.
    if (code !== 'invalid_client' && (code === 'invalid_grant' || (status >= 400 && status < 500))) {
        return relinkError(`TikTok rejected the saved login (${detail}). The account owner needs to run /social link again.`);
    }
    return new Error(`TikTok sent an unexpected refresh response (${detail}). If this keeps happening, re-link with /social link.`);
}

async function ensureFreshToken(link) {
    const margin = REFRESH_MARGIN_MS[link.platform] ?? REFRESH_MARGIN_MS.instagram;
    if (!link.expires_at || link.expires_at - Date.now() > margin) return link;

    if (link.platform === 'instagram') {
        // Instagram User tokens (Instagram Login flow) refresh via graph.instagram.com directly —
        // no app client_id/secret needed for this call, just the current valid long-lived token.
        const { json } = await fetchJson(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(link.access_token)}`
        );
        if (!json?.access_token) {
            if (json?.error?.code === 190 || json?.error?.type === 'OAuthException') throw relinkError(`Instagram rejected the saved login (${json.error.message || 'token invalid'}). The account owner needs to run /social link again.`);
            throw new Error('Instagram token refresh failed; will retry.');
        }
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 55 * 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, null, expiresAt);
        return { ...link, access_token: json.access_token, expires_at: expiresAt };
    }

    if (link.platform === 'tiktok') {
        const cfg = OAUTH_CONFIG.tiktok;
        if (!link.refresh_token) throw new Error('TikTok refresh token missing — re-link with /social link.');
        let res;
        try {
            res = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
                client_key: cfg.clientId, client_secret: cfg.clientSecret,
                grant_type: 'refresh_token', refresh_token: link.refresh_token,
            });
        } catch (e) {
            throw new Error(`TikTok is temporarily unreachable (${e.message}); will retry.`); // network error/timeout: not the token's fault
        }
        const { status, json } = res;
        if (!json?.access_token) throw tiktokRefreshError(status, json);
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, json.refresh_token || link.refresh_token, expiresAt);
        return { ...link, access_token: json.access_token, refresh_token: json.refresh_token || link.refresh_token, expires_at: expiresAt };
    }

    return link;
}

// ── Instagram (Meta Graph API) ─────────────────────────────────────────────
async function fetchLatestInstagramAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await fetchJson(
        `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_product_type,media_url,permalink,timestamp&limit=10&access_token=${encodeURIComponent(fresh.access_token)}`
    );
    if (json?.error) {
        if (json.error.code === 190) throw relinkError(`Instagram rejected the saved login (${json.error.message}). The account owner needs to run /social link again.`);
        throw new Error(`Instagram API: ${json.error.message}`);
    }
    const items = json?.data || [];
    return items.map(m => ({
        id: m.id,
        url: m.permalink,
        title: (m.caption || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: m.media_type === 'VIDEO' ? null : m.media_url,
        timestamp: m.timestamp,
        // media_product_type: FEED | REELS | STORY (STORY rarely returned — stories expire in 24h and this endpoint mostly covers feed/reels)
        postType: m.media_product_type === 'REELS' ? 'reels' : m.media_product_type === 'STORY' ? 'stories' : 'posts',
    }));
}

// ── TikTok ───────────────────────────────────────────────────────────────
// Best-effort: invalidates the token on TikTok's side so this app drops off
// the user's "Manage app permissions" list. If it fails (already expired,
// network hiccup, etc.) we still proceed to delete our local copy — an
// already-dead token isn't a reason to keep the row around.
async function revokeTikTokToken(link) {
    const cfg = OAUTH_CONFIG.tiktok;
    if (!cfg.clientId || !cfg.clientSecret || !link.access_token) return { ok: false, reason: 'missing credentials/token' };
    try {
        const { status, json } = await postForm('https://open.tiktokapis.com/v2/oauth/revoke/', {
            client_key: cfg.clientId, client_secret: cfg.clientSecret, token: link.access_token,
        });
        if (status >= 200 && status < 300) return { ok: true };
        return { ok: false, reason: json?.error?.message || json?.error_description || `HTTP ${status}` };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function fetchLatestTikTokAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await postJson(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time',
        { max_count: 10 },
        { Authorization: `Bearer ${fresh.access_token}` }
    );
    if (json?.error?.code && json.error.code !== 'ok') {
        if (json.error.code === 'access_token_invalid' || json.error.code === 'scope_not_authorized') throw relinkError(`TikTok rejected the saved login (${json.error.code}). The account owner needs to run /social link again.`);
        throw new Error(`TikTok API: ${json.error.message || json.error.code}`);
    }
    const items = json?.data?.videos || [];
    return items.map(v => ({
        id: v.id,
        url: v.share_url,
        title: (v.title || v.video_description || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: v.cover_image_url,
        timestamp: v.create_time ? v.create_time * 1000 : Date.now(),
        postType: 'videos',
    }));
}

// ── OAuth code exchange (called from the HTTP callback routes) ────────────
// Uses the newer "Instagram API with Instagram Login" (launched July 2024) — unlike the
// older Facebook Login flow, this does NOT require the account to be linked to a Facebook
// Page. The account just needs to be an Instagram Business/Creator account.
async function exchangeInstagramCode(code) {
    const cfg = OAUTH_CONFIG.instagram;
    // 1. Exchange the auth code for a short-lived Instagram User access token.
    const { json: tokenRes } = await postForm('https://api.instagram.com/oauth/access_token', {
        client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code,
    });
    if (!tokenRes?.access_token) throw new Error(tokenRes?.error_message || tokenRes?.error?.message || 'Instagram token exchange failed');

    // 2. Exchange for a long-lived token (~60 days).
    const { json: longRes } = await fetchJson(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(cfg.clientSecret)}&access_token=${encodeURIComponent(tokenRes.access_token)}`
    );
    const accessToken = longRes?.access_token || tokenRes.access_token;
    const expiresIn = longRes?.expires_in || 60 * 24 * 60 * 60;

    // 3. Get the account's own ID + username directly — no Facebook Page lookup needed.
    const { json: profile } = await fetchJson(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`);
    if (!profile?.user_id) throw new Error('Could not fetch the Instagram profile — make sure it\'s a Business or Creator account.');

    return { externalUserId: profile.user_id, externalUsername: profile.username || profile.user_id, accessToken, refreshToken: null, expiresAt: Date.now() + expiresIn * 1000 };
}

async function exchangeTikTokCode(code) {
    const cfg = OAUTH_CONFIG.tiktok;
    const { json } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri,
    });
    if (!json?.access_token) throw new Error(json?.error_description || 'TikTok token exchange failed');
    // GET, not POST — the query string carries `fields`, there's no request body.
    // `username` (needs user.info.profile scope) is the real @handle people type into
    // /social add — display_name is just the shown nickname and often differs from it.
    const { json: userInfo } = await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', { Authorization: `Bearer ${json.access_token}` });
    const username = userInfo?.data?.user?.username || userInfo?.data?.user?.display_name || json.open_id;
    return {
        externalUserId: json.open_id, externalUsername: username,
        accessToken: json.access_token, refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
    };
}

module.exports = { exchangeInstagramCode, exchangeTikTokCode, fetchLatestInstagramAll, fetchLatestTikTokAll, revokeTikTokToken, tiktokRefreshError };
