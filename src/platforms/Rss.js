// RSS 2.0, RSS 1.0 (RDF) and Atom feeds. The feed URL is user-supplied, so: fetched through safeFetch (public hosts
// only, 2 MB cap), feeds declaring XML entities are refused (entity-expansion bombs), and everything that ends up in
// an embed is stripped to plain text or validated as an http(s) URL.

const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const { safeFetchText } = require('../safeFetch.js');
const { LEGAL_BASE_URL } = require('../config.js');

const FEED_LIMIT = 20; // must not exceed SEEN_HISTORY_SIZE (config.js), or older items get re-announced
const SUMMARY_MAX = 300;
const USER_AGENT = process.env.RSS_USER_AGENT || `Mozilla/5.0 (compatible; Notifyer/2.0; +${LEGAL_BASE_URL})`;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, parseAttributeValue: false, trimValues: true });

const arr = v => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

// Text of a parsed node: plain string, or an object carrying #text (element with attributes).
function txt(v) {
    if (v === undefined || v === null) return '';
    if (Array.isArray(v)) return txt(v[0]);
    if (typeof v === 'object') return txt(v['#text']);
    return String(v).trim();
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
            const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : '';
        }
        return NAMED[e.toLowerCase()] ?? m;
    });
}

// HTML (or plain) text -> short plain text.
function toPlain(s, max) {
    let t = String(s || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]*>/g, '');
    t = decodeEntities(t).replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Absolute http(s) URL without credentials, or null. Relative values resolve against the feed's own address.
function safeHttpUrl(v, base) {
    const s = txt(v);
    if (!s || s.length > 2000) return null;
    try {
        const u = new URL(s, base);
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
        return u.toString();
    } catch { return null; }
}

function firstImageInHtml(html, base) {
    const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(String(html || ''));
    return m ? safeHttpUrl(decodeEntities(m[1]), base) : null;
}

function itemImage(it, base) {
    for (const enc of arr(it.enclosure)) {
        if (/^image\//i.test(enc?.['@_type'] || '')) { const u = safeHttpUrl(enc['@_url'], base); if (u) return u; }
    }
    for (const key of ['media:thumbnail', 'media:content']) {
        for (const m of arr(it[key])) {
            if (key === 'media:content' && m?.['@_medium'] && m['@_medium'] !== 'image') continue;
            if (key === 'media:content' && m?.['@_type'] && !/^image\//i.test(m['@_type'])) continue;
            const u = safeHttpUrl(m?.['@_url'], base); if (u) return u;
        }
    }
    return firstImageInHtml(txt(it['content:encoded']) || txt(it.description) || txt(it.content) || txt(it.summary), base);
}

function atomLink(it) {
    const links = arr(it.link).filter(l => l && typeof l === 'object');
    const pick = links.find(l => (l['@_rel'] || 'alternate') === 'alternate' && l['@_href']) || links.find(l => l['@_href']);
    return pick ? pick['@_href'] : txt(it.link);
}

function parseDate(...vals) {
    for (const v of vals) { const ms = Date.parse(txt(v)); if (Number.isFinite(ms)) return new Date(ms).toISOString(); }
    return null;
}

// Pure: feed XML -> { title, posts }. Throws if it isn't a recognisable feed.
function parseFeed(xml, feedUrl) {
    if (/<!ENTITY/i.test(xml)) throw new Error('Unsupported feed (entity declarations)');
    const clean = xml.replace(/<!DOCTYPE[^>]*>/i, '');
    let doc;
    try { doc = parser.parse(clean); } catch { throw new Error('That URL did not return a valid feed'); }

    let feedTitle = '', rawItems;
    if (doc?.rss?.channel) {
        const ch = arr(doc.rss.channel)[0];
        feedTitle = txt(ch.title); rawItems = arr(ch.item);
    } else if (doc?.['rdf:RDF']) {
        const r = doc['rdf:RDF'];
        feedTitle = txt(arr(r.channel)[0]?.title); rawItems = arr(r.item);
    } else if (doc?.feed) {
        feedTitle = txt(doc.feed.title); rawItems = arr(doc.feed.entry);
    } else {
        throw new Error('That URL did not return an RSS or Atom feed');
    }
    const site = feedTitle ? toPlain(feedTitle, 100) : '';

    const posts = [], seen = new Set();
    for (const it of rawItems) {
        if (!it || typeof it !== 'object') continue;
        const link = safeHttpUrl(it['@_rdf:about'] && !it.link ? it['@_rdf:about'] : (doc.feed ? atomLink(it) : it.link), feedUrl);
        const guid = txt(it.guid) || txt(it.id);
        const idSource = guid || link;
        if (!link || !idSource) continue;
        const id = crypto.createHash('sha1').update(idSource).digest('hex').slice(0, 20); // bounded size whatever the feed sends
        if (seen.has(id)) continue;
        seen.add(id);

        const title = toPlain(txt(it.title), 250);
        const body = toPlain(txt(it.description) || txt(it.summary) || txt(it['content:encoded']) || txt(it.content), SUMMARY_MAX);
        const authorRaw = txt(it['dc:creator']) || txt(it.author?.name ?? it.author);
        posts.push({
            id, url: link,
            title: title || body.split('\n')[0].slice(0, 120) || '(untitled)',
            summary: body && body !== title ? body : null,
            author: site || toPlain(authorRaw, 100) || null,
            thumbnail: itemImage(it, feedUrl),
            timestamp: parseDate(it.pubDate, it['dc:date'], it.published, it.updated),
            postType: 'posts',
        });
        if (posts.length >= FEED_LIMIT) break;
    }
    return { title: site, posts };
}

async function fetchLatestRssAll(feedUrl) {
    const res = await safeFetchText(feedUrl, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return parseFeed(res.text, feedUrl).posts;
}

module.exports = { fetchLatestRssAll, parseFeed };
