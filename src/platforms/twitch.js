// Twitch Helix: token, user info, live + VOD fetch.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const https = require('https');
const { fetchText } = require('../net.js');

async function fetchTwitch(path) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!clientId) throw new Error('TWITCH_CLIENT_ID env var not set');
    const token = await getTwitchToken();
    const raw = await fetchText(`https://api.twitch.tv/helix/${path}`, {
        'Client-Id': clientId,
        'Authorization': `Bearer ${token}`,
    });
    return JSON.parse(raw);
}

// ── Twitch OAuth token management ─────────────────────────────────────────
let twitchToken = null, twitchTokenExpiry = 0;

async function getTwitchToken() {
    if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
    const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET env vars not set');

    // Twitch's token endpoint requires POST, so we can't use fetchText (GET-only) here.
    const res = await new Promise((resolve, reject) => {
        const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
        const req = https.request('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject); req.write(body); req.end();
    });
    if (!res.access_token) throw new Error(`Twitch token error: ${JSON.stringify(res)}`);
    twitchToken = res.access_token;
    twitchTokenExpiry = Date.now() + (res.expires_in * 1000);
    return twitchToken;
}

// Cache login→id mappings to avoid repeated lookups
const twitchUserIdCache = new Map();

async function getTwitchUserId(login) {
    return (await getTwitchUserInfo(login)).id;
}

// Cache both the numeric ID and profile picture — the latter is used as a fallback
// thumbnail when a specific stream/VOD doesn't have its own preview image yet
// (common for very fresh streams/VODs, and Twitch sometimes just leaves it empty).
async function getTwitchUserInfo(login) {
    if (twitchUserIdCache.has(login)) return twitchUserIdCache.get(login);
    const data = await fetchTwitch(`users?login=${encodeURIComponent(login)}`);
    const user = data.data?.[0];
    if (!user) throw new Error(`Twitch user "${login}" not found`);
    const info = { id: user.id, profileImageUrl: user.profile_image_url || null };
    twitchUserIdCache.set(login, info);
    return info;
}

// Returns array of posts: [{id, url, title, author, thumbnail, timestamp, postType}]
async function fetchLatestTwitchAll(handle) {
    const { id: userId, profileImageUrl } = await getTwitchUserInfo(handle);
    const [streamData, vodData] = await Promise.all([
        fetchTwitch(`streams?user_id=${userId}`),
        fetchTwitch(`videos?user_id=${userId}&type=archive&first=1`),
    ]);
    const results = [];

    const stream = streamData.data?.[0];
    if (stream) {
        const liveThumb = (stream.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720');
        results.push({
            id: `live_${stream.id}`,
            url: `https://www.twitch.tv/${handle}`,
            title: stream.title || `${handle} is live!`,
            author: stream.user_name || handle,
            // Fresh streams sometimes don't have a preview snapshot yet — fall back to the
            // channel's profile picture rather than showing no image at all.
            thumbnail: liveThumb || profileImageUrl,
            timestamp: stream.started_at,
            postType: 'live',
            isLive: true,
        });
    }

    const vod = vodData.data?.[0];
    if (vod) {
        const vodThumb = (vod.thumbnail_url || '').replace('%{width}', '1280').replace('%{height}', '720');
        results.push({
            id: vod.id,
            url: vod.url,
            title: vod.title,
            author: vod.user_name || handle,
            // Twitch often leaves thumbnail_url empty for VODs (especially right after a
            // stream ends, before the thumbnail's generated) — same fallback as above.
            thumbnail: vodThumb || profileImageUrl,
            timestamp: vod.published_at || vod.created_at,
            postType: 'vods',
        });
    }
    return results;
}

module.exports = { fetchLatestTwitchAll };
