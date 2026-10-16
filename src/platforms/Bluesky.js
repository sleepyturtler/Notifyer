// Bluesky via the public AppView API: no credentials, no OAuth. Returns posts, replies and reposts
// as separate post types so each watch can opt in to the ones it wants.

const { fetchJson } = require('../net.js');

const FEED_URL = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';
// Must not exceed SEEN_HISTORY_SIZE (config.js): items beyond it would fall out of the seen list and be re-announced.
const FEED_LIMIT = 20;

const rkey = uri => String(uri || '').split('/').pop();

// First usable image of a post view: images, video thumbnail, link card, or the media half of a quote-with-media.
function embedImage(e) {
    if (!e) return null;
    if (e.images?.[0]) return e.images[0].fullsize || e.images[0].thumb || null;
    if (e.thumbnail) return e.thumbnail;
    if (e.external?.thumb) return e.external.thumb;
    if (e.media) return embedImage(e.media);
    return null;
}

async function fetchLatestBlueskyAll(handle) {
    const { status, json } = await fetchJson(`${FEED_URL}?actor=${encodeURIComponent(handle)}&filter=posts_with_replies&limit=${FEED_LIMIT}`);
    if (status === 400) throw new Error(`Bluesky account "${handle}" not found${json?.message ? ` (${json.message})` : ''}`);
    if (status !== 200 || !Array.isArray(json?.feed)) throw new Error(`HTTP ${status}`);

    const out = [];
    for (const item of json.feed) {
        const post = item.post;
        if (!post?.uri || !post.author?.handle) continue;
        const reasonType = item.reason?.$type || '';
        if (reasonType.endsWith('reasonPin')) continue; // pinned posts are old; they're in the feed for display only
        const isRepost = reasonType.endsWith('reasonRepost');
        const isReply = !isRepost && Boolean(post.record?.reply);
        const text = String(post.record?.text || '');
        const url = `https://bsky.app/profile/${post.author.handle}/post/${rkey(post.uri)}`;
        const actor = isRepost ? item.reason.by : post.author;
        let title = text;
        if (isRepost) title = `Reposted @${post.author.handle}: ${text}`;
        else if (isReply && item.reply?.parent?.author?.handle) title = `Replying to @${item.reply.parent.author.handle}: ${text}`;
        out.push({
            id: isRepost ? `r_${item.reason.uri ? rkey(item.reason.uri) : post.cid}` : `p_${rkey(post.uri)}`,
            url,
            title: title.slice(0, 1000),
            author: actor?.displayName || actor?.handle || handle,
            thumbnail: embedImage(post.embed),
            timestamp: (isRepost ? item.reason.indexedAt : post.record?.createdAt || post.indexedAt) || null,
            postType: isRepost ? 'reposts' : isReply ? 'replies' : 'posts',
        });
    }
    return out;
}

module.exports = { fetchLatestBlueskyAll };
