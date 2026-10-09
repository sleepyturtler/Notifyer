// Kick public API: token, channel info, live fetch.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { fetchJson, postForm } = require('../net.js');

// ── Kick ─────────────────────────────────────────────────────────────────
// Kick's official public API. Live status is public data, so we use an
// app-level Client Credentials token (no per-channel authorization needed) —
// unlike Instagram/TikTok, this works for any public Kick channel.
async function fetchKick(path) {
    const clientId = process.env.KICK_CLIENT_ID, clientSecret = process.env.KICK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars not set');
    const token = await getKickAppToken();
    const { status, json } = await fetchJson(`https://api.kick.com/public/v1/${path}`, { Authorization: `Bearer ${token}` });
    // A non-200 (429, 5xx, expired token) must surface as an error: returning the error body
    // would read as "no livestream" and make the poller mark a live stream as ended.
    if (status === 401) kickToken = null;
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return json;
}

let kickToken = null, kickTokenExpiry = 0;

async function getKickAppToken() {
    if (kickToken && Date.now() < kickTokenExpiry - 60_000) return kickToken;
    const clientId = process.env.KICK_CLIENT_ID, clientSecret = process.env.KICK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars not set');
    const { json } = await postForm('https://id.kick.com/oauth/token', {
        client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
    });
    if (!json?.access_token) throw new Error(`Kick token error: ${JSON.stringify(json)}`);
    kickToken = json.access_token;
    kickTokenExpiry = Date.now() + (json.expires_in * 1000);
    return kickToken;
}

// Cache slug→channel info mappings to avoid repeated lookups. Stores the broadcaster ID
// plus a fallback image (profile/banner picture) for when a specific livestream doesn't
// have its own thumbnail set.
const kickBroadcasterIdCache = new Map();

async function getKickChannelInfo(slug) {
    if (kickBroadcasterIdCache.has(slug)) return kickBroadcasterIdCache.get(slug);
    const data = await fetchKick(`channels?slug=${encodeURIComponent(slug)}`).catch(e => { if (/HTTP 404/.test(e.message)) return null; throw e; });
    const channel = data?.data?.[0];
    if (!channel) throw new Error(`Kick channel "${slug}" not found`);
    const info = {
        id: channel.broadcaster_user_id,
        fallbackThumb: channel.profile_picture || channel.banner_picture || null,
    };
    kickBroadcasterIdCache.set(slug, info);
    return info;
}

// Returns array of posts: [{id, url, title, author, thumbnail, timestamp, postType, isLive}]
// — only ever 0 or 1 entries, since Kick's public API currently exposes live status only.
async function fetchLatestKickAll(handle) {
    const { id: broadcasterId, fallbackThumb } = await getKickChannelInfo(handle);
    const data = await fetchKick(`livestreams?broadcaster_user_id=${broadcasterId}`);
    const stream = data?.data?.[0];
    if (!stream) return [];
    return [{
        id: `live_${stream.id || stream.started_at}`,
        url: `https://kick.com/${handle}`,
        title: stream.stream_title || `${handle} is live!`,
        author: handle,
        // Fall back to the channel's own picture if this specific stream has no thumbnail set.
        thumbnail: (stream.thumbnail?.url || stream.thumbnail) || fallbackThumb || null,
        timestamp: stream.started_at,
        postType: 'live',
        isLive: true,
    }];
}

module.exports = { fetchLatestKickAll };
