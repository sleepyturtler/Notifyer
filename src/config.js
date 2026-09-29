// Env-derived constants, platform definitions, notify-type tables, poll cadences, startup config summary.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const crypto = require('crypto');

// ── OAuth config (Instagram / TikTok) ───────────────────────────────────────
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

const LEGAL_BASE_URL = PUBLIC_BASE_URL || 'https://your-app.onrender.com';

// NITTER_INSTANCES: Nitter mirrors for Twitter/X (no free official API exists).
const NITTER_INSTANCES = (process.env.NITTER_INSTANCES
    ? process.env.NITTER_INSTANCES.split(',').map(s => s.trim()).filter(Boolean)
    : [
        'https://nitter.jaydenha.uk',
        'https://nitter.kareem.one',
        'https://nitter.meowing.monster',
        'https://shitter.thepixora.com',
        'https://nitter.xitter.cc',
        'https://x.n0g.xyz',
    ]);

// YouTube Data API v3 — replaces scraping youtube.com for uploads/Shorts/live
// detection. Requires an API key from console.cloud.google.com (enable "YouTube
// Data API v3", create an API key). Free quota is 10,000 units/day; this bot's
// usage (1 unit per channel per poll, plus a couple units when something new is
// actually found) stays well within that even for a good number of channels.
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// WebSub (PubSubHubbub) lets YouTube push new-video/live-start notifications to
// us instantly instead of waiting for the next poll, at zero API quota cost.
// This token is generated fresh per process start and only needs to match
// between our own subscribe call and our own callback verification — it's not
// meant to be a long-lived secret.
const WEBSUB_VERIFY_TOKEN = crypto.randomBytes(16).toString('hex');

const WEBSUB_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

// Cutoff for permanently retiring the old single-message-template system.
const LEGACY_MIGRATION_DATE = new Date('2026-10-01T00:00:00Z');

const LEGACY_MIGRATION_TS = Math.floor(LEGACY_MIGRATION_DATE.getTime() / 1000);

const OAUTH_CONFIG = {
    instagram: {
        clientId: process.env.INSTAGRAM_APP_ID,
        clientSecret: process.env.INSTAGRAM_APP_SECRET,
        redirectUri: `${PUBLIC_BASE_URL}/oauth/instagram/callback`,
        authUrl: 'https://www.instagram.com/oauth/authorize',
        scope: 'instagram_business_basic',
        clientIdParam: 'client_id', // standard OAuth naming
    },
    tiktok: {
        clientId: process.env.TIKTOK_CLIENT_KEY,
        clientSecret: process.env.TIKTOK_CLIENT_SECRET,
        redirectUri: `${PUBLIC_BASE_URL}/oauth/tiktok/callback`,
        authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
        // user.info.basic only grants display_name (the shown nickname) — the actual
        // unique @username requires user.info.profile specifically.
        scope: 'user.info.basic,user.info.profile,video.list',
        // TikTok deviates from standard OAuth naming: the authorize endpoint expects
        // "client_key", not "client_id" — sending the wrong param name here produces
        // errCode 10003 / error_type=client_key even with a correct, valid key.
        clientIdParam: 'client_key',
    },
};

const PLATFORMS = {
    youtube:   { label: 'YouTube',   emoji: '📺', color: '#FF0000' },
    // Twitter/X was reopened to everyone after the owner-only mirror-reliability
    // testing period confirmed the recovered Nitter mirrors (see NITTER_INSTANCES)
    // hold up consistently.
    twitter:   { label: 'Twitter/X', emoji: '🐦', color: '#1DA1F2' },
    twitch:    { label: 'Twitch',    emoji: '🟣', color: '#9146FF' },
    kick:      { label: 'Kick',      emoji: '🟢', color: '#53FC18' },
    instagram: { label: 'Instagram', emoji: '📸', color: '#E1306C', oauth: true },
    tiktok:    { label: 'TikTok',    emoji: '🎵', color: '#010101', oauth: true },
};

function isOwner(userId) {
    const ownerId = process.env.BOT_OWNER_ID;
    return Boolean(ownerId && userId === ownerId);
}

// Custom (application) emoji support via EMOJI_<PLATFORM> env vars — optional,
// falls back to the plain Unicode emoji above if unset.
// p.emojiTag    → for embed/text display, e.g. `${p.emojiTag} ${p.label}`
// p.emojiButton → for ButtonBuilder.setEmoji(p.emojiButton)
const EMOJI_TAG_RE = /^<a?:(\w+):(\d+)>$/;

for (const [key, p] of Object.entries(PLATFORMS)) {
    const tagMatch = (process.env[`EMOJI_${key.toUpperCase()}`] || '').match(EMOJI_TAG_RE);
    const id = tagMatch?.[2] || process.env[`EMOJI_${key.toUpperCase()}_ID`];
    const name = tagMatch?.[1] || process.env[`EMOJI_${key.toUpperCase()}_NAME`] || key;
    p.emojiTag = id ? `<:${name}:${id}>` : p.emoji;
    p.emojiButton = id ? { id, name } : p.emoji;
}

// Notification types per platform. Each watch stores a subset of these in `notify_types` (JSONB array).
// If null/empty, all types fire (default behaviour / backwards compat).
const PLATFORM_NOTIFY_TYPES = {
    youtube:   [
        { id: 'videos', label: 'Videos',  description: 'Regular uploads (long-form)' },
        { id: 'shorts', label: 'Shorts',  description: 'YouTube Shorts' },
        { id: 'live',   label: 'Live',    description: 'Stream goes live' },
    ],
    twitter:   [{ id: 'posts', label: 'Posts', description: 'New tweets/posts' }],
    twitch:    [
        { id: 'live',   label: 'Live',   description: 'Stream goes live' },
        { id: 'vods',   label: 'VODs',   description: 'New VOD/past broadcast uploaded' },
    ],
    // Kick's official public API currently only exposes live status — no VOD/clip
    // listing endpoint yet, so this platform launches with just one notify type.
    kick:      [{ id: 'live', label: 'Live', description: 'Stream goes live' }],
    instagram: [
        { id: 'posts',   label: 'Posts',   description: 'Feed photos/videos' },
        { id: 'reels',   label: 'Reels',   description: 'Reels' },
        { id: 'stories', label: 'Stories', description: 'Stories (24h, if available)' },
    ],
    tiktok:    [{ id: 'videos', label: 'Videos', description: 'New TikTok videos' }],
};

// Two poll cadences instead of one uniform interval:
//  - "Fast" platforms are all backed by official, generously-rate-limited APIs
//    (TikTok's video.list/query and Instagram's oauth Graph API both allow 600+
//    req/min; Twitch Helix and Kick's API are similarly generous) — nothing stops
//    us from checking these often, so we poll them close to real-time.
//  - "Slow" platforms stay on a conservative cadence for other reasons: YouTube
//    is on the official Data API v3 now (see fetchLatestYouTubeEntries), but
//    routine polling still costs quota per check, so 2-minute polling keeps
//    quota usage low — WebSub covers near-instant live/upload detection
//    separately. Twitter/X still has no official free API and goes through
//    Nitter scraping, which does need the gentler pace to avoid getting blocked.
const FAST_POLL_INTERVAL_MS = 20 * 1000; // 20 seconds

const SLOW_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

const FAST_POLL_PLATFORMS = new Set(['tiktok', 'instagram', 'twitch', 'kick']);

const SLOW_POLL_PLATFORMS = new Set(['youtube', 'twitter']);

const SUPPORT_SERVER_URL = 'https://discord.gg/CmNjecb82Y';

const SEEN_HISTORY_SIZE = 20;

// ── Startup config summary ──────────────────────────────────────────────────
// Logged once per boot so a self-hoster (or anyone reading logs after a
// redeploy) can see at a glance which integrations are actually active,
// instead of only discovering a missing credential the first time someone
// tries to use that platform and it quietly does nothing.
function logStartupConfigSummary() {
    const lines = [];
    const ok = (label) => lines.push(`   ✅ ${label}`);
    const off = (label, why) => lines.push(`   ⚠️  ${label} — disabled (${why})`);

    if (process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) ok('Twitch');
    else off('Twitch', 'missing TWITCH_CLIENT_ID/TWITCH_CLIENT_SECRET');

    if (process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET) ok('Kick');
    else off('Kick', 'missing KICK_CLIENT_ID/KICK_CLIENT_SECRET');

    if (process.env.YOUTUBE_API_KEY) ok('YouTube');
    else off('YouTube', 'missing YOUTUBE_API_KEY');

    ok(`Twitter/X (via Nitter, ${NITTER_INSTANCES.length} mirror(s) configured)`);

    if (process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET) {
        if (PUBLIC_BASE_URL) ok('Instagram');
        else off('Instagram', 'INSTAGRAM_APP_ID/SECRET set, but PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) is missing — OAuth has nowhere to send the callback');
    } else off('Instagram', 'missing INSTAGRAM_APP_ID/INSTAGRAM_APP_SECRET');

    if (process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) {
        if (PUBLIC_BASE_URL) ok('TikTok');
        else off('TikTok', 'TIKTOK_CLIENT_KEY/SECRET set, but PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) is missing — OAuth has nowhere to send the callback');
    } else off('TikTok', 'missing TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET');

    if (!PUBLIC_BASE_URL) lines.push('   ⚠️  YouTube WebSub push notifications also need PUBLIC_BASE_URL — falling back to polling-only for YouTube.');
    if (!process.env.BOT_OWNER_ID) lines.push('   ⚠️  BOT_OWNER_ID not set — /social debug, /social oauthdebug, and /killbot are unreachable by anyone.');

    console.log(`⚙️  Startup config summary:\n${lines.join('\n')}`);
}

module.exports = { FAST_POLL_INTERVAL_MS, FAST_POLL_PLATFORMS, LEGACY_MIGRATION_TS, LEGAL_BASE_URL, NITTER_INSTANCES, OAUTH_CONFIG, PLATFORMS, PLATFORM_NOTIFY_TYPES, PUBLIC_BASE_URL, SEEN_HISTORY_SIZE, SLOW_POLL_INTERVAL_MS, SLOW_POLL_PLATFORMS, SUPPORT_SERVER_URL, WEBSUB_HUB_URL, WEBSUB_VERIFY_TOKEN, YOUTUBE_API_KEY, isOwner, logStartupConfigSummary };
