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
        'https://nitter.netbub.com',
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

// Per-channel secret for signing/verifying WebSub pushes (HMAC of the channel ID). Derived
// from a server-side secret instead of random-per-boot because subscriptions outlive restarts
// (the hub signs pushes with the secret given at subscribe time). Set WEBSUB_SECRET to use a
// dedicated value; otherwise it falls back to DISCORD_TOKEN, which is never sent anywhere.
const websubSecretFor = channelId => crypto
    .createHmac('sha256', process.env.WEBSUB_SECRET || process.env.DISCORD_TOKEN || 'notifyer-websub')
    .update(`websub:${channelId}`).digest('hex');

const WEBSUB_HUB_URL = 'https://pubsubhubbub.appspot.com/subscribe';

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
    youtube:   { label: 'YouTube',   emoji: '📺', color: '#FF0000', unavailable: !process.env.YOUTUBE_API_KEY },
    // Twitter/X was reopened to everyone after the owner-only mirror-reliability
    // testing period confirmed the recovered Nitter mirrors (see NITTER_INSTANCES)
    // hold up consistently. Needs no credentials at all, so it's never
    // auto-disabled here the way the others below are.
    twitter:   { label: 'Twitter/X', emoji: '🐦', color: '#1DA1F2' },
    bluesky:   { label: 'Bluesky',   emoji: '🦋', color: '#1185FE' },
    // Arbitrary user-supplied feed URLs: owner-only (restricted) until RSS_PUBLIC=true.
    rss:       { label: 'RSS',       emoji: '📰', color: '#F26522', restricted: process.env.RSS_PUBLIC !== 'true' },
    twitch:    { label: 'Twitch',    emoji: '🟣', color: '#9146FF', unavailable: !(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET) },
    kick:      { label: 'Kick',      emoji: '🟢', color: '#53FC18', unavailable: !(process.env.KICK_CLIENT_ID && process.env.KICK_CLIENT_SECRET) },
    // Instagram/TikTok also need PUBLIC_BASE_URL — without it there's nowhere for
    // the OAuth callback to go, so credentials alone aren't enough to count as
    // "available" for these two.
    instagram: { label: 'Instagram', emoji: '📸', color: '#E1306C', oauth: true, unavailable: !(process.env.INSTAGRAM_APP_ID && process.env.INSTAGRAM_APP_SECRET && PUBLIC_BASE_URL) },
    tiktok:    { label: 'TikTok',    emoji: '🎵', color: '#010101', oauth: true, unavailable: !(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && PUBLIC_BASE_URL) },
};

// The notify types a watch fires for: its saved selection, else every type not marked defaultOff.
function activeTypeIds(w) {
    if (Array.isArray(w.notify_types) && w.notify_types.length) return w.notify_types;
    return (PLATFORM_NOTIFY_TYPES[w.platform] || []).filter(t => !t.defaultOff).map(t => t.id);
}

function isOwner(userId) {
    const ownerId = process.env.BOT_OWNER_ID;
    return Boolean(ownerId && userId === ownerId);
}

// The platforms a person can link right now: OAuth credentials set and a public address for the redirect.
function linkablePlatforms() {
    if (!PUBLIC_BASE_URL) return [];
    return ['instagram', 'tiktok'].filter(k => OAUTH_CONFIG[k]?.clientId && OAUTH_CONFIG[k]?.clientSecret);
}

// A linked account may be used from any server, so unlinking it (which pauses every server's watches) is limited to the
// person who linked it and the bot owner.
function canUnlinkLink(link, userId) {
    return Boolean(link) && ((Boolean(link.linked_by) && String(link.linked_by) === String(userId)) || isOwner(userId));
}

// Restricted platforms (RSS) can only be used by the bot owner.
function canUsePlatform(key, userId) {
    const p = PLATFORMS[key];
    return Boolean(p) && (!p.restricted || isOwner(userId));
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
    // Replies and reposts are opt-in (defaultOff): a watch with no saved selection only fires for posts.
    rss:       [{ id: 'posts', label: 'Posts', description: 'New feed items' }],
    bluesky:   [
        { id: 'posts',   label: 'Posts',   description: 'New posts' },
        { id: 'replies', label: 'Replies', description: 'Replies to other posts', defaultOff: true },
        { id: 'reposts', label: 'Reposts', description: 'Posts they reposted', defaultOff: true },
    ],
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

// While a YouTube channel's WebSub push is confirmed by the hub, polling is only a safety net, so it runs this
// often instead of every SLOW_POLL_INTERVAL_MS. Override with YOUTUBE_POLL_INTERVAL_MS (never below the slow interval).
const YOUTUBE_PUSH_POLL_INTERVAL_MS = Math.max(SLOW_POLL_INTERVAL_MS, parseInt(process.env.YOUTUBE_POLL_INTERVAL_MS, 10) || 20 * 60 * 1000);

// Some platforms adapt each watch's poll interval to how often the account posts (see rssPoll.js). A watch starts at the
// default, speeds up for busy accounts down to the min (the slow loop's tick, so it can't go lower), and slows to the max
// for quiet ones. Each can be overridden with <PREFIX>_POLL_DEFAULT_MS / _MIN_MS / _MAX_MS.
const envMs = (name, fallback) => { const n = parseInt(process.env[name], 10); return n > 0 ? n : fallback; };
function adaptiveBounds(prefix, defMs, maxMs) {
    const min = Math.max(SLOW_POLL_INTERVAL_MS, envMs(`${prefix}_POLL_MIN_MS`, SLOW_POLL_INTERVAL_MS));
    const max = Math.max(min, envMs(`${prefix}_POLL_MAX_MS`, maxMs));
    const def = Math.min(max, Math.max(min, envMs(`${prefix}_POLL_DEFAULT_MS`, defMs)));
    return { min, max, def };
}
const ADAPTIVE_POLL = {
    rss: adaptiveBounds('RSS', 10 * 60 * 1000, 60 * 60 * 1000),
    twitter: adaptiveBounds('TWITTER', 5 * 60 * 1000, 30 * 60 * 1000), // tweets are time-sensitive: slower cap, quicker default
};

const FAST_POLL_PLATFORMS = new Set(['tiktok', 'instagram', 'twitch', 'kick']);

const SLOW_POLL_PLATFORMS = new Set(['youtube', 'twitter', 'bluesky', 'rss']);

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

    ok('Bluesky (public API, no credentials needed)');
    ok(`RSS (${PLATFORMS.rss.restricted ? 'owner-only' : 'public'})`);
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

module.exports = { FAST_POLL_INTERVAL_MS, FAST_POLL_PLATFORMS, LEGAL_BASE_URL, NITTER_INSTANCES, OAUTH_CONFIG, PLATFORMS, PLATFORM_NOTIFY_TYPES, PUBLIC_BASE_URL, SEEN_HISTORY_SIZE, SLOW_POLL_INTERVAL_MS, SLOW_POLL_PLATFORMS, SUPPORT_SERVER_URL, WEBSUB_HUB_URL, WEBSUB_VERIFY_TOKEN, websubSecretFor, YOUTUBE_API_KEY, YOUTUBE_PUSH_POLL_INTERVAL_MS, ADAPTIVE_POLL, linkablePlatforms, canUnlinkLink, canUsePlatform, activeTypeIds, isOwner, logStartupConfigSummary };
