// Small pure helpers: embed builder E, handle normalization, profile URLs, legacy-format and can-batch checks.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { EmbedBuilder } = require('discord.js');
const { PLATFORM_NOTIFY_TYPES } = require('./config.js');

// ── Helpers ────────────────────────────────────────────────────────────────
const E = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();

function normalizeHandle(platform, raw) {
    let h = raw.trim();
    // Strip full URLs down to the handle/channel identifier
    h = h.replace(/^https?:\/\/(www\.)?/i, '');
    if (platform === 'youtube') {
        h = h.replace(/^(youtube\.com|m\.youtube\.com|youtu\.be)\//i, '');
        h = h.replace(/^@/, '@'); // keep @handle form if present
        h = h.replace(/\/(videos|featured|streams|shorts).*$/i, '');
        h = h.replace(/\/$/, '');
    } else if (platform === 'twitter') {
        h = h.replace(/^(twitter\.com|x\.com)\//i, '');
        h = h.replace(/^@/, '');
        h = h.split(/[/?]/)[0];
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
        case 'twitch': return `https://www.twitch.tv/${handle}`;
        case 'kick': return `https://kick.com/${handle}`;
        case 'instagram': return `https://www.instagram.com/${handle}`;
        case 'tiktok': return `https://www.tiktok.com/@${handle}`;
    }
}

// single message_template and haven't been reviewed/edited since.
function isLegacyMessageFormat(w) {
    return !!w.legacy_migrated;
}

// A watch can only ever contribute to a batch if at least one of its active
// notify types isn't "live" — live events always send individually (see
// pollAll), so a Kick watch (live-only) or a YouTube watch restricted to just
// Live can never actually batch, regardless of platform. Shared by the manage
// view and the guided add-flow's post-setup batch-header step.
function canWatchBatch(w) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const nonLiveTypes = types.filter(t => t.id !== 'live');
    const activeTypeIds = (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types : types.map(t => t.id);
    return nonLiveTypes.length > 0 && activeTypeIds.some(id => id !== 'live');
}

module.exports = { E, canWatchBatch, isLegacyMessageFormat, normalizeHandle, profileUrl };
