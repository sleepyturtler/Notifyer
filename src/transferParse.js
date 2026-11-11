// Reads what ANOTHER notification bot posted and works out the Notifyer watch it corresponds to: which platform and
// account, what type of post, the message text (with the name, title and link swapped for placeholders), the embed
// color/look and the ping role. Pure functions only (no Discord, no database, no network), so it can be tested on its own.
// transfer.js turns a discord.js message into the plain "snapshot" these functions take, and does everything that needs I/O.
//
// Snapshot shape:
//   {
//     content: string,
//     embeds:  [{ type, color, title, description, url, author: { name, url } | null, image, thumbnail, fields: [{ name, value }] }],
//     buttons: [{ label, url }],                         link buttons, wherever they sit in the components
//     v2:      null | { accent, topTexts: [], texts: [], hasGallery, hasThumb },   a Components V2 ("card") message
//     suppressed: boolean,                               the message has its link previews turned off
//   }

'use strict';

const URL_RE = /https?:\/\/[^\s<>"'`|*()[\]]+/gi;
const ROLE_RE = /<@&(\d{5,25})>/g;
const lower = s => String(s ?? '').toLowerCase();
const urlsIn = text => (String(text ?? '').match(URL_RE) || []).map(u => u.replace(/[.,;:!?]+$/, ''));
const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };

// ── Links ─────────────────────────────────────────────────────────────────────
const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const TWITTER_HOSTS = new Set(['twitter.com', 'mobile.twitter.com', 'x.com', 'fxtwitter.com', 'vxtwitter.com', 'fixupx.com', 'fixvx.com', 'twittpr.com']);
const TWITCH_HOSTS = new Set(['twitch.tv', 'm.twitch.tv']);
const KICK_HOSTS = new Set(['kick.com']);
const BLUESKY_HOSTS = new Set(['bsky.app']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'ddinstagram.com', 'instagramez.com', 'kkinstagram.com']);
const TIKTOK_HOSTS = new Set(['tiktok.com', 'tnktok.com', 'vxtiktok.com', 'tfxktok.com']);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);

const TWITTER_RESERVED = new Set(['i', 'home', 'search', 'explore', 'intent', 'share', 'hashtag', 'settings', 'messages', 'notifications', 'compose', 'login', 'tos', 'privacy']);
const TWITCH_RESERVED = new Set(['videos', 'directory', 'downloads', 'p', 'settings', 'subscriptions', 'turbo', 'wallet', 'jobs', 'store', 'friends', 'inventory', 'drops', 'moderator', 'popout', 'embed', 'search', 'u', 'prime', 'bits', 'team', 'login', 'signup']);
const KICK_RESERVED = new Set(['video', 'videos', 'categories', 'category', 'clips', 'search', 'dashboard', 'following', 'browse', 'terms-of-service', 'privacy-policy', 'community-guidelines', 'api', 'emotes']);
const INSTAGRAM_RESERVED = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'direct', 'about', 'legal', 'developer', 'challenge', 'web']);

const TWITTER_NAME = /^\w{1,15}$/;
const TWITCH_NAME = /^[A-Za-z0-9_]{3,25}$/;
const KICK_NAME = /^[\w-]{3,25}$/;
const INSTAGRAM_NAME = /^[A-Za-z0-9._]{1,30}$/;

// One link -> { platform, kind: 'profile' | 'post', handle, postType, id, url } or null when it is not a link Notifyer can use.
// handle is null when the link points at a post that does not say whose it is (a YouTube video, an Instagram post, a TikTok short link):
// transfer.js resolves those (oEmbed) afterwards. postType is the Notifyer notify type that kind of link stands for.
function classifyUrl(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    const host = lower(u.hostname).replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean).map(safeDecode);
    const base = { url: raw, handle: null, id: null, postType: null };

    if (YOUTUBE_HOSTS.has(host)) {
        if (host === 'youtu.be') return parts[0] ? { ...base, platform: 'youtube', kind: 'post', id: parts[0], postType: 'videos' } : null;
        const [a, b] = parts;
        if (a && a.startsWith('@') && a.length > 1) return { ...base, platform: 'youtube', kind: 'profile', handle: a };
        if (a === 'channel' && /^UC[\w-]{22}$/.test(b || '')) return { ...base, platform: 'youtube', kind: 'profile', handle: b };
        if (a === 'shorts' && b) return { ...base, platform: 'youtube', kind: 'post', id: b, postType: 'shorts' };
        if (a === 'live' && b) return { ...base, platform: 'youtube', kind: 'post', id: b, postType: 'live' };
        if (a === 'watch' && u.searchParams.get('v')) return { ...base, platform: 'youtube', kind: 'post', id: u.searchParams.get('v'), postType: 'videos' };
        return null;
    }
    if (TWITTER_HOSTS.has(host)) {
        const [a, b, c] = parts;
        if (a === 'i' && (b === 'status' || (b === 'web' && parts[2] === 'status'))) return { ...base, platform: 'twitter', kind: 'post', postType: 'posts', id: parts[b === 'web' ? 3 : 2] || null };
        if (!a || TWITTER_RESERVED.has(lower(a)) || !TWITTER_NAME.test(a)) return null;
        if (b === 'status' && c) return { ...base, platform: 'twitter', kind: 'post', handle: a, id: c, postType: 'posts' };
        return { ...base, platform: 'twitter', kind: 'profile', handle: a };
    }
    if (TWITCH_HOSTS.has(host)) {
        const [a, b] = parts;
        if (a === 'videos' && b) return { ...base, platform: 'twitch', kind: 'post', id: b, postType: 'vods' };
        if (!a || TWITCH_RESERVED.has(lower(a)) || !TWITCH_NAME.test(a)) return null;
        if (b === 'videos') return { ...base, platform: 'twitch', kind: 'profile', handle: lower(a), postType: 'vods' };
        return { ...base, platform: 'twitch', kind: 'profile', handle: lower(a), postType: 'live' };
    }
    if (KICK_HOSTS.has(host)) {
        const [a] = parts;
        if (!a || KICK_RESERVED.has(lower(a)) || !KICK_NAME.test(a)) return null;
        return { ...base, platform: 'kick', kind: 'profile', handle: lower(a), postType: 'live' };
    }
    if (BLUESKY_HOSTS.has(host)) {
        const [a, b, c, d] = parts;
        if (a !== 'profile' || !b) return null;
        if (c === 'post' && d) return { ...base, platform: 'bluesky', kind: 'post', handle: lower(b), id: d, postType: 'posts' };
        return { ...base, platform: 'bluesky', kind: 'profile', handle: lower(b) };
    }
    if (INSTAGRAM_HOSTS.has(host)) {
        const [a, b, c] = parts;
        if (a === 'p' && b) return { ...base, platform: 'instagram', kind: 'post', id: b, postType: 'posts' };
        if ((a === 'reel' || a === 'reels') && b) return { ...base, platform: 'instagram', kind: 'post', id: b, postType: 'reels' };
        if (a === 'stories' && b && INSTAGRAM_NAME.test(b)) return { ...base, platform: 'instagram', kind: 'post', handle: b, id: c || null, postType: 'stories' };
        if (!a || INSTAGRAM_RESERVED.has(lower(a)) || !INSTAGRAM_NAME.test(a)) return null;
        if ((b === 'p' || b === 'reel') && c) return { ...base, platform: 'instagram', kind: 'post', handle: a, id: c, postType: b === 'p' ? 'posts' : 'reels' };
        return { ...base, platform: 'instagram', kind: 'profile', handle: a };
    }
    if (TIKTOK_SHORT_HOSTS.has(host)) return parts[0] ? { ...base, platform: 'tiktok', kind: 'post', id: parts[0], postType: 'videos' } : null;
    if (TIKTOK_HOSTS.has(host)) {
        const [a, b, c] = parts;
        if (a && a.startsWith('@') && a.length > 1) {
            if ((b === 'video' || b === 'photo') && c) return { ...base, platform: 'tiktok', kind: 'post', handle: a.slice(1), id: c, postType: 'videos' };
            return { ...base, platform: 'tiktok', kind: 'profile', handle: a.slice(1) };
        }
        if (a === 't' && b) return { ...base, platform: 'tiktok', kind: 'post', id: b, postType: 'videos' };
    }
    return null;
}

// Every link in the message, most trustworthy first. The "primary" ones are what the message is about (the embed's author and
// own link, link buttons, the text); links inside an embed's description or fields come second, since a description often
// links somewhere else entirely (a creator's Twitter in a YouTube video's description, say).
function collectUrls(snap) {
    const primary = [], secondary = [];
    const add = (list, u) => { if (u && !primary.includes(u) && !secondary.includes(u)) list.push(u); };
    for (const e of snap.embeds || []) add(primary, e.author?.url);
    for (const e of snap.embeds || []) add(primary, e.url);
    for (const b of snap.buttons || []) add(primary, b.url);
    urlsIn(snap.content).forEach(u => add(primary, u));
    for (const t of snap.v2?.topTexts || []) urlsIn(t).forEach(u => add(primary, u));
    for (const e of snap.embeds || []) for (const t of [e.title, e.description, ...(e.fields || []).map(f => f.value)]) urlsIn(t).forEach(u => add(secondary, u));
    for (const t of snap.v2?.texts || []) urlsIn(t).forEach(u => add(secondary, u));
    return { primary, secondary };
}

const LIVE_HINT = /🔴|\b(?:is|went|now|currently)\s+live\b|\blive\s+now\b|\bstreaming\b/i;
function liveHint(snap) {
    const rich = (snap.embeds || []).filter(isRich);
    return LIVE_HINT.test([snap.content, ...(snap.v2?.topTexts || []), ...rich.map(e => e.title)].filter(Boolean).join('\n'));
}

// Bot-drawn embeds are 'rich'; the others (video, link, image, article, gifv) are Discord's own previews of a link.
const isRich = e => !e.type || e.type === 'rich';

// Which account and kind of post is this message about?
//   -> null when there is no link Notifyer understands
//   -> { platform, handle, postType, resolve, nameHint }
// `resolve` (when handle is null) is the post link that still has to be looked up to find out whose it is.
function identify(snap) {
    const { primary, secondary } = collectUrls(snap);
    let cands = primary.map(classifyUrl).filter(Boolean);
    if (!cands.length) cands = secondary.map(classifyUrl).filter(Boolean);
    if (!cands.length) return null;
    const platform = cands[0].platform;
    const same = cands.filter(c => c.platform === platform);
    const withHandle = same.find(c => c.handle);
    const postCand = same.find(c => c.kind === 'post');
    let postType = postCand?.postType || same.find(c => c.postType)?.postType || null;
    if (platform === 'youtube' && (!postType || postType === 'videos') && liveHint(snap)) postType = 'live';
    const nameHint = (snap.embeds || []).map(e => e.author?.name).find(Boolean) || null;
    return {
        platform, postType, nameHint,
        handle: withHandle ? withHandle.handle : null,
        resolve: withHandle ? null : (postCand || same[0]),
    };
}

// ── Message text -> template ──────────────────────────────────────────────────
const LEFT = '\uE000', RIGHT = '\uE001';

// ctx: { platform, label, handle, authorName, title }. Returns the template, or null when nothing worth copying is left.
// The creator's name, the post's title and the link become {author} {title} {url}; the platform's name becomes {platform}.
function buildTemplate(snap, ctx) {
    let text = snap.content || (snap.v2?.topTexts || []).join('\n') || '';
    if (!text.trim()) return null;
    text = text.replace(ROLE_RE, '').replace(/[ \t]+\n/g, '\n');

    const slots = [];
    const slot = (token, pattern, flags = 'giu') => { // swap matches for a private-use marker so later swaps can't match inside this one
        text = text.replace(new RegExp(pattern, flags), () => { slots.push(token); return `${LEFT}${slots.length - 1}${RIGHT}`; });
    };
    const word = s => `(?<![\\p{L}\\p{N}_])${esc(s)}(?![\\p{L}\\p{N}_])`;

    // the link: any link in the text that is for this platform
    text = text.replace(URL_RE, m => {
        const raw = m.replace(/[.,;:!?]+$/, '');
        const c = classifyUrl(raw);
        if (!c || c.platform !== ctx.platform) return m;
        slots.push('{url}');
        return `${LEFT}${slots.length - 1}${RIGHT}${m.slice(raw.length)}`;
    });
    if (ctx.title && String(ctx.title).trim().length >= 6) slot('{title}', esc(String(ctx.title).trim()), 'giu');
    if (ctx.authorName && String(ctx.authorName).trim().length >= 2) slot('{author}', word(String(ctx.authorName).trim()));
    if (ctx.handle) {
        const h = String(ctx.handle).replace(/^@/, '');
        if (h.length >= 2) slot('{handle}', `@?${word(h)}`);
    }
    if (ctx.label && ctx.label !== 'Twitter/X') slot('{platform}', word(ctx.label));
    if (ctx.platform === 'twitter') slot('{platform}', word('Twitter/X'));
    if (ctx.postType === 'live') text = text.replace(/\b(is|was)\s+(?:now\s+)?live\b/gi, (_, w) => `${LEFT}${slots.push('{is/was} live') - 1}${RIGHT}`);

    text = text.replace(new RegExp(`${LEFT}(\\d+)${RIGHT}`, 'g'), (_, i) => slots[Number(i)]).trim();
    if (!text) return null;

    // What is left besides placeholders and links must be short boilerplate. Long free text is the post itself
    // (a tweet, a description) and would be repeated word for word on every future notification.
    const leftover = text.replace(/\{[^}]+\}/g, '').replace(URL_RE, '').replace(/[\p{Extended_Pictographic}\p{P}\p{S}\s]+/gu, ' ').trim();
    if (leftover.length > 200) return null;
    if (!/\{[^}]+\}/.test(text) && !leftover) return null; // only emoji/punctuation
    return text.slice(0, 1800);
}

// A template is only trusted when the exact same text (after the placeholders) has been seen more than once, or there is too
// little to compare: a text that appears once among several messages almost certainly contains that one post's own words.
// `stats` is a Map of "platform:type" -> Map(template -> count) that the caller fills with voteTemplate().
function voteTemplate(stats, key, tpl) {
    if (!tpl) return;
    if (!stats.has(key)) stats.set(key, new Map());
    const m = stats.get(key);
    m.set(tpl, (m.get(tpl) || 0) + 1);
}
function unvoteTemplate(stats, key, tpl) {
    const m = stats.get(key);
    if (!tpl || !m || !m.has(tpl)) return;
    if (m.get(tpl) <= 1) m.delete(tpl); else m.set(tpl, m.get(tpl) - 1);
}
function trustedTemplate(stats, key, tpl) {
    if (!tpl) return null;
    const m = stats.get(key);
    if (!m) return tpl;
    let total = 0, best = null, bestN = 0;
    for (const [t, n] of m) { total += n; if (n > bestN) { best = t; bestN = n; } }
    if ((m.get(tpl) || 0) >= 2 || total < 3) return tpl;
    return bestN >= 2 ? best : null;
}

// ── Look ──────────────────────────────────────────────────────────────────────
const toHex = n => '#' + (Number(n) & 0xFFFFFF).toString(16).padStart(6, '0');

// info: { defaultColor: '#rrggbb', native: boolean } for the platform. Only things that differ from Notifyer's defaults are returned,
// the same way the customizer stores them (so a watch that looks like the default keeps no settings at all).
function captureLook(snap, info) {
    const look = {};
    const rich = (snap.embeds || []).filter(isRich);
    const setColor = n => {
        if (n === null || n === undefined) return;
        const hex = toHex(n);
        if (hex.toLowerCase() !== lower(info.defaultColor)) look.color = hex;
    };
    if (snap.v2) {
        if (info.native) look.style = 'card'; // YouTube/TikTok default to Discord's own player preview; a card is the only drawn alternative
        setColor(snap.v2.accent);
        if (!snap.v2.hasGallery) look.image = snap.v2.hasThumb ? 'small' : 'none';
    } else if (rich.length) {
        look.style = info.native ? 'card' : 'embed'; // a native-video platform's own look is Discord's preview, so a drawn embed there is a card
        setColor(rich[0].color);
        if (!rich[0].image) look.image = rich[0].thumbnail ? 'small' : 'none';
    } else if (snap.suppressed) {
        look.embed = false;
    }
    return look;
}

const rolesIn = snap => {
    const found = new Set();
    for (const t of [snap.content, ...(snap.v2?.topTexts || [])]) for (const m of String(t || '').matchAll(ROLE_RE)) found.add(m[1]);
    return [...found];
};
const pingsEveryone = snap => /(^|\s)@(everyone|here)\b/.test([snap.content, ...(snap.v2?.topTexts || [])].join('\n'));

// Everything a message says about how its watch should look, given the identity transfer.js settled on.
// info: { label, defaultColor, native }. Returns { template, look, roleIds, pingsEveryone }.
function describe(snap, ident, info) {
    const rich = (snap.embeds || []).filter(isRich);
    const any = snap.embeds || [];
    const title = (rich.find(e => e.title) || any.find(e => e.title))?.title || null;
    return {
        template: buildTemplate(snap, { platform: ident.platform, label: info.label, handle: ident.handle, authorName: ident.nameHint, title, postType: ident.postType }),
        look: captureLook(snap, info),
        roleIds: rolesIn(snap),
        pingsEveryone: pingsEveryone(snap),
    };
}

module.exports = { buildTemplate, captureLook, classifyUrl, collectUrls, describe, identify, trustedTemplate, unvoteTemplate, voteTemplate };
