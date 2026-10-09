// YouTube Data API v3: channel resolution, WebSub subscription, upload fetch, video classification.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { PUBLIC_BASE_URL, WEBSUB_HUB_URL, WEBSUB_VERIFY_TOKEN, YOUTUBE_API_KEY, websubSecretFor } = require('../config.js');
const { fetchJson, postForm } = require('../net.js');
const { getYouTubeSubscription, updateWatchYouTubeIds, upsertYouTubeSubscription } = require('../db.js');

// ── Platform fetchers: each returns { id, url, title, author, thumbnail, timestamp } or null ──
// Resolves a handle (or raw UC... channel ID) to its channel ID and uploads
// playlist ID via the API — 1 quota unit, and only ever called once per watch
// since the result gets cached (see updateWatchYouTubeIds / fetchLatestYouTubeEntries).
async function resolveYouTubeChannel(handle) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const isRawId = /^UC[\w-]{22}$/.test(handle);
    const url = isRawId
        ? `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${handle}&key=${YOUTUBE_API_KEY}`
        : `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle.startsWith('@') ? handle : '@' + handle)}&key=${YOUTUBE_API_KEY}`;
    const { status, json } = await fetchJson(url);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const item = json?.items?.[0];
    if (!item) throw new Error('Could not resolve that YouTube channel — check the handle/URL');
    return { channelId: item.id, uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads };
}

// Subscribes (or renews) a WebSub push subscription for a channel so new
// uploads/live-starts get pushed to /youtube/websub instantly instead of
// waiting for the next poll. Best-effort: routine polling still works as a
// fallback even if this never confirms, so failures here are logged, not thrown.
async function ensureYouTubeSubscription(channelId) {
    if (!PUBLIC_BASE_URL) return; // no public URL to receive the callback on yet
    try {
        const existing = await getYouTubeSubscription(channelId);
        const renewalThreshold = Date.now() + 24 * 60 * 60 * 1000; // renew if expiring within a day
        // `signed` rows were subscribed with a hub.secret; older ones are renewed once so pushes can be verified.
        if (existing && existing.signed && existing.expires_at > renewalThreshold) return; // still fresh
        const leaseSeconds = 4 * 24 * 60 * 60; // ask for ~4 days; the hub may grant a different lease
        const { status } = await postForm(WEBSUB_HUB_URL, {
            'hub.mode': 'subscribe',
            'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
            'hub.callback': `${PUBLIC_BASE_URL}/youtube/websub`,
            'hub.verify': 'async',
            'hub.lease_seconds': String(leaseSeconds),
            'hub.verify_token': WEBSUB_VERIFY_TOKEN,
            'hub.secret': websubSecretFor(channelId), // the hub signs every push with this (X-Hub-Signature)
        }, {}, 30000); // this hub is known to be occasionally slow — 30s instead of the 15s default
        // 202 = accepted (async verification follows), 204 = accepted. Anything else means the hub
        // rejected the request, so don't record a subscription that doesn't exist.
        if (status !== 202 && status !== 204) throw new Error(`hub rejected the subscription (HTTP ${status})`);
        // The hub verifies asynchronously (a GET to our callback, handled in the HTTP
        // server below) before the subscription actually takes effect — record our
        // requested expiry optimistically now; the callback doesn't need to update this.
        await upsertYouTubeSubscription(channelId, Date.now() + leaseSeconds * 1000);
    } catch (e) {
        console.error(`ensureYouTubeSubscription (${channelId}):`, e.message);
    }
}

async function fetchLatestYouTubeEntries(w) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    let { youtube_channel_id: channelId, youtube_uploads_playlist_id: playlistId } = w;
    if (!channelId || !playlistId) {
        const resolved = await resolveYouTubeChannel(w.handle);
        channelId = resolved.channelId;
        playlistId = resolved.uploadsPlaylistId;
        await updateWatchYouTubeIds(w.id, channelId, playlistId);
    }
    // Cheap no-op most of the time (only actually re-subscribes when a lease is
    // genuinely close to expiring) — piggybacking on routine polling means no
    // separate renewal scheduler is needed.
    ensureYouTubeSubscription(channelId).catch(() => {});

    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=10&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    return (json.items || []).map(it => ({
        id: it.contentDetails.videoId,
        url: `https://www.youtube.com/watch?v=${it.contentDetails.videoId}`,
        title: it.snippet.title,
        author: it.snippet.channelTitle,
        thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || null,
        timestamp: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    }));
}

// ── YouTube post type detection ────────────────────────────────────────────
// Classifies a batch of video IDs (video/short/live) in a SINGLE API call —
// videos.list costs 1 quota unit per call regardless of how many IDs are
// requested (up to 50), so always batch this rather than calling per-video.
// Returns { [videoId]: { postType, isLive, isUpcoming, hasEnded } }.
async function classifyYouTubeVideos(videoIds) {
    if (!videoIds.length) return {};
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const result = {};
    for (const item of json.items || []) {
        const isCurrentlyLive = item.snippet.liveBroadcastContent === 'live'
            || (item.liveStreamingDetails && !item.liveStreamingDetails.actualEndTime && item.liveStreamingDetails.actualStartTime);
        let postType = 'videos';
        if (isCurrentlyLive) {
            postType = 'live';
        } else {
            // Shorts heuristic: YouTube's own current cutoff is 3 minutes. ISO 8601
            // duration like PT45S / PT2M30S — anything with an "H" (hours) component
            // is never a Short, and the regex below simply won't match those anyway.
            const m = item.contentDetails.duration?.match(/^PT(?:(\d+)M)?(?:(\d+)S)?$/);
            const totalSeconds = m ? (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10)) : null;
            if (totalSeconds !== null && totalSeconds <= 180) postType = 'shorts';
        }
        // Scheduled streams/premieres show up before they start. Callers skip these (without
        // marking them seen) so the notification fires when they actually go live.
        const isUpcoming = item.snippet.liveBroadcastContent === 'upcoming' && !isCurrentlyLive;
        result[item.id] = { postType, isLive: isCurrentlyLive, isUpcoming, hasEnded: Boolean(item.liveStreamingDetails?.actualEndTime) };
    }
    return result;
}

module.exports = { classifyYouTubeVideos, fetchLatestYouTubeEntries };// YouTube Data API v3: channel resolution, WebSub subscription, upload fetch, video classification.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { PUBLIC_BASE_URL, WEBSUB_HUB_URL, WEBSUB_VERIFY_TOKEN, YOUTUBE_API_KEY } = require('../config.js');
const { fetchJson, postForm } = require('../net.js');
const { getYouTubeSubscription, updateWatchYouTubeIds, upsertYouTubeSubscription } = require('../db.js');

// ── Platform fetchers: each returns { id, url, title, author, thumbnail, timestamp } or null ──
// Resolves a handle (or raw UC... channel ID) to its channel ID and uploads
// playlist ID via the API — 1 quota unit, and only ever called once per watch
// since the result gets cached (see updateWatchYouTubeIds / fetchLatestYouTubeEntries).
async function resolveYouTubeChannel(handle) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const isRawId = /^UC[\w-]{22}$/.test(handle);
    const url = isRawId
        ? `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${handle}&key=${YOUTUBE_API_KEY}`
        : `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle.startsWith('@') ? handle : '@' + handle)}&key=${YOUTUBE_API_KEY}`;
    const { status, json } = await fetchJson(url);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const item = json?.items?.[0];
    if (!item) throw new Error('Could not resolve that YouTube channel — check the handle/URL');
    return { channelId: item.id, uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads };
}

// Subscribes (or renews) a WebSub push subscription for a channel so new
// uploads/live-starts get pushed to /youtube/websub instantly instead of
// waiting for the next poll. Best-effort: routine polling still works as a
// fallback even if this never confirms, so failures here are logged, not thrown.
async function ensureYouTubeSubscription(channelId) {
    if (!PUBLIC_BASE_URL) return; // no public URL to receive the callback on yet
    try {
        const existing = await getYouTubeSubscription(channelId);
        const renewalThreshold = Date.now() + 24 * 60 * 60 * 1000; // renew if expiring within a day
        if (existing && existing.expires_at > renewalThreshold) return; // still fresh
        const leaseSeconds = 4 * 24 * 60 * 60; // ask for ~4 days; the hub may grant a different lease
        await postForm(WEBSUB_HUB_URL, {
            'hub.mode': 'subscribe',
            'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
            'hub.callback': `${PUBLIC_BASE_URL}/youtube/websub`,
            'hub.verify': 'async',
            'hub.lease_seconds': String(leaseSeconds),
            'hub.verify_token': WEBSUB_VERIFY_TOKEN,
        }, {}, 30000); // this hub is known to be occasionally slow — 30s instead of the 15s default
        // The hub verifies asynchronously (a GET to our callback, handled in the HTTP
        // server below) before the subscription actually takes effect — record our
        // requested expiry optimistically now; the callback doesn't need to update this.
        await upsertYouTubeSubscription(channelId, Date.now() + leaseSeconds * 1000);
    } catch (e) {
        console.error(`ensureYouTubeSubscription (${channelId}):`, e.message);
    }
}

async function fetchLatestYouTubeEntries(w) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    let { youtube_channel_id: channelId, youtube_uploads_playlist_id: playlistId } = w;
    if (!channelId || !playlistId) {
        const resolved = await resolveYouTubeChannel(w.handle);
        channelId = resolved.channelId;
        playlistId = resolved.uploadsPlaylistId;
        await updateWatchYouTubeIds(w.id, channelId, playlistId);
    }
    // Cheap no-op most of the time (only actually re-subscribes when a lease is
    // genuinely close to expiring) — piggybacking on routine polling means no
    // separate renewal scheduler is needed.
    ensureYouTubeSubscription(channelId).catch(() => {});

    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=10&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    return (json.items || []).map(it => ({
        id: it.contentDetails.videoId,
        url: `https://www.youtube.com/watch?v=${it.contentDetails.videoId}`,
        title: it.snippet.title,
        author: it.snippet.channelTitle,
        thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || null,
        timestamp: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    }));
}

// ── YouTube post type detection ────────────────────────────────────────────
// Classifies a batch of video IDs (video/short/live) in a SINGLE API call —
// videos.list costs 1 quota unit per call regardless of how many IDs are
// requested (up to 50), so always batch this rather than calling per-video.
// Returns { [videoId]: { postType, isLive } }.
async function classifyYouTubeVideos(videoIds) {
    if (!videoIds.length) return {};
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const result = {};
    for (const item of json.items || []) {
        const isCurrentlyLive = item.snippet.liveBroadcastContent === 'live'
            || (item.liveStreamingDetails && !item.liveStreamingDetails.actualEndTime && item.liveStreamingDetails.actualStartTime);
        let postType = 'videos';
        if (isCurrentlyLive) {
            postType = 'live';
        } else {
            // Shorts heuristic: YouTube's own current cutoff is 3 minutes. ISO 8601
            // duration like PT45S / PT2M30S — anything with an "H" (hours) component
            // is never a Short, and the regex below simply won't match those anyway.
            const m = item.contentDetails.duration?.match(/^PT(?:(\d+)M)?(?:(\d+)S)?$/);
            const totalSeconds = m ? (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10)) : null;
            if (totalSeconds !== null && totalSeconds <= 180) postType = 'shorts';
        }
        result[item.id] = { postType, isLive: isCurrentlyLive, hasEnded: Boolean(item.liveStreamingDetails?.actualEndTime) };
    }
    return result;
}

module.exports = { classifyYouTubeVideos, fetchLatestYouTubeEntries };
