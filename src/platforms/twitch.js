// Twitch Helix: token, user info, live + VOD fetch.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { fetchText, postForm } = require('../net.js');

async function fetchTwitch(path) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!clientId) throw new Error('TWITCH_CLIENT_ID env var not set');
    const token = await getTwitchToken();
    let raw;
    try {
        raw = await fetchText(`https://api.twitch.tv/helix/${path}`, {
            'Client-Id': clientId,
            'Authorization': `Bearer ${token}`,
        });
    } catch (e) {
        // A revoked/rotated token would otherwise keep failing until its cached expiry.
        if (/HTTP 401/.test(e.message)) twitchToken = null;
        throw e;
    }
    return JSON.parse(raw);
}

// ── Twitch OAuth token management ─────────────────────────────────────────
let twitchToken = null, twitchTokenExpiry = 0;

async function getTwitchToken() {
    if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
    const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET env vars not set');

    const { status, json: res } = await postForm('https://id.twitch.tv/oauth2/token', {
        client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
    });
    if (!res?.access_token) throw new Error(`Twitch token error (HTTP ${status}): ${res?.message || 'no access_token in response'}`);
    twitchToken = res.access_token;
    twitchTokenExpiry = Date.now() + (res.expires_in * 1000);
    return twitchToken;
}

// Cache login→id mappings to avoid repeated lookups
const twitchUserIdCache = new Map();

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
