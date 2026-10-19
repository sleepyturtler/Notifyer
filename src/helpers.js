// Small pure helpers: embed builder E, handle normalization, profile URLs and the can-batch check.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { EmbedBuilder } = require('discord.js');
const { PLATFORM_NOTIFY_TYPES, activeTypeIds } = require('./config.js');

// ── Helpers ────────────────────────────────────────────────────────────────
const E = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();

function normalizeHandle(platform, raw) {
    let h = raw.trim();
    // Strip full URLs down to the handle/channel identifier
    h = h.replace(/^https?:\/\/(www\.)?/i, '');
    if (platform === 'youtube') {
        h = h.replace(/^(youtube\.com|m\.youtube\.com|youtu\.be)\//i, '');
        h = h.replace(/[?#].*$/, '').replace(/^channel\//i, ''); // /channel/UC... URLs and ?si=... tracking params
        h = h.replace(/\/(videos|featured|streams|shorts).*$/i, '');
        h = h.replace(/\/$/, '');
    } else if (platform === 'twitter') {
        h = h.replace(/^(twitter\.com|x\.com)\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'rss') {
        // The handle IS the feed URL. Keep path/query case; reject anything that isn't a plain http(s) URL.
        h = raw.trim(); // the generic scheme/www stripping above would change the feed's real address
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) h = 'https://' + h;
        try {
            const u = new URL(h);
            if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return '';
            u.hash = '';
            h = u.toString();
        } catch { return ''; }
        if (h.length > 300) return '';
    } else if (platform === 'bluesky') {
        h = h.replace(/^bsky\.app\/profile\//i, '').replace(/^@/, '');
        h = h.split(/[/?#]/)[0].toLowerCase();
        // "alice" alone is almost always alice.bsky.social; DIDs and custom domains pass through.
        if (h && !h.includes('.') && !h.startsWith('did:')) h += '.bsky.social';
    } else if (platform === 'twitch') {
        h = h.replace(/^twitch\.tv\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0].toLowerCase();
    } else if (platform === 'kick') {
        h = h.replace(/^kick\.com\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0].toLowerCase();
    } else if (platform === 'instagram') {
        h = h.replace(/^(instagram\.com)\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    } else if (platform === 'tiktok') {
        h = h.replace(/^(tiktok\.com)\/@?/i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
    }
    return h;
}

function profileUrl(platform, handle) {
    switch (platform) {
        case 'youtube': return handle.startsWith('@') ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/channel/${handle}`;
        case 'twitter': return `https://x.com/${handle}`;
        case 'rss': return handle;
        case 'bluesky': return `https://bsky.app/profile/${handle}`;
        case 'twitch': return `https://www.twitch.tv/${handle}`;
        case 'kick': return `https://kick.com/${handle}`;
        case 'instagram': return `https://www.instagram.com/${handle}`;
        case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    }
}

// A watch can only ever contribute to a batch if at least one of its active
// notify types isn't "live" — live events always send individually (see
// pollAll), so a Kick watch (live-only) or a YouTube watch restricted to just
// Live can never actually batch, regardless of platform. Shared by the manage
// view and the guided add-flow's post-setup batch-header step.
function canWatchBatch(w) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const nonLiveTypes = types.filter(t => t.id !== 'live');
    return nonLiveTypes.length > 0 && activeTypeIds(w).some(id => id !== 'live');
}

// A short readable label for a feed URL when its title isn't known: host plus a trimmed path, generic feed
// filenames dropped. https://www.theverge.com/rss/index.xml -> theverge.com, reddit.com/r/node/.rss -> reddit.com/r/node
function shortFeedLabel(url) {
    try {
        const u = new URL(url);
        let p = u.pathname.replace(/\/+$/, '');
        for (let i = 0; i < 4; i++) {
            const next = p.replace(/\/?\.(rss|atom|xml)$/i, '').replace(/\/(feed|feeds|rss|atom|index)(\.(xml|rss|atom))?$/i, '').replace(/\.(xml|rss|atom)$/i, '');
            if (next === p) break;
            p = next;
        }
        const label = u.hostname.replace(/^www\./i, '') + (p && p !== '/' ? p : '');
        return label.length > 40 ? label.slice(0, 39) + '…' : label;
    } catch { return String(url).slice(0, 40); }
}

// What to show for a watch wherever the handle used to be: the handle itself, except RSS, whose handle is the full feed
// URL. RSS shows the feed's own title (saved from the feed), or a short form of the URL until it is known. Cleaned so a
// feed title can't inject markdown or mentions.
function watchName(w) {
    if (w.platform !== 'rss') return w.handle;
    const raw = (w.display_name && String(w.display_name).trim()) || shortFeedLabel(w.handle);
    const clean = raw.replace(/[*`~|>\\\[\]]/g, '').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim();
    const out = clean.length > 40 ? clean.slice(0, 39).trimEnd() + '…' : clean;
    return out || shortFeedLabel(w.handle);
}

module.exports = { E, canWatchBatch, normalizeHandle, profileUrl, shortFeedLabel, watchName };
