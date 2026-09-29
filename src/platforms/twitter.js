// Twitter/X via Nitter mirrors.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { NITTER_INSTANCES } = require('../config.js');
const { fetchText, xmlParser } = require('../net.js');

async function fetchLatestTwitter(handle) {
    // Twitter/X has no free official API. Query several Nitter mirrors in
    // parallel and pick whichever returns the newest tweet (by numeric ID),
    // since individual instances are often stale/cached.
    const instances = NITTER_INSTANCES;

    const results = await Promise.allSettled(instances.map(async base => {
        const xml = await fetchText(`${base}/${handle}/rss`);
        const data = xmlParser.parse(xml);
        const items = data?.rss?.channel?.item;
        if (!items) throw new Error('No items in feed');
        const item = Array.isArray(items) ? items[0] : items;
        const idMatch = (item.link || item.guid || '').match(/status\/(\d+)/);
        if (!idMatch) throw new Error('Could not parse tweet ID');
        return {
            id: idMatch[1],
            idNum: BigInt(idMatch[1]),
            url: (item.link || '').replace(base, 'https://x.com'),
            title: (item.title || '').slice(0, 200),
            author: data?.rss?.channel?.title,
            thumbnail: null,
            timestamp: item.pubDate,
            source: base,
        };
    }));

    const successes = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    if (!successes.length) {
        const errs = results.map((r, i) => `${instances[i]}: ${r.reason?.message || 'unknown error'}`).join('; ');
        throw new Error(`All Nitter instances failed (${errs})`);
    }

    // Pick the result with the highest (newest) tweet ID — Twitter snowflake
    // IDs are monotonically increasing over time.
    successes.sort((a, b) => (b.idNum > a.idNum ? 1 : b.idNum < a.idNum ? -1 : 0));
    const best = successes[0];
    delete best.idNum;
    delete best.source;
    return best;
}

module.exports = { fetchLatestTwitter };
