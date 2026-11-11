// RSS without hunting for the feed address: paste any link and the bot finds the feed.
//   1. a shorthand like reddit:node or github:owner/repo (rssPresets.js)
//   2. an address that already looks like a feed (ends in .xml, .rss, .atom or /feed, or under /feeds/): used as is, the normal add flow checks it
//   3. a page on a site whose feed address is known (a subreddit, a GitHub repo, a Substack, a PyPI project ...): no request needed
//   4. any other page: it is opened and its <link rel="alternate"> feed tag is used; failing that, the usual places (/feed, /rss ...)
// Every request goes through safeFetchText (public hosts only, redirects checked, small body cap), the same guard as a typed feed URL.

const { safeFetchText } = require('./safeFetch.js');
const { parseShorthand } = require('./rssPresets.js');

const USER_AGENT = process.env.RSS_USER_AGENT || 'NotifyerBot/1.0 (+feed discovery)';
const PAGE_BYTES = 1024 * 1024;
const COMMON_PATHS = ['/feed', '/rss', '/atom.xml', '/feed.xml', '/index.xml'];
const SKIP_GITHUB = new Set(['orgs', 'topics', 'marketplace', 'settings', 'sponsors', 'features', 'pricing', 'about', 'login', 'explore', 'collections', 'trending', 'search']);

// Pages whose feed address follows from the page address itself.
const KNOWN = [
    { re: /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/([A-Za-z0-9_]{2,21})(?:[/?#]|$)/i, url: m => `https://www.reddit.com/r/${m[1]}/.rss` },
    { re: /^https?:\/\/(?:www\.|old\.)?reddit\.com\/(?:user|u)\/([A-Za-z0-9_-]{3,20})(?:[/?#]|$)/i, url: m => `https://www.reddit.com/user/${m[1]}/.rss` },
    { re: /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#]|$)/i, url: m => (SKIP_GITHUB.has(m[1].toLowerCase()) ? null : `https://github.com/${m[1]}/${m[2]}/releases.atom`) },
    { re: /^https?:\/\/([a-z0-9-]{2,63})\.substack\.com(?:[/?#]|$)/i, url: m => (m[1].toLowerCase() === 'www' ? null : `https://${m[1].toLowerCase()}.substack.com/feed`) },
    { re: /^https?:\/\/(?:www\.)?medium\.com\/(@?[\w.-]{2,60})(?:[/?#]|$)/i, url: m => `https://medium.com/feed/${m[1]}` },
    { re: /^https?:\/\/pypi\.org\/project\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:[/?#]|$)/i, url: m => `https://pypi.org/rss/project/${m[1]}/releases.xml` },
    { re: /^https?:\/\/store\.steampowered\.com\/app\/(\d{1,9})(?:[/?#]|$)/i, url: m => `https://store.steampowered.com/feeds/news/app/${m[1]}/` },
];

const FEED_PATH_RE = /\.(?:xml|rss|atom)(?:[?#]|$)|\/(?:feed|rss|atom)\/?(?:[?#]|$)/i;
// An address that already is a feed (including the ones the presets build, e.g. .../commits.atom or medium.com/feed/@name): never rewritten.
const isFeedAddress = u => FEED_PATH_RE.test(u.pathname + u.search) || /^\/feeds?\//i.test(u.pathname) || u.hostname === 'hnrss.org';

// "reddit.com/r/node" (no scheme) is still a link.
function toUrl(input) {
    let s = String(input || '').trim();
    if (!s || /\s/.test(s)) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        if (!/^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(s)) return null;
        s = `https://${s}`;
    }
    try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; }
}

// The start of a feed document: RSS, Atom or RDF, and not an HTML page.
const looksLikeFeed = text => { const head = String(text || '').slice(0, 2000); return /<(?:rss|feed|rdf:RDF)\b/i.test(head) && !/<html\b/i.test(head); };

// The feed addresses a page advertises in its <head>, best first: RSS, then Atom, comment feeds last.
function feedLinks(html, baseUrl) {
    const found = [];
    for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
        const attrs = {};
        for (const m of tag.matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
        if (!/\balternate\b/i.test(attrs.rel || '') || !attrs.href) continue;
        const type = (attrs.type || '').toLowerCase();
        if (!/(?:rss|atom)\+xml|application\/(?:rss|atom)|^text\/xml$|^application\/xml$/.test(type)) continue;
        let url; try { url = new URL(attrs.href.replace(/&amp;/g, '&'), baseUrl).toString(); } catch { continue; }
        const rank = (/comment/i.test(`${attrs.title || ''} ${url}`) ? 4 : 0) + (/atom/.test(type) ? 1 : 0);
        found.push({ url, rank });
    }
    return found.sort((a, b) => a.rank - b.rank).map(f => f.url).filter((u, i, a) => a.indexOf(u) === i);
}

async function get(fetchPage, url) {
    return fetchPage(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html, application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' }, maxBytes: PAGE_BYTES, timeoutMs: 6000, maxMs: 10000 });
}

// -> { ok: true, url, via } or { ok: false, message }
async function discoverFeed(input, { fetchPage = safeFetchText } = {}) {
    const short = parseShorthand(input);
    if (short) return short.ok ? { ok: true, url: short.url, via: 'shorthand' } : { ok: false, message: short.message };
    const u = toUrl(input);
    if (!u) return { ok: false, message: '\u274c That does not look like a link. Paste a website or feed address, or a shorthand like `reddit:node`.' };
    const href = u.toString();
    if (isFeedAddress(u)) return { ok: true, url: href, via: 'feed' };
    for (const k of KNOWN) { const m = k.re.exec(href); const url = m && k.url(m); if (url) return { ok: true, url, via: 'known' }; }

    let page;
    try { page = await get(fetchPage, href); }
    catch (e) { return { ok: false, message: `\u274c Could not open that page: ${String(e.message || 'request failed').slice(0, 120)}` }; }
    if (page.status !== 200) return { ok: false, message: `\u274c Could not open that page (HTTP ${page.status}).` };
    if (looksLikeFeed(page.text)) return { ok: true, url: href, via: 'feed' };
    const linked = feedLinks(page.text, href)[0];
    if (linked) return { ok: true, url: linked, via: 'link' };

    // No feed tag: try the usual places, side by side, and take the first one (in this order) that really is a feed.
    const base = u.origin;
    const dir = u.pathname.replace(/\/+$/, '');
    const candidates = [...(dir ? COMMON_PATHS.slice(0, 2).map(p => `${base}${dir}${p}`) : []), ...COMMON_PATHS.map(p => `${base}${p}`)];
    const checked = await Promise.all(candidates.map(c => get(fetchPage, c).then(r => (r.status === 200 && looksLikeFeed(r.text) ? c : null), () => null)));
    const hit = checked.find(Boolean);
    if (hit) return { ok: true, url: hit, via: 'path' };
    return { ok: false, message: '\u274c Could not find a feed on that page. Try the feed address itself (often ending in /feed, /rss or .xml).' };
}

module.exports = { discoverFeed, feedLinks, looksLikeFeed, toUrl };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
