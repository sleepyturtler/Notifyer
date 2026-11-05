// Twitter/X via Nitter mirrors. Reads the account's with_replies feed and returns posts, replies and reposts as
// separate post types (like Bluesky), so each watch can opt in to the ones it wants.
//
// What Nitter's RSS looks like (checked against real feeds):
//   post    title "<text>"                     creator = the account          guid/link = the tweet's own ID
//   reply   title "R to @<user>: <text>"       creator = the account          guid/link = the reply's own ID
//   repost  title "RT by @<account>: <text>"   creator = the ORIGINAL author  guid/link = the ORIGINAL tweet's ID
// A repost's pubDate is the original tweet's time, not the retweet's, and reposts are listed in the order they were
// made. So duplicates are detected by ID only, never by date or by "newer than the last ID seen".

const { NITTER_INSTANCES } = require('../config.js');
const { fetchText, xmlParser } = require('../net.js');

// Must not exceed SEEN_HISTORY_SIZE (config.js): items beyond it would fall out of the seen list and be re-announced.
const FEED_LIMIT = 20;

// The XML parser may hand back strings, numbers or { '#text': ... } objects depending on attributes.
const text = v => (v === undefined || v === null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));

const LINK_RE = /^https?:\/\/[^/]+\/([^/]+)\/status\/(\d+)/;
const REPOST_RE = /^RT by @\w+:\s*/i;
const REPLY_RE = /^R to @(\w+):\s*/i;

// Pure: parsed <item> objects -> posts, in feed order. `handle` is the watched account.
function parseNitterItems(list, handle, feedTitle = null) {
    const me = String(handle).replace(/^@/, '').toLowerCase();
    const out = [], seen = new Set();
    for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        const m = LINK_RE.exec(text(it.link)); // the ID comes from the link: a numeric guid can lose digits in the parser
        if (!m) continue;
        const [, user, tweetId] = m;
        const title = text(it.title).trim();

        let postType = 'posts', body = title, id = tweetId, shown = title;
        if (REPOST_RE.test(title)) {
            postType = 'reposts';
            body = title.replace(REPOST_RE, '');
            id = `r_${tweetId}`;
            shown = `Reposted @${user}: ${body}`;
        } else {
            const r = REPLY_RE.exec(title);
            // A reply to yourself is a thread continuation: it counts as a normal post.
            if (r && r[1].toLowerCase() !== me) {
                postType = 'replies';
                body = title.replace(REPLY_RE, '');
                shown = `Replying to @${r[1]}: ${body}`;
            } else if (r) { body = title.replace(REPLY_RE, ''); shown = body; }
        }
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            id,
            url: `https://x.com/${user}/status/${tweetId}`,
            title: shown.slice(0, 1000),
            author: feedTitle,
            thumbnail: null,
            // A repost carries the original tweet's date, which would make the embed look old: let it show "now".
            timestamp: postType === 'reposts' ? null : (text(it.pubDate) || null),
            postType,
            _num: BigInt(tweetId),
        });
        if (out.length >= FEED_LIMIT) break;
    }
    return out;
}

// One feed URL -> posts. Throws when the request fails or the feed has no usable items.
async function fetchFeed(url, handle) {
    const data = xmlParser.parse(await fetchText(url));
    const items = data?.rss?.channel?.item;
    if (!items) throw new Error('No items in feed');
    const posts = parseNitterItems(Array.isArray(items) ? items : [items], handle, text(data?.rss?.channel?.title) || null);
    if (!posts.length) throw new Error('Could not parse tweet ID');
    return posts;
}

async function fetchMirror(base, handle) {
    // with_replies has everything. Some mirrors don't serve it (an error, or an empty feed), and the plain feed still
    // has posts and reposts, so any failure of the first falls back to the second.
    try { return await fetchFeed(`${base}/${handle}/with_replies/rss`, handle); }
    catch (first) {
        try { return await fetchFeed(`${base}/${handle}/rss`, handle); }
        catch (second) { throw new Error(`${second.message}${first.message === second.message ? '' : ` (with_replies: ${first.message})`}`); }
    }
}

async function fetchLatestTwitterAll(handle) {
    // Twitter/X has no free official API. Query several Nitter mirrors in parallel and use the one that knows the
    // newest tweet, since individual instances are often stale/cached.
    const instances = NITTER_INSTANCES;
    const results = await Promise.allSettled(instances.map(base => fetchMirror(base, handle)));

    const successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!successes.length) {
        const errs = results.map((r, i) => `${instances[i]}: ${r.reason?.message || r.reason?.code || r.reason?.errors?.[0]?.code || r.reason?.name || 'connection failed'}`).join('; ');
        throw new Error(`All Nitter instances failed (${errs})`);
    }

    // Twitter snowflake IDs grow over time. Reposts carry the original's (older) ID, so rank mirrors by their newest
    // own post or reply, and only fall back to reposts when there are none.
    const newest = posts => {
        const own = posts.filter(p => p.postType !== 'reposts');
        return (own.length ? own : posts).reduce((mx, p) => (p._num > mx ? p._num : mx), 0n);
    };
    successes.sort((a, b) => { const x = newest(a), y = newest(b); return y > x ? 1 : y < x ? -1 : 0; });
    return successes[0].map(({ _num, ...p }) => p);
}

module.exports = { fetchLatestTwitterAll, parseNitterItems };
