const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ChannelSelectMenuBuilder, RoleSelectMenuBuilder, ChannelType, ActivityType, MessageFlags, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ContainerBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder } = require('discord.js');
const { Pool } = require('pg');
const dns = require('dns');
const crypto = require('crypto');
const { URL } = require('url');
const http = require('http'), https = require('https');
const { XMLParser } = require('fast-xml-parser');

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
// In-memory pending OAuth states: state -> { guildId, userId, platform, expires }
// A Discord-side "link" always starts and finishes within a few minutes, so
// memory (rather than the DB) is fine here — if the process restarts mid-flow
// the user just runs /social link again.
const pendingOAuthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// /setup wizard: a select menu -> modal -> channel-select can't pass data through
// customId alone (handles may contain characters unsafe for it), so carry state
// between those steps keyed by guild+user, same short-lived pattern as OAuth state.
const pendingSetupPicks = new Map();
const SETUP_PICK_TTL_MS = 10 * 60 * 1000;

function createOAuthState(guildId, userId, platform) {
    const state = crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + OAUTH_STATE_TTL_MS;
    pendingOAuthStates.set(state, { guildId, userId, platform, expires });
    return { state, expires };
}
function consumeOAuthState(state) {
    const entry = pendingOAuthStates.get(state);
    if (!entry) return null;
    pendingOAuthStates.delete(state);
    if (entry.expires < Date.now()) return null;
    return entry;
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingOAuthStates) if (v.expires < now) pendingOAuthStates.delete(k);
}, 5 * 60 * 1000);

function postForm(urlStr, formData, extraHeaders = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formData).toString();
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}
function postJson(urlStr, bodyObj, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(bodyObj);
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}
function fetchJson(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.end();
    });
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let pool; // created in initDB() after resolving the DB host to IPv4
pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.on('error', e => console.error('⚠️ Postgres pool error:', e.message));

// Render's managed Postgres hostnames sometimes only resolve to IPv6 on the
// default resolver, which Render's network can't route (ENETUNREACH). Force
// an IPv4 lookup and rebuild the pool against the resolved IP if needed.
async function ensureIPv4Pool() {
    if (!process.env.DATABASE_URL) return;
    try {
        const url = new URL(process.env.DATABASE_URL);
        console.log(`🔍 DB host from DATABASE_URL: ${url.hostname}:${url.port || 5432}`);
        const { address } = await new Promise((resolve, reject) =>
            dns.lookup(url.hostname, { family: 4 }, (err, address, family) => err ? reject(err) : resolve({ address, family }))
        );
        if (address && address !== url.hostname) {
            const original = url.hostname;
            url.hostname = address;
            await pool.end().catch(() => {});
            pool = new Pool({
                connectionString: url.toString(),
                ssl: { rejectUnauthorized: false, servername: original }, // keep SNI/cert check against original hostname
            });
            pool.on('error', e => console.error('⚠️ Postgres pool error:', e.message));
            console.log(`🔧 Using IPv4 address ${address} for Postgres host ${original}`);
        }
    } catch (e) {
        console.error('⚠️ IPv4 DB lookup failed, using default resolver:', e.message);
    }
}
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

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
//  - "Slow" platforms are unofficial/scraped (YouTube's unofficial paths, Nitter
//    for Twitter/X) and need the conservative cadence to avoid getting blocked.
const FAST_POLL_INTERVAL_MS = 20 * 1000; // 20 seconds
const SLOW_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const FAST_POLL_PLATFORMS = new Set(['tiktok', 'instagram', 'twitch', 'kick']);
const SLOW_POLL_PLATFORMS = new Set(['youtube', 'twitter']);

// ── DB ─────────────────────────────────────────────────────────────────────
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS configs   (guild_id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS watches   (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            handle TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            message_template TEXT,
            last_post_id TEXT,
            last_checked BIGINT,
            added_by TEXT,
            added_at BIGINT
        );
        CREATE INDEX IF NOT EXISTS watches_guild ON watches(guild_id);
        CREATE INDEX IF NOT EXISTS watches_platform ON watches(platform);
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS role_id TEXT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS seen_post_ids JSONB NOT NULL DEFAULT '[]';
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS notify_types JSONB;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS message_templates JSONB;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS social_link_id INTEGER;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS legacy_migrated BOOLEAN NOT NULL DEFAULT FALSE;
        -- Tracks the Discord message ID of an active "went live" notification, so it can be
        -- edited to "was live" once the stream ends. NULL when nothing is currently live.
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS live_message_id TEXT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS last_post_at BIGINT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS last_error TEXT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS batch_header_template TEXT;
        -- YouTube Data API migration: cache the resolved channel + uploads-playlist ID
        -- per watch so a handle is only ever resolved once (saves API quota and avoids
        -- re-doing the one fragile lookup step on every poll).
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT;
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS youtube_uploads_playlist_id TEXT;
        -- Video ID of a currently-tracked-as-live YouTube stream, so routine polling can
        -- detect when it ends and call markStreamOffline — same mechanism live_message_id
        -- already provides for Twitch/Kick.
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS youtube_live_video_id TEXT;
        -- WebSub (PubSubHubbub) push subscriptions, one row per distinct YouTube channel
        -- (not per watch — several watches/guilds can track the same channel and share
        -- one subscription). Gives near-instant new-video/live-start notifications at
        -- zero API quota cost; routine polling still runs underneath as a fallback in
        -- case a push is ever missed.
        CREATE TABLE IF NOT EXISTS youtube_subscriptions (
            channel_id TEXT PRIMARY KEY,
            expires_at BIGINT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS social_links (
            id SERIAL PRIMARY KEY,
            guild_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            external_user_id TEXT NOT NULL,
            external_username TEXT,
            access_token TEXT NOT NULL,
            refresh_token TEXT,
            expires_at BIGINT,
            linked_by TEXT,
            linked_at BIGINT,
            UNIQUE (guild_id, platform, external_user_id)
        );
        CREATE INDEX IF NOT EXISTS social_links_guild_platform ON social_links(guild_id, platform);
    `);
    // Backfill seen_post_ids for existing rows so nothing re-fires after migration
    await pool.query(`
        UPDATE watches
        SET seen_post_ids = jsonb_build_array(last_post_id)
        WHERE last_post_id IS NOT NULL AND seen_post_ids = '[]'::jsonb
    `);
    await migrateLegacyMessages();
}

// One-time (idempotent) migration: any watch still using the old single
// message_template (from the removed /social add "message" option) gets that
// same text copied into every post type under message_templates, so nothing
// silently stops sending a message once the old field is phased out. Flagged
// as legacy_migrated so the manage view can warn it hasn't been reviewed —
// the wording was written for one generic message and may not fit every type.
async function migrateLegacyMessages() {
    const res = await pool.query(`
        SELECT * FROM watches
        WHERE message_template IS NOT NULL
        AND (message_templates IS NULL OR message_templates = '{}'::jsonb)
    `);
    let migrated = 0;
    for (const w of res.rows) {
        const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
        if (types.length <= 1) continue; // single-type platforms have nothing meaningful to split into
        const templates = {};
        for (const t of types) templates[t.id] = w.message_template;
        await pool.query('UPDATE watches SET message_templates = $1, legacy_migrated = TRUE WHERE id = $2', [JSON.stringify(templates), w.id]);
        migrated++;
    }
    if (migrated) console.log(`🔄 Auto-migrated ${migrated} legacy single-message watch(es) to per-type messages.`);
}

const configCache = new Map();
async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    const res = await pool.query('SELECT data FROM configs WHERE guild_id = $1', [guildId]);
    const data = res.rows[0]?.data ?? {};
    configCache.set(guildId, data); return data;
}
function saveConfig(guildId, data) {
    configCache.set(guildId, data);
    pool.query('INSERT INTO configs (guild_id, data) VALUES ($1, $2) ON CONFLICT (guild_id) DO UPDATE SET data = $2', [guildId, data]).catch(e => console.error('saveConfig:', e.message));
}

const SUPPORT_SERVER_URL = 'https://discord.gg/CmNjecb82Y';

// Finds a channel to post admin/mod updates in. Prefers a channel hidden from
// @everyone where every role that can view it has an elevated permission
// (Administrator/Manage*/Kick/Ban), with dev/admin/staff/mod/owner in the name
// preferred within that set. Falls back to any @everyone-hidden channel, then
// any matching-named channel, then the first postable channel.
const ANNOUNCEMENT_NAME_HINT = /dev|admin|staff|mod|owner/i;
const ELEVATED_PERMS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
];
function findAnnouncementChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;
    const textChannels = guild.channels.cache.filter(c =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)
    );
    if (!textChannels.size) return null;

    const everyoneRole = guild.roles.everyone;
    const everyoneCanView = c => c.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel);
    // Non-@everyone roles that can view this channel
    const viewerRoles = c => guild.roles.cache.filter(r => r.id !== everyoneRole.id && c.permissionsFor(r)?.has(PermissionFlagsBits.ViewChannel));
    const isElevatedRole = r => ELEVATED_PERMS.some(p => r.permissions.has(p));

    const restricted = textChannels.filter(c => !everyoneCanView(c));
    if (restricted.size) {
        const highPriv = restricted.filter(c => {
            const roles = viewerRoles(c);
            return roles.size > 0 && roles.every(isElevatedRole);
        });
        const pool = highPriv.size ? highPriv : restricted;
        const named = pool.find(c => ANNOUNCEMENT_NAME_HINT.test(c.name));
        return named || pool.first();
    }
    // No restricted channel found — fall back to first available postable channel
    const named = textChannels.find(c => ANNOUNCEMENT_NAME_HINT.test(c.name) || /general/i.test(c.name));
    return named || textChannels.first();
}

async function announceSupportServer(guild) {
    try {
        const channel = findAnnouncementChannel(guild);
        if (!channel) return;
        const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for using Notifyer!')
            .setDescription(`Run **/setup** to get a quick walkthrough of what this bot does and set up your first tracked account.\n\nJoin the support server for help, updates, and to report issues:\n${SUPPORT_SERVER_URL}`);
        await channel.send({ embeds: [embed] });
        console.log(`📨 Sent support server announcement to ${guild.name} (#${channel.name})`);
    } catch (e) {
        console.error(`announceSupportServer (${guild.id}):`, e.message);
    }
}

// One-time follow-up that a mirror is back — separate flag so it sends even to
// guilds already warned about the outage.
async function announceTwitterRestoredForGuild(guildId) {
    try {
        const cfg = await getConfig(guildId);
        if (cfg.twitterRestoredAnnounced) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const channel = findAnnouncementChannel(guild);
        if (!channel) return;
        const embed = new EmbedBuilder().setColor('#00ff00').setTitle('✅ Twitter/X tracking is back')
            .setDescription(
                'This server has one or more Twitter/X watches. The Nitter mirrors this bot reads through have held up reliably, so Twitter/X tracking is fully re-enabled — no action needed, existing watches resume automatically.'
            );
        await channel.send({ embeds: [embed] }).catch(e => console.error(`twitter restored update send (${guildId}):`, e.message));
        saveConfig(guildId, { ...cfg, twitterRestoredAnnounced: true });
        console.log(`✅ Sent Twitter restored update to ${guild.name} (#${channel.name})`);
    } catch (e) {
        console.error(`announceTwitterRestoredForGuild (${guildId}):`, e.message);
    }
}
async function announceTwitterRestoredGuilds() {
    const watches = await getAllWatches();
    const guildIdsWithTwitter = [...new Set(watches.filter(w => w.platform === 'twitter').map(w => w.guild_id))];
    for (const guildId of guildIdsWithTwitter) await announceTwitterRestoredForGuild(guildId);
}

// One-time heads-up about the legacy format's retirement. Discord's <t:...:R>
// timestamp gives a live countdown client-side, no bot-side editing needed.
async function announceLegacyMigrationForGuild(guildId) {
    try {
        const cfg = await getConfig(guildId);
        if (cfg.legacyMigrationAnnounced) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const channel = findAnnouncementChannel(guild);
        if (!channel) return;
        const embed = new EmbedBuilder().setColor('#FFA500').setTitle('⚠️ Legacy message system: permanent migration')
            .setDescription(
                'This server has one or more watches still using the old single-message format.\n\n' +
                `In October, we're **permanently** migrating everyone to the new per-type message system. ` +
                `**After the migration, the old system will not work** — watches still on the legacy format ` +
                'should be reviewed and re-saved before then.\n\n' +
                `**Migration date:** <t:${LEGACY_MIGRATION_TS}:F> (<t:${LEGACY_MIGRATION_TS}:R>)`
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('legacymigration_viewwatches').setLabel('📋 View My Watches').setStyle(ButtonStyle.Primary)
        );
        await channel.send({ embeds: [embed], components: [row] }).catch(e => console.error(`legacy migration announce send (${guildId}):`, e.message));
        saveConfig(guildId, { ...cfg, legacyMigrationAnnounced: true });
        console.log(`⚠️ Sent legacy migration notice to ${guild.name} (#${channel.name})`);
    } catch (e) {
        console.error(`announceLegacyMigrationForGuild (${guildId}):`, e.message);
    }
}
async function announceLegacyMigrationGuilds() {
    const watches = await getAllWatches();
    const guildIdsWithLegacy = [...new Set(watches.filter(w => isLegacyMessageFormat(w)).map(w => w.guild_id))];
    for (const guildId of guildIdsWithLegacy) await announceLegacyMigrationForGuild(guildId);
}

async function getWatches(guildId) {
    const res = await pool.query('SELECT * FROM watches WHERE guild_id = $1 ORDER BY id', [guildId]);
    return res.rows;
}
async function getAllWatches() {
    const res = await pool.query('SELECT * FROM watches ORDER BY id');
    return res.rows;
}
async function addWatch({ guildId, platform, handle, channelId, messageTemplate, addedBy }) {
    const res = await pool.query(
        'INSERT INTO watches (guild_id, platform, handle, channel_id, message_template, added_by, added_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [guildId, platform, handle, channelId, messageTemplate ?? null, addedBy, Date.now()]
    );
    return res.rows[0];
}
async function removeWatch(guildId, id) {
    const res = await pool.query('DELETE FROM watches WHERE guild_id = $1 AND id = $2', [guildId, id]);
    return res.rowCount > 0;
}
async function updateWatchTemplate(guildId, id, template) {
    await pool.query('UPDATE watches SET message_template = $1 WHERE guild_id = $2 AND id = $3', [template, guildId, id]);
}
async function updateWatchBatchHeader(guildId, id, template) {
    await pool.query('UPDATE watches SET batch_header_template = $1 WHERE guild_id = $2 AND id = $3', [template, guildId, id]);
}
async function updateWatchRole(guildId, id, roleId) {
    await pool.query('UPDATE watches SET role_id = $1 WHERE guild_id = $2 AND id = $3', [roleId, guildId, id]);
}
async function updateWatchActive(guildId, id, active) {
    await pool.query('UPDATE watches SET active = $1 WHERE guild_id = $2 AND id = $3', [active, guildId, id]);
}
async function updateWatchChannel(guildId, id, channelId) {
    await pool.query('UPDATE watches SET channel_id = $1 WHERE guild_id = $2 AND id = $3', [channelId, guildId, id]);
}
async function updateWatchNotifyTypes(guildId, id, types) {
    await pool.query('UPDATE watches SET notify_types = $1 WHERE guild_id = $2 AND id = $3', [JSON.stringify(types), guildId, id]);
}
async function updateWatchMessageTemplates(guildId, id, templatesObj) {
    // Saving explicitly counts as "reviewed" — clear the outdated/legacy warning.
    await pool.query('UPDATE watches SET message_templates = $1, legacy_migrated = FALSE WHERE guild_id = $2 AND id = $3', [JSON.stringify(templatesObj), guildId, id]);
}
async function setWatchLiveMessage(id, messageId) {
    await pool.query('UPDATE watches SET live_message_id = $1 WHERE id = $2', [messageId, id]);
}
async function updateWatchYouTubeIds(id, channelId, uploadsPlaylistId) {
    await pool.query('UPDATE watches SET youtube_channel_id = $1, youtube_uploads_playlist_id = $2 WHERE id = $3', [channelId, uploadsPlaylistId, id]);
}
async function setWatchYouTubeLiveVideo(id, videoId) {
    await pool.query('UPDATE watches SET youtube_live_video_id = $1 WHERE id = $2', [videoId, id]);
}
async function getWatchesByYouTubeChannel(channelId) {
    const res = await pool.query('SELECT * FROM watches WHERE youtube_channel_id = $1 AND active = TRUE', [channelId]);
    return res.rows;
}
async function getYouTubeSubscription(channelId) {
    const res = await pool.query('SELECT * FROM youtube_subscriptions WHERE channel_id = $1', [channelId]);
    return res.rows[0] || null;
}
async function upsertYouTubeSubscription(channelId, expiresAt) {
    await pool.query(
        'INSERT INTO youtube_subscriptions (channel_id, expires_at) VALUES ($1, $2) ON CONFLICT (channel_id) DO UPDATE SET expires_at = $2',
        [channelId, expiresAt]
    );
}
async function setWatchSocialLink(guildId, id, socialLinkId) {
    await pool.query('UPDATE watches SET social_link_id = $1 WHERE guild_id = $2 AND id = $3', [socialLinkId, guildId, id]);
}

// ── Social account links (OAuth) ────────────────────────────────────────────
async function upsertSocialLink({ guildId, platform, externalUserId, externalUsername, accessToken, refreshToken, expiresAt, linkedBy }) {
    const res = await pool.query(
        `INSERT INTO social_links (guild_id, platform, external_user_id, external_username, access_token, refresh_token, expires_at, linked_by, linked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (guild_id, platform, external_user_id) DO UPDATE SET
            external_username = EXCLUDED.external_username, access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at,
            linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at
         RETURNING *`,
        [guildId, platform, externalUserId, externalUsername, accessToken, refreshToken ?? null, expiresAt ?? null, linkedBy, Date.now()]
    );
    return res.rows[0];
}
async function getSocialLinks(guildId, platform) {
    const res = await pool.query('SELECT * FROM social_links WHERE guild_id = $1 AND platform = $2 ORDER BY external_username', [guildId, platform]);
    return res.rows;
}
async function getSocialLinkByUsername(guildId, platform, username) {
    const res = await pool.query('SELECT * FROM social_links WHERE guild_id = $1 AND platform = $2 AND lower(external_username) = lower($3)', [guildId, platform, username]);
    return res.rows[0] || null;
}
async function getSocialLinkById(id) {
    const res = await pool.query('SELECT * FROM social_links WHERE id = $1', [id]);
    return res.rows[0] || null;
}
async function updateSocialLinkTokens(id, accessToken, refreshToken, expiresAt) {
    await pool.query('UPDATE social_links SET access_token = $1, refresh_token = COALESCE($2, refresh_token), expires_at = $3 WHERE id = $4', [accessToken, refreshToken, expiresAt, id]);
}
// Deletes a social_links row and detaches any watches still pointing at it
// (those watches stop polling — see the "not linked yet" guard in pollAll —
// rather than being deleted outright, so removing a link doesn't silently
// wipe someone's tracked-account/channel setup).
async function deleteSocialLink(guildId, id) {
    await pool.query('UPDATE watches SET social_link_id = NULL WHERE guild_id = $1 AND social_link_id = $2', [guildId, id]);
    const res = await pool.query('DELETE FROM social_links WHERE guild_id = $1 AND id = $2', [guildId, id]);
    return res.rowCount > 0;
}
async function getWatch(guildId, id) {
    const res = await pool.query('SELECT * FROM watches WHERE guild_id = $1 AND id = $2', [guildId, id]);
    return res.rows[0] || null;
}
const SEEN_HISTORY_SIZE = 20;
async function updateLastPost(id, lastPostId, seenIds = [], isNewPost = false) {
    const updated = [...new Set([lastPostId, ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
    const now = Date.now();
    const setClause = isNewPost
        ? 'last_post_id = $1, last_checked = $2, seen_post_ids = $3, last_error = NULL, last_post_at = $2'
        : 'last_post_id = $1, last_checked = $2, seen_post_ids = $3, last_error = NULL';
    await pool.query(`UPDATE watches SET ${setClause} WHERE id = $4`, [lastPostId, now, JSON.stringify(updated), id]);
}
async function touchLastChecked(id, errorMessage = null) {
    await pool.query('UPDATE watches SET last_checked = $1, last_error = $2 WHERE id = $3', [Date.now(), errorMessage, id]);
}

// ── Helpers ────────────────────────────────────────────────────────────────
const E = (c, t) => new EmbedBuilder().setColor(c).setTitle(t).setTimestamp();

function fetchText(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        // Was a self-identifying "SocialNotifyBot/1.0" UA — swapped to a realistic
        // browser string as a test against the YouTube 404s (Sept 2026), since a
        // UA that announces itself as a bot is an easy, obvious anti-bot signal.
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', ...headers } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location, headers).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    });
}

async function hasCommandPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const cfg = await getConfig(guildId);
    return cfg.accessRoleId ? interaction.member.roles.cache.has(cfg.accessRoleId) : false;
}
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

// ── Platform fetchers: each returns { id, url, title, author, thumbnail, timestamp } or null ──
// Resolves a handle (or raw UC... channel ID) to its channel ID and uploads
// playlist ID via the API — 1 quota unit, and only ever called once per watch
// since the result gets cached (see updateWatchYouTubeIds / fetchLatestYouTubeEntries).
async function resolveYouTubeChannel(handle) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const isRawId = /^UC[\w-]{22}$/.test(handle);
    const url = isRawId
        ? `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${handle}&key=${YOUTUBE_API_KEY}`
        : `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&forHandle=${encodeURIComponent(handle.startsWith('@') ? handle : '@' + handle)}&key=${YOUTUBE_API_KEY}`;
    const { status, json } = await fetchJson(url);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const item = json?.items?.[0];
    if (!item) throw new Error('Could not resolve that YouTube channel — check the handle/URL');
    return { channelId: item.id, uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads };
}

// Subscribes (or renews) a WebSub push subscription for a channel so new
// uploads/live-starts get pushed to /youtube/websub instantly instead of
// waiting for the next poll. Best-effort: routine polling still works as a
// fallback even if this never confirms, so failures here are logged, not thrown.
async function ensureYouTubeSubscription(channelId) {
    if (!PUBLIC_BASE_URL) return; // no public URL to receive the callback on yet
    try {
        const existing = await getYouTubeSubscription(channelId);
        const renewalThreshold = Date.now() + 24 * 60 * 60 * 1000; // renew if expiring within a day
        if (existing && existing.expires_at > renewalThreshold) return; // still fresh
        const leaseSeconds = 4 * 24 * 60 * 60; // ask for ~4 days; the hub may grant a different lease
        await postForm(WEBSUB_HUB_URL, {
            'hub.mode': 'subscribe',
            'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
            'hub.callback': `${PUBLIC_BASE_URL}/youtube/websub`,
            'hub.verify': 'async',
            'hub.lease_seconds': String(leaseSeconds),
            'hub.verify_token': WEBSUB_VERIFY_TOKEN,
        }, {}, 30000); // this hub is known to be occasionally slow — 30s instead of the 15s default
        // The hub verifies asynchronously (a GET to our callback, handled in the HTTP
        // server below) before the subscription actually takes effect — record our
        // requested expiry optimistically now; the callback doesn't need to update this.
        await upsertYouTubeSubscription(channelId, Date.now() + leaseSeconds * 1000);
    } catch (e) {
        console.error(`ensureYouTubeSubscription (${channelId}):`, e.message);
    }
}

async function fetchLatestYouTubeEntries(w) {
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    let { youtube_channel_id: channelId, youtube_uploads_playlist_id: playlistId } = w;
    if (!channelId || !playlistId) {
        const resolved = await resolveYouTubeChannel(w.handle);
        channelId = resolved.channelId;
        playlistId = resolved.uploadsPlaylistId;
        await updateWatchYouTubeIds(w.id, channelId, playlistId);
    }
    // Cheap no-op most of the time (only actually re-subscribes when a lease is
    // genuinely close to expiring) — piggybacking on routine polling means no
    // separate renewal scheduler is needed.
    ensureYouTubeSubscription(channelId).catch(() => {});

    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=10&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    return (json.items || []).map(it => ({
        id: it.contentDetails.videoId,
        url: `https://www.youtube.com/watch?v=${it.contentDetails.videoId}`,
        title: it.snippet.title,
        author: it.snippet.channelTitle,
        thumbnail: it.snippet.thumbnails?.medium?.url || it.snippet.thumbnails?.default?.url || null,
        timestamp: it.contentDetails.videoPublishedAt || it.snippet.publishedAt,
    }));
}

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



async function fetchTwitch(path) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!clientId) throw new Error('TWITCH_CLIENT_ID env var not set');
    const token = await getTwitchToken();
    const raw = await fetchText(`https://api.twitch.tv/helix/${path}`, {
        'Client-Id': clientId,
        'Authorization': `Bearer ${token}`,
    });
    return JSON.parse(raw);
}

// ── Twitch OAuth token management ─────────────────────────────────────────
let twitchToken = null, twitchTokenExpiry = 0;
async function getTwitchToken() {
    if (twitchToken && Date.now() < twitchTokenExpiry - 60_000) return twitchToken;
    const clientId = process.env.TWITCH_CLIENT_ID, clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET env vars not set');

    // Twitch's token endpoint requires POST, so we can't use fetchText (GET-only) here.
    const res = await new Promise((resolve, reject) => {
        const body = `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
        const req = https.request('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, res => {
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        });
        req.on('error', reject); req.write(body); req.end();
    });
    if (!res.access_token) throw new Error(`Twitch token error: ${JSON.stringify(res)}`);
    twitchToken = res.access_token;
    twitchTokenExpiry = Date.now() + (res.expires_in * 1000);
    return twitchToken;
}

// Cache login→id mappings to avoid repeated lookups
const twitchUserIdCache = new Map();
async function getTwitchUserId(login) {
    return (await getTwitchUserInfo(login)).id;
}
// Cache both the numeric ID and profile picture — the latter is used as a fallback
// thumbnail when a specific stream/VOD doesn't have its own preview image yet
// (common for very fresh streams/VODs, and Twitch sometimes just leaves it empty).
async function getTwitchUserInfo(login) {
    if (twitchUserIdCache.has(login)) return twitchUserIdCache.get(login);
    const data = await fetchTwitch(`users?login=${encodeURIComponent(login)}`);
    const user = data.data?.[0];
    if (!user) throw new Error(`Twitch user "${login}" not found`);
    const info = { id: user.id, profileImageUrl: user.profile_image_url || null };
    twitchUserIdCache.set(login, info);
    return info;
}

// Returns array of posts: [{id, url, title, author, thumbnail, timestamp, postType}]
async function fetchLatestTwitchAll(handle) {
    const { id: userId, profileImageUrl } = await getTwitchUserInfo(handle);
    const [streamData, vodData] = await Promise.all([
        fetchTwitch(`streams?user_id=${userId}`),
        fetchTwitch(`videos?user_id=${userId}&type=archive&first=1`),
    ]);
    const results = [];

    const stream = streamData.data?.[0];
    if (stream) {
        const liveThumb = (stream.thumbnail_url || '').replace('{width}', '1280').replace('{height}', '720');
        results.push({
            id: `live_${stream.id}`,
            url: `https://www.twitch.tv/${handle}`,
            title: stream.title || `${handle} is live!`,
            author: stream.user_name || handle,
            // Fresh streams sometimes don't have a preview snapshot yet — fall back to the
            // channel's profile picture rather than showing no image at all.
            thumbnail: liveThumb || profileImageUrl,
            timestamp: stream.started_at,
            postType: 'live',
            isLive: true,
        });
    }

    const vod = vodData.data?.[0];
    if (vod) {
        const vodThumb = (vod.thumbnail_url || '').replace('%{width}', '1280').replace('%{height}', '720');
        results.push({
            id: vod.id,
            url: vod.url,
            title: vod.title,
            author: vod.user_name || handle,
            // Twitch often leaves thumbnail_url empty for VODs (especially right after a
            // stream ends, before the thumbnail's generated) — same fallback as above.
            thumbnail: vodThumb || profileImageUrl,
            timestamp: vod.published_at || vod.created_at,
            postType: 'vods',
        });
    }
    return results;
}

// ── Kick ─────────────────────────────────────────────────────────────────
// Kick's official public API. Live status is public data, so we use an
// app-level Client Credentials token (no per-channel authorization needed) —
// unlike Instagram/TikTok, this works for any public Kick channel.
async function fetchKick(path) {
    const clientId = process.env.KICK_CLIENT_ID, clientSecret = process.env.KICK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars not set');
    const token = await getKickAppToken();
    const { json } = await fetchJson(`https://api.kick.com/public/v1/${path}`, { Authorization: `Bearer ${token}` });
    return json;
}

let kickToken = null, kickTokenExpiry = 0;
async function getKickAppToken() {
    if (kickToken && Date.now() < kickTokenExpiry - 60_000) return kickToken;
    const clientId = process.env.KICK_CLIENT_ID, clientSecret = process.env.KICK_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars not set');
    const { json } = await postForm('https://id.kick.com/oauth/token', {
        client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials',
    });
    if (!json?.access_token) throw new Error(`Kick token error: ${JSON.stringify(json)}`);
    kickToken = json.access_token;
    kickTokenExpiry = Date.now() + (json.expires_in * 1000);
    return kickToken;
}

// Cache slug→channel info mappings to avoid repeated lookups. Stores the broadcaster ID
// plus a fallback image (profile/banner picture) for when a specific livestream doesn't
// have its own thumbnail set.
const kickBroadcasterIdCache = new Map();
async function getKickChannelInfo(slug) {
    if (kickBroadcasterIdCache.has(slug)) return kickBroadcasterIdCache.get(slug);
    const data = await fetchKick(`channels?slug=${encodeURIComponent(slug)}`);
    const channel = data?.data?.[0];
    if (!channel) throw new Error(`Kick channel "${slug}" not found`);
    const info = {
        id: channel.broadcaster_user_id,
        fallbackThumb: channel.profile_picture || channel.banner_picture || null,
    };
    kickBroadcasterIdCache.set(slug, info);
    return info;
}
async function getKickBroadcasterId(slug) {
    return (await getKickChannelInfo(slug)).id;
}

// Returns array of posts: [{id, url, title, author, thumbnail, timestamp, postType, isLive}]
// — only ever 0 or 1 entries, since Kick's public API currently exposes live status only.
async function fetchLatestKickAll(handle) {
    const { id: broadcasterId, fallbackThumb } = await getKickChannelInfo(handle);
    const data = await fetchKick(`livestreams?broadcaster_user_id=${broadcasterId}`);
    const stream = data?.data?.[0];
    if (!stream) return [];
    return [{
        id: `live_${stream.id || stream.started_at}`,
        url: `https://kick.com/${handle}`,
        title: stream.stream_title || `${handle} is live!`,
        author: handle,
        // Fall back to the channel's own picture if this specific stream has no thumbnail set.
        thumbnail: (stream.thumbnail?.url || stream.thumbnail) || fallbackThumb || null,
        timestamp: stream.started_at,
        postType: 'live',
        isLive: true,
    }];
}

// ── YouTube post type detection ────────────────────────────────────────────
// Classifies a batch of video IDs (video/short/live) in a SINGLE API call —
// videos.list costs 1 quota unit per call regardless of how many IDs are
// requested (up to 50), so always batch this rather than calling per-video.
// Returns { [videoId]: { postType, isLive } }.
async function classifyYouTubeVideos(videoIds) {
    if (!videoIds.length) return {};
    if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY is not set');
    const { status, json } = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${videoIds.join(',')}&key=${YOUTUBE_API_KEY}`);
    if (status !== 200) throw new Error(json?.error?.message || `HTTP ${status}`);
    const result = {};
    for (const item of json.items || []) {
        const isCurrentlyLive = item.snippet.liveBroadcastContent === 'live'
            || (item.liveStreamingDetails && !item.liveStreamingDetails.actualEndTime && item.liveStreamingDetails.actualStartTime);
        let postType = 'videos';
        if (isCurrentlyLive) {
            postType = 'live';
        } else {
            // Shorts heuristic: YouTube's own current cutoff is 3 minutes. ISO 8601
            // duration like PT45S / PT2M30S — anything with an "H" (hours) component
            // is never a Short, and the regex below simply won't match those anyway.
            const m = item.contentDetails.duration?.match(/^PT(?:(\d+)M)?(?:(\d+)S)?$/);
            const totalSeconds = m ? (parseInt(m[1] || '0', 10) * 60 + parseInt(m[2] || '0', 10)) : null;
            if (totalSeconds !== null && totalSeconds <= 180) postType = 'shorts';
        }
        result[item.id] = { postType, isLive: isCurrentlyLive, hasEnded: Boolean(item.liveStreamingDetails?.actualEndTime) };
    }
    return result;
}

async function fetchLatestPost(platform, handle) {
    switch (platform) {
        case 'youtube': return null;   // handled separately in pollAll (fetchLatestYouTubeEntries)
        case 'twitter': return fetchLatestTwitter(handle);
        case 'twitch': return null;    // handled separately in pollAll (fetchLatestTwitchAll)
        case 'kick': return null;      // handled separately in pollAll (fetchLatestKickAll)
        case 'instagram': return null; // handled separately in pollAll (fetchLatestInstagramAll)
        case 'tiktok': return null;    // handled separately in pollAll (fetchLatestTikTokAll)
        default: return null;
    }
}

// ── OAuth token refresh (Instagram / TikTok) ───────────────────────────────
// Refreshes a stored social_links row's access token if it's near expiry.
// Returns the (possibly updated) row, or throws if refresh fails — callers
// should treat a throw as "the link is dead, tell the person to /social link again".
async function ensureFreshToken(link) {
    const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000; // refresh if <24h left
    if (!link.expires_at || link.expires_at - Date.now() > REFRESH_MARGIN_MS) return link;

    if (link.platform === 'instagram') {
        // Instagram User tokens (Instagram Login flow) refresh via graph.instagram.com directly —
        // no app client_id/secret needed for this call, just the current valid long-lived token.
        const { json } = await fetchJson(
            `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(link.access_token)}`
        );
        if (!json?.access_token) throw new Error('Instagram token refresh failed — re-link with /social link.');
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 55 * 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, null, expiresAt);
        return { ...link, access_token: json.access_token, expires_at: expiresAt };
    }

    if (link.platform === 'tiktok') {
        const cfg = OAUTH_CONFIG.tiktok;
        if (!link.refresh_token) throw new Error('TikTok refresh token missing — re-link with /social link.');
        const { json } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
            client_key: cfg.clientId, client_secret: cfg.clientSecret,
            grant_type: 'refresh_token', refresh_token: link.refresh_token,
        });
        if (!json?.access_token) throw new Error('TikTok token refresh failed — re-link with /social link.');
        const expiresAt = Date.now() + (json.expires_in ? json.expires_in * 1000 : 24 * 60 * 60 * 1000);
        await updateSocialLinkTokens(link.id, json.access_token, json.refresh_token || link.refresh_token, expiresAt);
        return { ...link, access_token: json.access_token, refresh_token: json.refresh_token || link.refresh_token, expires_at: expiresAt };
    }

    return link;
}

// ── Instagram (Meta Graph API) ─────────────────────────────────────────────
async function fetchLatestInstagramAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await fetchJson(
        `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_product_type,media_url,permalink,timestamp&limit=10&access_token=${encodeURIComponent(fresh.access_token)}`
    );
    if (json?.error) throw new Error(`Instagram API: ${json.error.message}`);
    const items = json?.data || [];
    return items.map(m => ({
        id: m.id,
        url: m.permalink,
        title: (m.caption || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: m.media_type === 'VIDEO' ? null : m.media_url,
        timestamp: m.timestamp,
        // media_product_type: FEED | REELS | STORY (STORY rarely returned — stories expire in 24h and this endpoint mostly covers feed/reels)
        postType: m.media_product_type === 'REELS' ? 'reels' : m.media_product_type === 'STORY' ? 'stories' : 'posts',
    }));
}

// ── TikTok ───────────────────────────────────────────────────────────────
// Best-effort: invalidates the token on TikTok's side so this app drops off
// the user's "Manage app permissions" list. If it fails (already expired,
// network hiccup, etc.) we still proceed to delete our local copy — an
// already-dead token isn't a reason to keep the row around.
async function revokeTikTokToken(link) {
    const cfg = OAUTH_CONFIG.tiktok;
    if (!cfg.clientId || !cfg.clientSecret || !link.access_token) return { ok: false, reason: 'missing credentials/token' };
    try {
        const { status, json } = await postForm('https://open.tiktokapis.com/v2/oauth/revoke/', {
            client_key: cfg.clientId, client_secret: cfg.clientSecret, token: link.access_token,
        });
        if (status >= 200 && status < 300) return { ok: true };
        return { ok: false, reason: json?.error?.message || json?.error_description || `HTTP ${status}` };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}
async function fetchLatestTikTokAll(link) {
    const fresh = await ensureFreshToken(link);
    const { json } = await postJson(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time',
        { max_count: 10 },
        { Authorization: `Bearer ${fresh.access_token}` }
    );
    if (json?.error?.code && json.error.code !== 'ok') throw new Error(`TikTok API: ${json.error.message || json.error.code}`);
    const items = json?.data?.videos || [];
    return items.map(v => ({
        id: v.id,
        url: v.share_url,
        title: (v.title || v.video_description || '').slice(0, 200),
        author: fresh.external_username,
        thumbnail: v.cover_image_url,
        timestamp: v.create_time ? v.create_time * 1000 : Date.now(),
        postType: 'videos',
    }));
}

// ── Message templating ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE = '🔔 **{author}** just posted on {platform}!\n{url}';
// Nicer default specifically for live-stream notifications — uses the {is/was} token
// (see renderTemplate) so the same wording works for both "went live" and "ended".
const LIVE_DEFAULT_TEMPLATE = '🔴 **{author}** {is/was} live on {platform}!\n{url}';
// Shown wherever someone's about to set a custom message, so new users don't have to
// dig through /help to discover these — Discord modals can't show static text inside
// the form itself, so this goes on the embed screen right before the modal opens.
const PLACEHOLDER_HELP = '`{author}` `{handle}` `{platform}` `{title}` `{url}` — for Live, also `{is/was}` (is/was live)';
// Resolves the message template for a watch + post, preferring a per-post-type
// override (w.message_templates[post.postType]) over the watch's single
// message_template, over the global default.
function resolveTemplate(w, post) {
    if (post.postType && w.message_templates && w.message_templates[post.postType]) return w.message_templates[post.postType];
    return w.message_template || null;
}
// `ended` flips the {is/was} token — pass true when editing a "went live" notification
// to say the stream ended, false (default) for the original live/normal notification.
function renderTemplate(template, post, platform, handle, ended = false) {
    const tmpl = template || (post.postType === 'live' ? LIVE_DEFAULT_TEMPLATE : DEFAULT_TEMPLATE);
    return tmpl
        .replace(/\{is\/was\}/g, ended ? 'was' : 'is')
        .replace(/\{author\}/g, post.author || handle)
        .replace(/\{handle\}/g, handle)
        .replace(/\{platform\}/g, PLATFORMS[platform].label)
        .replace(/\{title\}/g, post.title || '')
        .replace(/\{url\}/g, post.url || '');
}

// ── Polling loop ───────────────────────────────────────────────────────────
const PLATFORM_MIN_INTERVAL_MS = {};

function shouldNotify(w, post) {
    const types = Array.isArray(w.notify_types) && w.notify_types.length ? w.notify_types : null;
    if (!types) return true; // no filter = all types
    return post.postType ? types.includes(post.postType) : true;
}

// ── Post-type → button label map (used instead of a generic "View post") ───
const POST_TYPE_BUTTON_LABEL = {
    youtube:   { videos: 'Watch Video', shorts: 'Watch Short', live: 'Watch Live' },
    twitter:   { posts: 'View Tweet' },
    twitch:    { live: 'Join Stream', vods: 'Watch VOD' },
    kick:      { live: 'Join Stream' },
    instagram: { posts: 'View Post', reels: 'Watch Reel', stories: 'View Story' },
    tiktok:    { videos: 'Watch TikTok' },
};
function buttonLabelFor(platform, post) {
    if (post.isLive) return POST_TYPE_BUTTON_LABEL[platform]?.live || 'Join Stream';
    return POST_TYPE_BUTTON_LABEL[platform]?.[post.postType] || 'View Post';
}

// Builds a fake-but-realistic post for /social preview — one per notify type so
// people can check every custom message variant, not just whichever type happens
// to post next in reality.
function buildSamplePost(w, postType) {
    return {
        id: 'preview',
        url: profileUrl(w.platform, w.handle) || 'https://example.com',
        title: 'Sample post title for preview',
        author: w.handle,
        thumbnail: null,
        timestamp: new Date().toISOString(),
        postType,
        isLive: postType === 'live',
    };
}

// Platforms where Discord will render a native, playable video preview if the
// raw URL appears in the message content (not just inside a custom embed).
const NATIVE_VIDEO_PLATFORMS = new Set(['youtube', 'tiktok']);

// Discord's own crawler frequently fails to unfurl tiktok.com links — missing
// thumbnails, or sometimes no embed at all — especially with the official API's
// share_url, which has per-request utm_* tracking params attached (so the same
// video's URL is never quite identical twice, defeating Discord's unfurl cache).
// tnktok.com (fxTikTok) is a well-known Discord-embed-fixer mirror that reliably
// produces a playable video card. We only use it for the auto-unfurled URL in the
// message body — the "Watch TikTok" button below still links to the real tiktok.com
// URL, so people always land on TikTok itself when they click through.
function embeddableUrl(platform, url) {
    if (platform !== 'tiktok' || !url) return url;
    try {
        const u = new URL(url);
        u.hostname = u.hostname.replace(/(^|\.)tiktok\.com$/i, '$1tnktok.com');
        u.search = ''; // tracking params vary per fetch and aren't needed for the embed
        return u.toString();
    } catch {
        return url;
    }
}

// TikTok's public oEmbed endpoint — no auth needed, just the canonical video URL.
// Used only as a fallback when Discord's own crawler fails to unfurl the link.
async function fetchTikTokOEmbed(url) {
    const { status, json } = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (status !== 200 || !json) return null;
    return { title: json.title || null, thumbnail: json.thumbnail_url || null, author: json.author_name || null };
}

// Discord unfurls links asynchronously after the message is sent, and — even with the
// tnktok.com mirror trick above — sometimes just fails to attach an embed at all (crawler
// timeout, mirror hiccup, etc.), leaving a bare link with no visual. This checks back a few
// seconds later and, if nothing got attached, patches the message with a manual embed built
// from TikTok's own oEmbed API so there's always a visual card, playable or not.
async function ensureVideoEmbedFallback(channel, messageId, post) {
    await new Promise(r => setTimeout(r, 7000));
    try {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg || msg.embeds.length > 0) return; // unfurled fine (or message is gone) — nothing to do
        const oembed = await fetchTikTokOEmbed(post.url).catch(() => null);
        const fallback = new EmbedBuilder()
            .setColor(PLATFORMS.tiktok.color)
            .setAuthor({ name: `${oembed?.author || post.author || ''} • TikTok`.replace(/^ • /, '') })
            .setURL(post.url)
            .setDescription(oembed?.title || post.title || null)
            .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
        if (oembed?.thumbnail) fallback.setImage(oembed.thumbnail);
        await msg.edit({ embeds: [fallback] }).catch(e => console.error('embed fallback edit:', e.message));
    } catch (e) {
        console.error('ensureVideoEmbedFallback:', e.message);
    }
}

// Builds the exact {content, embeds, components} a notification would use, without
// sending anything — shared by sendNotification and /social preview so they can
// never drift out of sync with each other.
function buildNotificationPayload(w, post) {
    const p = PLATFORMS[w.platform];
    const typeLabel = post.postType ? ` (${PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === post.postType)?.label || post.postType})` : '';
    let content = renderTemplate(resolveTemplate(w, post), post, w.platform, w.handle);
    // For YouTube/TikTok, make sure a URL that Discord will actually unfurl into a
    // playable video is present on its own line (not just inside a custom embed).
    const wantsNativeVideo = NATIVE_VIDEO_PLATFORMS.has(w.platform) && post.url;
    if (wantsNativeVideo) {
        const embedUrl = embeddableUrl(w.platform, post.url);
        content = content.includes(post.url) ? content.split(post.url).join(embedUrl) : `${content}\n${embedUrl}`;
    }
    if (w.role_id) content = `<@&${w.role_id}> ${content}`;
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(buttonLabelFor(w.platform, post)).setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(p.emojiButton)
    );
    if (wantsNativeVideo) {
        // Discord's native video unfurl (from the raw URL above) already shows the title,
        // thumbnail, and channel/author — a custom embed on top of that is redundant.
        return { content, embeds: [], components: [linkRow], wantsNativeVideo: true };
    }
    const embed = new EmbedBuilder()
        .setColor(post.isLive ? '#FF0000' : p.color)
        .setAuthor({ name: `${post.author || w.handle} • ${p.label}${typeLabel}` })
        .setURL(post.url)
        .setDescription(post.title || null)
        .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
    if (post.isLive) embed.addFields({ name: '🔴 LIVE', value: 'Stream is live now!', inline: true });
    if (post.thumbnail) embed.setImage(post.thumbnail);
    return { content, embeds: [embed], components: [linkRow], wantsNativeVideo: false };
}

// ── Shared watch-creation flow ──────────────────────────────────────────────
// Used by both /social add and the /setup wizard so there's exactly one place
// that validates a platform+handle+channel and creates the watch — no risk of
// the two entry points drifting apart. Returns { ok: true, watch, post } or
// { ok: false, message } (message is already a user-facing ❌ reply string).
async function createWatchFlow(guildId, platform, rawHandle, channelId, addedByTag, bypassUnavailable = false) {
    if (!PLATFORMS[platform]) {
        return { ok: false, message: `❌ Unrecognized platform \`${platform}\`. Please pick one of the options Discord suggests as you type.` };
    }
    if (PLATFORMS[platform]?.unavailable && !bypassUnavailable) {
        return { ok: false, message: `❌ ${PLATFORMS[platform].label} is temporarily unavailable and can't be added right now (see \`/help\` → Info for details).` };
    }
    const handle = normalizeHandle(platform, rawHandle);
    if (!handle) return { ok: false, message: '❌ Could not parse that handle/URL.' };

    const watches = await getWatches(guildId);
    if (watches.some(w => w.platform === platform && w.handle.toLowerCase() === handle.toLowerCase() && w.channel_id === channelId)) {
        return { ok: false, message: '❌ That account is already being tracked in this channel.' };
    }
    if (watches.length >= 50) return { ok: false, message: '❌ This server has reached the maximum of 50 tracked accounts.' };

    let post = null;
    let baselineSeenIds = [];
    let socialLinkId = null;
    if (PLATFORMS[platform].oauth) {
        // Instagram/TikTok can only be watched for accounts that have gone through
        // /social link — there's no way to poll an arbitrary public account via
        // their official APIs without that account's consent.
        const link = await getSocialLinkByUsername(guildId, platform, handle);
        if (!link) {
            return { ok: false, message: `❌ **${handle}** hasn't been linked yet. That account needs to run \`/social link\` and authorize with ${PLATFORMS[platform].label} first — this bot can't watch ${PLATFORMS[platform].label} accounts that haven't consented.\nUse \`/social links\` to see what's already linked in this server.` };
        }
        socialLinkId = link.id;
        try {
            const posts = platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
            post = posts[0] || null;
            // Seed seen_post_ids with EVERY post returned by this check, not just the
            // newest — otherwise the next poll (or /social check) treats the older
            // ones as "unseen" and fires notifications for pre-existing content.
            baselineSeenIds = posts.map(p => p.id);
        } catch (e) {
            return { ok: false, message: `❌ Couldn't fetch that account: ${e.message}` };
        }
    } else {
        try {
            if (platform === 'twitch') {
                const posts = await fetchLatestTwitchAll(handle);
                post = posts[0] || null;
                baselineSeenIds = posts.map(p => p.id);
            } else if (platform === 'kick') {
                const posts = await fetchLatestKickAll(handle);
                post = posts[0] || null;
                baselineSeenIds = posts.map(p => p.id);
            } else {
                post = await fetchLatestPost(platform, handle);
                baselineSeenIds = post?.id ? [post.id] : [];
            }
        } catch (e) {
            if (/HTTP 429/.test(e.message)) {
                // Rate-limited on verify — account likely exists, proceed anyway
                post = null;
            } else {
                return { ok: false, message: `❌ Couldn't fetch that account: ${e.message}\nDouble-check the handle/URL and try again.` };
            }
        }
    }

    const watch = await addWatch({ guildId, platform, handle, channelId, addedBy: addedByTag });
    if (socialLinkId) await setWatchSocialLink(guildId, watch.id, socialLinkId);
    // Seed last_post_id AND seen_post_ids so the first poll doesn't fire
    // notifications for content that already existed before tracking started.
    await updateLastPost(watch.id, post?.id || null, baselineSeenIds);
    return { ok: true, watch, post, handle };
}

// Builds the same "Now Tracking" + next-step (type picker or message-set button)
// response used right after a watch is created, regardless of whether it came
// from /social add or the /setup wizard.
function buildAddWatchSuccessResponse(watch, post, handle, channel) {
    const p = PLATFORMS[watch.platform];
    const types = PLATFORM_NOTIFY_TYPES[watch.platform];
    const successEmbed = E('#00ff00', 'Now Tracking').addFields(
        { name: 'Platform', value: `${p.emojiTag} ${p.label}`, inline: true },
        { name: 'Account', value: handle, inline: true },
        { name: 'Channel', value: `${channel}`, inline: true },
        post?.title
            ? { name: 'Latest post (baseline)', value: `[${post.title.slice(0, 100)}](${post.url})` }
            : { name: 'Baseline', value: 'No posts found yet — will track from first post.' },
    );

    // Single-type platforms (TikTok, Twitter) skip the type-choice step entirely —
    // there's only one kind of post, so go straight to a "set your message" button.
    if (types.length <= 1) {
        successEmbed.setDescription('One more step — set the notification message below.')
            .addFields({ name: 'Placeholders', value: PLACEHOLDER_HELP });
        const msgRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`socialpertype_open_${watch.id}`).setLabel('Set Message').setStyle(ButtonStyle.Primary)
        );
        return { embeds: [successEmbed], components: [msgRow] };
    }

    // Multi-type platforms: choose notification types first — selecting (or skipping)
    // chains straight into the per-type message form, so this is a single guided path
    // instead of separate optional buttons.
    const typeEmbed = new EmbedBuilder().setColor('#5865F2')
        .setTitle(`${p.emojiTag} Choose Notification Types`)
        .setDescription(`Which types of **${p.label}** content do you want notifications for?\nSelect one or more below — you'll set the message for each right after.`)
        .addFields({ name: 'Placeholders (for the message you set next)', value: PLACEHOLDER_HELP });
    const typeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`socialtypeadd_select_${watch.id}`)
            .setPlaceholder('Select notification types…')
            .setMinValues(1).setMaxValues(types.length)
            .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description })))
    );
    const skipRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialtypeadd_skip_${watch.id}`).setLabel('All types (skip)').setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [successEmbed, typeEmbed], components: [typeRow, skipRow] };
}

async function sendNotification(w, post) {
    const guild = client.guilds.cache.get(w.guild_id);
    const channel = guild?.channels.cache.get(w.channel_id);
    if (!channel) return null;
    const payload = buildNotificationPayload(w, post);
    if (payload.wantsNativeVideo) {
        const sent = await channel.send({ content: payload.content, components: payload.components }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); return null; });
        // Discord's crawler occasionally fails to unfurl TikTok links even via the mirror
        // domain — check back shortly and backfill a manual embed if nothing showed up.
        if (sent && w.platform === 'tiktok') ensureVideoEmbedFallback(channel, sent.id, post);
        return sent;
    }
    return channel.send({ content: payload.content, embeds: payload.embeds, components: payload.components }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); return null; });
}

// ── Batched notifications ───────────────────────────────────────────────────
// When several new posts land in the same channel for the same platform during
// one poll cycle — whether from one bursty account or several different ones —
// sending one message per post pings the role N times in a row. At
// BATCH_THRESHOLD+ posts, send one Components V2 message instead: a header
// line (its own top-level component, outside the accent-colored box), then
// one compact title+button "Section" per post inside the box, with dividers
// between them. Below the threshold, posts still send individually as before.
// Live posts (isLive) never batch — their "went live"/"ended" message-edit
// tracking doesn't fit the batch format — and batches never cross platforms,
// only same channel+platform groups are batchable, even across different
// tracked accounts.
const BATCH_THRESHOLD = 3;
const DEFAULT_BATCH_HEADER = '**{author}** posted {count} times!';
function renderBatchHeader(w, count) {
    const tmpl = w.batch_header_template || DEFAULT_BATCH_HEADER;
    return tmpl
        .replace(/\{author\}/g, w.handle)
        .replace(/\{handle\}/g, w.handle)
        .replace(/\{platform\}/g, PLATFORMS[w.platform]?.label || w.platform)
        .replace(/\{count\}/g, String(count));
}
function formatCreatorList(handles) {
    const unique = [...new Set(handles)];
    if (unique.length === 1) return unique[0];
    if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
    return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}
// entries: [{ w, post }] all sharing one channel+platform (see createBatchCollector).
function renderBatchHeaderForEntries(entries) {
    const handles = entries.map(e => e.w.handle);
    const unique = [...new Set(handles)];
    if (unique.length === 1) {
        // Single creator — honor that watch's own customizable header template.
        return renderBatchHeader(entries[0].w, entries.length);
    }
    // Multiple creators contributed — always the generic "A and B posted N
    // times!" form, since one watch's custom {author}-based template wouldn't
    // make sense once more than one account is involved.
    return `${formatCreatorList(handles)} posted ${entries.length} times!`;
}
function hexColorToInt(hex) {
    return parseInt(String(hex).replace('#', ''), 16);
}
function buildBatchPayload(entries) {
    const platform = entries[0].w.platform;
    const p = PLATFORMS[platform];
    // Union every distinct ping role across the contributing watches — a post
    // from any of them is still something someone asked to be pinged for.
    const roleIds = [...new Set(entries.map(e => e.w.role_id).filter(Boolean))];
    const rolePrefix = roleIds.map(id => `<@&${id}> `).join('');
    // The header is its own top-level component — NOT inside the container —
    // so it renders outside the accent-colored box, only the per-post list
    // sits inside it.
    const header = new TextDisplayBuilder().setContent(`${rolePrefix}${renderBatchHeaderForEntries(entries)}`);
    const container = new ContainerBuilder().setAccentColor(hexColorToInt(p.color));
    entries.forEach(({ w, post }, i) => {
        if (i > 0) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        const title = (post.title || '(untitled)').slice(0, 250);
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
                .setButtonAccessory(new ButtonBuilder().setLabel(buttonLabelFor(w.platform, post)).setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(p.emojiButton))
        );
    });
    return { components: [header, container], flags: MessageFlags.IsComponentsV2 };
}
async function sendBatchNotification(entries) {
    const w0 = entries[0].w;
    const guild = client.guilds.cache.get(w0.guild_id);
    const channel = guild?.channels.cache.get(w0.channel_id);
    if (!channel) return null;
    return channel.send(buildBatchPayload(entries)).catch(e => { console.error(`send batch notification (${guild.name}/#${channel.name}, ${entries.length} posts):`, e.message); return null; });
}
// Collects { w, post } entries across an entire poll cycle, grouped by
// channel+platform, so posts from different watches/creators posting to the
// same channel can batch together. pollAll calls .add() per new non-live post
// while walking watches, then .flush() once after the whole cycle — each
// group sends as one batch if it hit BATCH_THRESHOLD, or individually
// (unchanged single-post behavior) otherwise.
function createBatchCollector() {
    const groups = new Map(); // `${channel_id}::${platform}` -> [{w, post}]
    return {
        add(w, post) {
            const key = `${w.channel_id}::${w.platform}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ w, post });
        },
        async flush() {
            for (const entries of groups.values()) {
                if (entries.length >= BATCH_THRESHOLD) {
                    await sendBatchNotification(entries);
                } else {
                    for (const { w, post } of entries) await sendNotification(w, post);
                }
            }
        },
    };
}

// Edits a previously-sent "went live" message to show the stream has ended, once a
// later poll finds the channel no longer live. Falls back to just clearing the tracked
// message ID if the message or channel can no longer be found (deleted, permissions, etc.).
async function markStreamOffline(w) {
    if (!w.live_message_id) return;
    try {
        const guild = client.guilds.cache.get(w.guild_id);
        const channel = guild?.channels.cache.get(w.channel_id);
        const msg = channel ? await channel.messages.fetch(w.live_message_id).catch(() => null) : null;
        if (msg) {
            const p = PLATFORMS[w.platform];
            // Reconstruct a minimal post-like object so the person's own custom "live"
            // message (with {is/was}) renders here too, instead of a hardcoded string.
            const syntheticPost = { author: w.handle, url: profileUrl(w.platform, w.handle), title: null, postType: 'live' };
            const content = renderTemplate(resolveTemplate(w, syntheticPost), syntheticPost, w.platform, w.handle, true);
            const endedEmbed = new EmbedBuilder()
                .setColor('#808080')
                .setAuthor({ name: `${w.handle} • ${p.label}` })
                .setDescription('Stream ended.')
                .setTimestamp();
            await msg.edit({ content, embeds: [endedEmbed], components: msg.components })
                .catch(e => console.error(`edit live-ended message (${w.id}):`, e.message));
        }
    } catch (e) {
        console.error(`markStreamOffline (${w.id}):`, e.message);
    } finally {
        await setWatchLiveMessage(w.id, null);
    }
}

// pollInProgress is keyed per call-site (fast loop / slow loop / manual /social
// check) so the two cadences never block on each other — they touch disjoint
// platform sets anyway, so there's no risk of double-processing the same watch.
const pollInProgress = {};
async function pollAll(platforms = null) {
    const lockKey = platforms ? [...platforms].sort().join(',') : 'all';
    if (pollInProgress[lockKey]) return;
    pollInProgress[lockKey] = true;
    try {
        let watches = await getAllWatches();
        if (platforms) watches = watches.filter(w => platforms.has(w.platform));
        const batch = createBatchCollector();
        for (const w of watches) {
            if (!w.active) continue;
            const minInterval = PLATFORM_MIN_INTERVAL_MS[w.platform];
            if (minInterval && w.last_checked && (Date.now() - w.last_checked) < minInterval) continue;
            try {
                const seenIds = Array.isArray(w.seen_post_ids) ? w.seen_post_ids : [];

                if (w.platform === 'youtube') {
                    // Walk every unseen entry, not just the newest, so bursty uploads
                    // between polls don't get silently skipped.
                    const entries = await fetchLatestYouTubeEntries(w);
                    if (!entries.length) { await touchLastChecked(w.id); continue; }
                    if (w.last_post_id === null) {
                        // First check — seed baseline, don't notify for the back-catalog
                        await updateLastPost(w.id, entries[0].id, entries.map(e => e.id));
                        continue;
                    }
                    const newEntries = entries.filter(e => !seenIds.includes(e.id));
                    if (!newEntries.length && !w.youtube_live_video_id) { await touchLastChecked(w.id); continue; }

                    // Batch-classify every new entry PLUS whatever's currently tracked as
                    // live (if it's not already among the new entries) in one API call —
                    // videos.list costs 1 unit per call regardless of how many IDs, so
                    // there's no reason to ever call it per-video.
                    const idsToClassify = [...new Set([...newEntries.map(e => e.id), ...(w.youtube_live_video_id ? [w.youtube_live_video_id] : [])])];
                    const classified = idsToClassify.length ? await classifyYouTubeVideos(idsToClassify) : {};

                    // A previously-live video that's no longer live (or fell out of the
                    // classify batch entirely, e.g. deleted) has ended — same "edit the
                    // went-live message" mechanism Twitch/Kick already use.
                    if (w.youtube_live_video_id) {
                        const stillLive = classified[w.youtube_live_video_id]?.isLive;
                        if (!stillLive) {
                            await markStreamOffline(w);
                            await setWatchYouTubeLiveVideo(w.id, null);
                        }
                    }

                    if (newEntries.length) {
                        // Chronological (oldest-first) so a batch reads/sends in upload order
                        const chronological = [...newEntries].reverse();
                        for (const entry of chronological) {
                            const c = classified[entry.id];
                            entry.postType = c?.postType || 'videos';
                            entry.isLive = Boolean(c?.isLive);
                            if (entry.postType === 'shorts') entry.url = `https://www.youtube.com/shorts/${entry.id}`;
                        }
                        const toNotify = chronological.filter(e => shouldNotify(w, e));
                        // Live entries always send individually and immediately, with their
                        // own message-edit tracking — never batched, same rule as every
                        // other platform.
                        for (const entry of toNotify.filter(e => e.isLive)) {
                            const sent = await sendNotification(w, entry);
                            if (sent) { await setWatchLiveMessage(w.id, sent.id); await setWatchYouTubeLiveVideo(w.id, entry.id); }
                        }
                        toNotify.filter(e => !e.isLive).forEach(e => batch.add(w, e));
                        const mergedSeen = [...new Set([...newEntries.map(e => e.id), ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
                        await updateLastPost(w.id, entries[0].id, mergedSeen, true);
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else if (w.platform === 'twitch' || w.platform === 'kick' || w.platform === 'instagram' || w.platform === 'tiktok') {
                    // These platforms return multiple posts/post-types at once per check
                    let posts;
                    if (w.platform === 'twitch') {
                        posts = await fetchLatestTwitchAll(w.handle);
                    } else if (w.platform === 'kick') {
                        posts = await fetchLatestKickAll(w.handle);
                    } else {
                        if (!w.social_link_id) { await touchLastChecked(w.id); continue; } // not linked yet — nothing to poll
                        const link = await getSocialLinkById(w.social_link_id);
                        if (!link) { await touchLastChecked(w.id); continue; } // link was removed
                        posts = w.platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
                    }
                    let newSeenIds = [...seenIds];
                    let updated = false;
                    const toNotify = [];
                    for (const post of posts) {
                        if (w.last_post_id === null) continue; // first check — skip all
                        if (newSeenIds.includes(post.id)) continue;
                        newSeenIds = [...new Set([post.id, ...newSeenIds])].slice(0, 20);
                        updated = true;
                        if (shouldNotify(w, post)) toNotify.push(post);
                    }
                    // Live posts keep their own message-edit tracking (see markStreamOffline
                    // below) and always send individually — batching only applies to regular
                    // posts/VODs, never to "went live" events.
                    for (const post of toNotify.filter(p => p.isLive)) {
                        const sent = await sendNotification(w, post);
                        if (sent) await setWatchLiveMessage(w.id, sent.id);
                    }
                    toNotify.filter(p => !p.isLive).forEach(p => batch.add(w, p));
                    // Stream-ended detection: we were tracking a "went live" message, but this
                    // poll's results no longer include a live entry — edit that message to
                    // show it ended instead of leaving it saying "is live" forever. (No-op for
                    // Instagram/TikTok posts, which never set isLive in the first place.)
                    if (!posts.some(p => p.isLive) && w.live_message_id) await markStreamOffline(w);
                    if (w.last_post_id === null && posts.length) {
                        // Seed baseline from first check
                        await updateLastPost(w.id, posts[0].id, posts.map(p => p.id));
                    } else if (updated) {
                        await updateLastPost(w.id, newSeenIds[0], newSeenIds, true);
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else {
                    const post = await fetchLatestPost(w.platform, w.handle);
                    if (!post || !post.id) { await touchLastChecked(w.id); continue; }
                    if (w.last_post_id === null) {
                        await updateLastPost(w.id, post.id, seenIds);
                        continue;
                    }
                    if (seenIds.includes(post.id)) { await touchLastChecked(w.id); continue; }
                    await updateLastPost(w.id, post.id, seenIds, true);
                    if (!shouldNotify(w, post)) continue;
                    batch.add(w, post);
                }
            } catch (e) {
                if (/HTTP 429/.test(e.message)) {
                    console.warn(`poll ${w.platform}/${w.handle}: rate-limited (429), retrying next cycle`);
                } else {
                    console.error(`poll ${w.platform}/${w.handle}:`, e.message);
                }
                await touchLastChecked(w.id, e.message).catch(() => {});
            }
            // Stagger with jitter to avoid hammering platforms all at once
            const jitter = 1000 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, jitter));
        }
        await batch.flush();
    } finally {
        pollInProgress[lockKey] = false;
    }
}

// ── Embeds / UI builders ──────────────────────────────────────────────────
const refreshBtn = (id) => new ButtonBuilder().setCustomId(id).setLabel('↻ Refresh').setStyle(ButtonStyle.Secondary);

async function buildWatchListEmbed(guildId) {
    const watches = await getWatches(guildId);
    if (!watches.length) {
        return { embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setDescription('No accounts are being tracked yet. Use `/social add` to add one.')], components: [] };
    }
    const STALE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Social Media Watches').setTimestamp()
        .setDescription(`Tracking **${watches.length}** account${watches.length > 1 ? 's' : ''}.`);
    for (const w of watches.slice(0, 25)) {
        const p = PLATFORMS[w.platform];
        const lines = [
            `Posts to <#${w.channel_id}>`,
            `ID: \`${w.id}\``,
            w.message_template ? `Custom message: \`${w.message_template.slice(0, 80)}${w.message_template.length > 80 ? '…' : ''}\`` : 'Using default message',
        ];
        if (w.last_post_at) {
            lines.push(`Last post: <t:${Math.floor(w.last_post_at / 1000)}:R>`);
        } else if (w.last_post_id === null) {
            lines.push('Last post: not checked yet');
        } else {
            lines.push('Last post: none detected yet');
        }
        if (w.role_id) lines.push(`Ping: <@&${w.role_id}>`);
        if (!w.active) lines.push('⏸️ Paused');
        if (w.last_error) {
            lines.push(`⚠️ Last check failed: \`${String(w.last_error).slice(0, 150)}\``);
        } else if (w.last_post_at && (Date.now() - w.last_post_at) > STALE_MS) {
            lines.push(`⚠️ No new posts in over 60 days`);
        }
        if (p.unavailable) {
            // "Greyed out" look — embeds can't apply literal text color, so we use the
            // smaller/dimmer subtext style plus a clear label instead.
            lines.push(`-# ⚠️ ${p.label} is currently unavailable — see \`/help\` → Info for why.`);
            embed.addFields({
                name: `${p.emojiTag} ${p.label} — ${w.handle} *(unavailable)*${w.active ? '' : ' (paused)'}`,
                value: lines.join('\n'),
                inline: false,
            });
            continue;
        }
        embed.addFields({
            name: `${p.emojiTag} ${p.label} — ${w.handle}${w.active ? '' : ' (paused)'}`,
            value: lines.join('\n'),
            inline: false,
        });
    }
    if (watches.length > 25) embed.setFooter({ text: `Showing first 25 of ${watches.length}` });
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallist_manage_${guildId}`).setPlaceholder('Manage a watch…')
                .addOptions(watches.slice(0, 25).map(w => ({
                    label: `${PLATFORMS[w.platform].label}${PLATFORMS[w.platform]?.unavailable ? ' (unavailable)' : ''} — ${w.handle}`.slice(0, 100),
                    value: `${w.id}`,
                    emoji: PLATFORMS[w.platform]?.emojiButton,
                })))
        ),
        new ActionRowBuilder().addComponents(refreshBtn(`sociallist_refresh_${guildId}`)),
    ];
    return { embeds: [embed], components };
}

async function buildSocialLinksEmbed(guildId) {
    const igLinks = await getSocialLinks(guildId, 'instagram');
    const ttLinks = await getSocialLinks(guildId, 'tiktok');
    const allLinks = [...igLinks, ...ttLinks];
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Linked Accounts').setTimestamp()
        .setDescription('Accounts authorized via `/social link` in this server. Only these can be added with `/social add`.')
        .addFields(
            { name: '📸 Instagram', value: igLinks.length ? igLinks.map(l => `• ${l.external_username} (linked by ${l.linked_by})`).join('\n') : '*(none linked)*' },
            { name: '🎵 TikTok', value: ttLinks.length ? ttLinks.map(l => `• ${l.external_username} (linked by ${l.linked_by})`).join('\n') : '*(none linked)*' },
        );
    if (!allLinks.length) return { embeds: [embed], components: [] };
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallinks_manage_${guildId}`).setPlaceholder('Manage a linked account…')
                .addOptions(allLinks.slice(0, 25).map(l => ({
                    label: `${PLATFORMS[l.platform].label} — ${l.external_username}`.slice(0, 100),
                    value: `${l.platform}:${l.id}`,
                    emoji: PLATFORMS[l.platform]?.emojiButton,
                })))
        ),
        new ActionRowBuilder().addComponents(refreshBtn(`sociallinks_refresh_${guildId}`)),
    ];
    return { embeds: [embed], components };
}

function buildSocialLinkManageView(link) {
    const p = PLATFORMS[link.platform];
    const embed = new EmbedBuilder().setColor(p.color).setTitle(`Manage Link — ${p.emojiTag} ${link.external_username}`).setTimestamp()
        .addFields(
            { name: 'Platform', value: p.label, inline: true },
            { name: 'Linked by', value: link.linked_by, inline: true },
        );
    const components = [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sociallinkmanage_unlink_${link.platform}_${link.id}`).setLabel('Unlink').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sociallinkmanage_back_${link.guild_id}`).setLabel('← Back to List').setStyle(ButtonStyle.Secondary),
    )];
    return { embeds: [embed], components };
}


// single message_template and haven't been reviewed/edited since.
function isLegacyMessageFormat(w) {
    return !!w.legacy_migrated;
}

// Shared modal builder used both from the manage view's "Per-Type Messages"
// button and from the new guided /social add flow, so both stay in sync.
function buildPerTypeMessageModal(w) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const modal = new ModalBuilder().setCustomId(`socialpertype_modal_${w.id}`).setTitle(`Per-Type Messages — ${w.handle}`.slice(0, 45));
    // Discord modals support at most 5 text inputs — every platform we support has ≤3 notify types, so this always fits.
    modal.addComponents(
        ...types.slice(0, 5).map(t => new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId(`tmpl_${t.id}`).setLabel(`Message for ${t.label} (blank = default)`)
                .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                .setValue(templates[t.id] || '')
                .setPlaceholder(t.id === 'live'
                    ? '{author} {is/was} live on {platform}!\n{url}'
                    : '{author} just posted on {platform}!\n{url}')
        ))
    );
    return modal;
}

function buildManageView(w) {
    const p = PLATFORMS[w.platform];
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const perTypeLines = types.filter(t => templates[t.id]).map(t => `**${t.label}:** \`${templates[t.id].slice(0, 80)}\``);
    const embed = new EmbedBuilder().setColor(p.color).setTitle(`Manage — ${p.emojiTag} ${w.handle}`).setTimestamp()
        .addFields(
            { name: 'Channel', value: `<#${w.channel_id}>`, inline: true },
            { name: 'Status', value: w.active ? '▶️ Active' : '⏸️ Paused', inline: true },
            { name: 'Ping role', value: w.role_id ? `<@&${w.role_id}>` : 'None', inline: true },
            { name: 'Notify types', value: (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types.map(t => PLATFORM_NOTIFY_TYPES[w.platform]?.find(x => x.id === t)?.label || t).join(', ') : 'All types', inline: true },
            { name: 'Default message', value: w.message_template ? `\`${w.message_template}\`` : `Default: \`${DEFAULT_TEMPLATE}\`` },
        );
    if (perTypeLines.length) embed.addFields({ name: 'Per-type message overrides', value: perTypeLines.join('\n') });
    embed.addFields({ name: 'Placeholders', value: PLACEHOLDER_HELP });
    if (p.unavailable) {
        embed.addFields({ name: '⚠️ Currently unavailable', value: `${p.label} isn't working right now — see \`/help\` → Info for why. Notifications won't fire until this is resolved, but everything here stays saved.` });
    }
    if (isLegacyMessageFormat(w)) {
        embed.addFields({ name: '⚠️ Outdated message', value: 'This message was auto-migrated from the old single-message format and hasn\'t been reviewed. It was written as one generic message and may not read well for every post type — check each type below (**Per-Type Messages**) and edit as needed.' });
    }
    // A watch can only ever contribute to a batch if at least one of its active
    // notify types isn't "live" — live events always send individually (see
    // pollAll), so a Kick watch (live-only) or a YouTube watch restricted to
    // just Live can never actually batch, regardless of platform.
    const nonLiveTypes = types.filter(t => t.id !== 'live');
    const activeTypeIds = (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types : types.map(t => t.id);
    const canBatch = nonLiveTypes.length > 0 && activeTypeIds.some(id => id !== 'live');
    if (canBatch) embed.addFields({ name: 'Batch header', value: w.batch_header_template ? `\`${w.batch_header_template}\`` : `Default: \`${DEFAULT_BATCH_HEADER}\`` });
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_msg_${w.id}`).setLabel('Edit Message').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`socialmanage_channel_${w.id}`).setLabel('Change Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_role_${w.id}`).setLabel('Set/Clear Ping Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_types_${w.id}`).setLabel('Edit Types').setStyle(ButtonStyle.Secondary),
        ...(types.length > 1 ? [new ButtonBuilder().setCustomId(`socialpertype_open_${w.id}`).setLabel('Per-Type Messages').setStyle(ButtonStyle.Secondary)] : []),
    );
    const row1b = canBatch ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_batchheader_${w.id}`).setLabel('📦 Batch Header').setStyle(ButtonStyle.Secondary),
    )] : [];
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_toggle_${w.id}`).setLabel(w.active ? 'Pause' : 'Resume').setStyle(w.active ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`socialmanage_remove_${w.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`socialmanage_back_${w.guild_id}`).setLabel('← Back to List').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, ...row1b, row2] };
}

// ── Help (tabbed) ────────────────────────────────────────────────────────
const HELP_CATEGORIES = [
    {
        id: 'general', emoji: '🏠', label: 'General',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle('🔔 Notifyer Beta — General')
            .setDescription('Get notified in a channel whenever a tracked account posts new content or goes live.')
            .addFields(
                { name: '/setup', value: 'New here? A quick walkthrough of what this bot does, with a guided flow to add your first tracked account.' },
                { name: '/help', value: 'Shows this menu.' },
                { name: '/invite', value: 'Get a link to invite this bot to another server.' },
            ),
    },
    {
        id: 'tracking', emoji: '📡', label: 'Tracking',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle('🔔 Notifyer Beta — Tracking')
            .addFields(
                { name: '/social add', value: 'Track a new account. Choose a platform, enter the handle/URL, and pick a channel — you\'ll then choose notification types and set the message. Instagram/TikTok accounts must be linked first (see the Linking tab).' },
                { name: '/social list', value: 'View all tracked accounts. Pick one from the dropdown to manage it: edit message, change channel, set a ping role, pause/resume, or remove.' },
                { name: '/social preview', value: 'See exactly what a notification will look like for a tracked account, one preview per notify type, without waiting for a real post.' },
                { name: '/social check', value: 'Force an immediate check of all tracked accounts.' },
                { name: '📦 Batched notifications', value: 'If 3+ new posts land in the same channel for the same platform in one check — whether from one account or several tracked accounts posting at once — they\'re combined into a single message instead of one ping per post: a header line, then a compact title+button per post. With multiple accounts involved the header lists them (e.g. "A and B posted 4 times!"); with just one, that watch\'s custom header (set from its manage view, "📦 Batch Header") is used. "Went live" notifications are never batched.' },
            ),
    },
    {
        id: 'linking', emoji: '🔗', label: 'Linking',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle('🔔 Notifyer Beta — Linking')
            .setDescription('Instagram and TikTok only expose their APIs through per-account OAuth consent — an account has to explicitly authorize this bot before it can be tracked.')
            .addFields(
                { name: '/social link', value: 'Connect an Instagram or TikTok account via OAuth so it can be tracked. Sends a link the account owner clicks and logs in with.' },
                { name: '/social links', value: 'View accounts linked via OAuth in this server. Pick one from the dropdown to unlink it — revokes the token with TikTok directly; for Instagram it removes our local copy (the account owner can also pull access from Instagram\'s own settings).' },
            ),
    },
    {
        id: 'settings', emoji: '⚙️', label: 'Settings',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle('🔔 Notifyer Beta — Settings')
            .addFields(
                { name: '/social access', value: 'Set which role (besides admins) can manage social notifications in this server.' },
            ),
    },
    {
        id: 'info', emoji: 'ℹ️', label: 'Info',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle('🔔 Notifyer Beta — Info')
            .addFields(
                { name: 'Supported platforms', value: Object.values(PLATFORMS).map(p => `${p.emojiTag} ${p.label}${p.unavailable ? ' ⚠️' : ''}`).join('  ·  ') },
                { name: 'Placeholders', value: 'Custom messages support `{author}`, `{handle}`, `{platform}`, `{title}`, and `{url}`. For Live messages specifically, `{is/was}` renders as "is" when the stream starts and "was" once it ends — so one message works for both.' },
                { name: 'Notes', value: 'TikTok, Instagram, Twitch, and Kick are checked about every 20 seconds; YouTube and Twitter are checked every 2 minutes (they rely on unofficial/scraped access, which needs a gentler pace). New watches start tracking from the next post onward (no notification for existing content). Twitter relies on unofficial scraping and may occasionally fail or lag.' },
                { name: 'Legal', value: `[Terms of Service](${LEGAL_BASE_URL}/terms) • [Privacy Policy](${LEGAL_BASE_URL}/privacy)` },
                { name: 'Links', value: `[GitHub](https://github.com/DaniBottoni/Notifyer/tree/main) • [top.gg](https://top.gg/bot/1515779889737896006)` },
            ),
    },
    {
        id: 'admin', emoji: '🔧', label: 'Admin',
        build: () => new EmbedBuilder().setColor('#ED4245').setTitle('🔔 Notifyer Beta — Admin')
            .setDescription('These commands are gated to the bot owner (`BOT_OWNER_ID`) and mainly exist for debugging this beta build.')
            .addFields(
                { name: '/social debug', value: 'Show a watch\'s live fetch result vs its stored baseline, to check whether it\'d fire a notification.' },
                { name: '/social oauthdebug', value: 'Show the exact OAuth config (client ID, redirect URI, scope, full authorize URL) currently being sent for a platform.' },
                { name: '/killbot', value: 'Suspend the Render service to stop usage/billing. Falls back to crashing the process if RENDER_API_KEY/RENDER_SERVICE_ID aren\'t set.' },
            ),
    },
];
// ── /setup wizard ────────────────────────────────────────────────────────
function buildSetupIntroEmbed() {
    return new EmbedBuilder().setColor('#5865F2').setTitle('👋 Welcome to Notifyer!')
        .setDescription(
            'This bot posts in a channel here whenever a tracked account uploads, posts, or goes live.\n\n' +
            '**Supported platforms:** YouTube, Twitter/X, Twitch, Kick, Instagram, TikTok.\n\n' +
            '**Key commands, once you\'re set up:**\n' +
            '`/social add` — track another account\n' +
            '`/social list` — see everything you\'re tracking, with a manage menu for each\n' +
            '`/social preview` — see what a notification will look like before it fires\n' +
            '`/help` — full command reference and troubleshooting\n\n' +
            'Ready to add your first tracked account?'
        );
}
function buildSetupReturningEmbed(count) {
    return new EmbedBuilder().setColor('#5865F2').setTitle('👋 Notifyer setup')
        .setDescription(
            `This server is already tracking **${count}** account${count > 1 ? 's' : ''}. Use \`/social list\` to manage them, or add another below.\n\n` +
            '`/social add` — track a new account\n`/social preview` — see what a notification will look like\n`/help` — full command reference'
        );
}
function buildSetupIntroRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_start').setLabel('🚀 Add a tracked account').setStyle(ButtonStyle.Primary)
    );
}

function buildHelpView(activeId) {
    const active = HELP_CATEGORIES.find(c => c.id === activeId) || HELP_CATEGORIES[0];
    const buttons = HELP_CATEGORIES.map(c => new ButtonBuilder()
        .setCustomId(`help_cat_${c.id}`)
        .setLabel(c.label)
        .setEmoji(c.emoji)
        .setStyle(c.id === active.id ? ButtonStyle.Primary : ButtonStyle.Secondary));
    // Chunk into rows of up to 5 buttons (Discord's per-row limit)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return { embeds: [active.build()], components: rows };
}

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
    console.log(`✅ Social notify bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Refreshing social media for new posts', type: ActivityType.Watching }], status: 'online' });
    const commands = [
        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to another server'),
        new SlashCommandBuilder().setName('help').setDescription('View commands and features'),
        new SlashCommandBuilder().setName('setup').setDescription('New here? Get a quick walkthrough and set up your first tracked account'),
        new SlashCommandBuilder().setName('social').setDescription('Manage social media notifications')
            .addSubcommand(s => s.setName('add').setDescription('Track a new account')
                .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true).setAutocomplete(true))
                .addStringOption(o => o.setName('handle').setDescription('Username, handle, or profile URL').setRequired(true))
                .addChannelOption(o => o.setName('channel').setDescription('Channel to post notifications in').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
            .addSubcommand(s => s.setName('list').setDescription('View tracked accounts'))
            .addSubcommand(s => s.setName('preview').setDescription('Preview what a tracked account\'s notifications will look like'))
            .addSubcommand(s => s.setName('check').setDescription('Force an immediate check of all tracked accounts'))
            .addSubcommand(s => s.setName('debug').setDescription('Show live fetch result vs stored baseline for a watch')
                .addIntegerOption(o => o.setName('id').setDescription('Watch ID (see /social list)').setRequired(true)))
            .addSubcommand(s => s.setName('link').setDescription('Connect an Instagram or TikTok account via OAuth so it can be tracked')
                .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                    .addChoices({ name: '📸 Instagram', value: 'instagram' }, { name: '🎵 TikTok', value: 'tiktok' })))
            .addSubcommand(s => s.setName('links').setDescription('View accounts linked via OAuth in this server'))
            .addSubcommand(s => s.setName('oauthdebug').setDescription('Owner only: show the exact OAuth config being sent to a platform')
                .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                    .addChoices({ name: '📸 Instagram', value: 'instagram' }, { name: '🎵 TikTok', value: 'tiktok' })))
            .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications')),
        new SlashCommandBuilder().setName('killbot').setDescription('Owner only: suspend the Render service to stop usage'),
    ];
    await client.application.commands.set(commands).catch(e => console.error('command registration:', e));

    // Start polling — two independent cadences, see FAST/SLOW_POLL_* above.
    pollAll(FAST_POLL_PLATFORMS).catch(e => console.error('initial fast poll:', e.message));
    pollAll(SLOW_POLL_PLATFORMS).catch(e => console.error('initial slow poll:', e.message));
    setInterval(() => pollAll(FAST_POLL_PLATFORMS).catch(e => console.error('fast poll loop:', e.message)), FAST_POLL_INTERVAL_MS);
    setInterval(() => pollAll(SLOW_POLL_PLATFORMS).catch(e => console.error('slow poll loop:', e.message)), SLOW_POLL_INTERVAL_MS);

    // Announce the support server to existing guilds, once each.
    for (const guild of client.guilds.cache.values()) {
        try {
            const cfg = await getConfig(guild.id);
            if (cfg.supportAnnounced) continue;
            await announceSupportServer(guild);
            cfg.supportAnnounced = true;
            saveConfig(guild.id, cfg);
        } catch (e) {
            console.error(`support announce (${guild.id}):`, e.message);
        }
        await new Promise(r => setTimeout(r, 1000)); // light stagger to avoid rate limits
    }

    // One-time update to servers with Twitter watches that it's fully back.
    await announceTwitterRestoredGuilds();
    // One-time heads-up to servers still on the legacy message format about the October migration.
    await announceLegacyMigrationGuilds();
});

client.on('guildCreate', async (guild) => {
    try {
        const cfg = await getConfig(guild.id);
        if (cfg.supportAnnounced) return;
        await announceSupportServer(guild);
        cfg.supportAnnounced = true;
        saveConfig(guild.id, cfg);
    } catch (e) {
        console.error(`guildCreate announce (${guild.id}):`, e.message);
    }
});

// ── Interaction handling ────────────────────────────────────────────────────
const pendingMessageEdits = new Map(); // userId_watchId -> { guildId }

client.on('interactionCreate', async interaction => {
  try {
    const guildId = interaction.guild?.id;
    if (!guildId) return;
    const reply = (payload) => {
        const opts = typeof payload === 'string' ? { content: payload, flags: [MessageFlags.Ephemeral] } : payload;
        return interaction.replied || interaction.deferred ? interaction.editReply(opts) : interaction.reply(opts);
    };

    if (interaction.isAutocomplete()) {
        if (interaction.commandName === 'social' && interaction.options.getSubcommand() === 'add') {
            const focused = interaction.options.getFocused().toLowerCase();
            const ownerHere = isOwner(interaction.user.id);
            const choices = Object.entries(PLATFORMS)
                .filter(([, v]) => !v.unavailable || (v.ownerOnly && ownerHere))
                .map(([k, v]) => ({ name: `${v.emoji} ${v.label}`, value: k }))
                .filter(c => c.name.toLowerCase().includes(focused));
            return interaction.respond(choices.slice(0, 25));
        }
        return interaction.respond([]);
    }

    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        if (commandName === 'invite') {
            const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${client.user.id}&permissions=2147485696&scope=bot%20applications.commands`;
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setLabel('Invite Notifyer').setStyle(ButtonStyle.Link).setURL(inviteUrl)
            );
            return reply({ embeds: [E('#5865F2', 'Invite Social Notify Bot').setDescription('Click below to invite this bot to another server.')], components: [row], flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'help') {
            return reply({ ...buildHelpView('general'), flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'setup') {
            const watches = await getWatches(guildId);
            const embed = watches.length ? buildSetupReturningEmbed(watches.length) : buildSetupIntroEmbed();
            return reply({ embeds: [embed], components: [buildSetupIntroRow()], flags: [MessageFlags.Ephemeral] });
        }

        if (commandName === 'social') {
            const sub = interaction.options.getSubcommand();

            if (sub === 'access') {
                if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return reply('❌ Only administrators can change access settings.');
                await interaction.reply({
                    embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('🔒 Access Configuration').setDescription('Select which role should have access to `/social` commands.\n\n**Note:** Server administrators always have access.').setFooter({ text: 'Select a role from the dropdown below' })],
                    components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`social_access_role_${guildId}`).setPlaceholder('Select a role for access').setMinValues(1).setMaxValues(1))],
                    flags: [MessageFlags.Ephemeral],
                });
                return;
            }

            if (!await hasCommandPermission(interaction, guildId)) return reply('❌ No permission. An administrator must configure access with `/social access`.');

            if (sub === 'add') {
                const platform = interaction.options.getString('platform');
                const rawHandle = interaction.options.getString('handle');
                const channel = interaction.options.getChannel('channel');
                const bypassUnavailable = Boolean(PLATFORMS[platform]?.ownerOnly && isOwner(interaction.user.id));

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const result = await createWatchFlow(guildId, platform, rawHandle, channel.id, interaction.user.tag, bypassUnavailable);
                if (!result.ok) return interaction.editReply(result.message);

                const { embeds, components } = buildAddWatchSuccessResponse(result.watch, result.post, result.handle, channel);
                await interaction.editReply({ embeds, components });
                return;
            }

            if (sub === 'list') {
                const { embeds, components } = await buildWatchListEmbed(guildId);
                return reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
            }

            if (sub === 'preview') {
                const watches = await getWatches(guildId);
                if (!watches.length) return reply('❌ No accounts are being tracked yet. Use `/social add` first.');
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId(`socialpreview_pick_${guildId}`).setPlaceholder('Pick a watch to preview…')
                        .addOptions(watches.slice(0, 25).map(w => ({
                            label: `${PLATFORMS[w.platform]?.label || w.platform} — ${w.handle}`.slice(0, 100),
                            value: `${w.id}`,
                            emoji: PLATFORMS[w.platform]?.emojiButton,
                        })))
                );
                return reply({ content: 'Select a watch to preview its notification(s):', components: [row], flags: [MessageFlags.Ephemeral] });
            }

            if (sub === 'check') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                await pollAll();
                return interaction.editReply('✅ Checked all tracked accounts for new posts.');
            }

            if (sub === 'debug') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const id = interaction.options.getInteger('id');
                const watches = await getWatches(guildId);
                const w = watches.find(x => x.id === id);
                if (!w) return interaction.editReply(`❌ No watch with ID \`${id}\` in this server. Use \`/social list\` to see IDs.`);

                let post = null, fetchError = null;
                try {
                    if (w.platform === 'twitch') post = (await fetchLatestTwitchAll(w.handle))[0] || null;
                    else if (w.platform === 'kick') post = (await fetchLatestKickAll(w.handle))[0] || null;
                    else if (w.platform === 'instagram' || w.platform === 'tiktok') {
                        if (!w.social_link_id) throw new Error('Not linked — run /social link first.');
                        const link = await getSocialLinkById(w.social_link_id);
                        if (!link) throw new Error('Linked account no longer found — re-link with /social link.');
                        post = (w.platform === 'instagram' ? (await fetchLatestInstagramAll(link)) : (await fetchLatestTikTokAll(link)))[0] || null;
                    } else {
                        post = await fetchLatestPost(w.platform, w.handle);
                    }
                }
                catch (e) { fetchError = e.message; }

                const embed = E('#5865F2', `Debug — ${PLATFORMS[w.platform].label} ${w.handle}`)
                    .addFields(
                        { name: 'Most recent post ID', value: w.last_post_id ? `\`${w.last_post_id}\`` : '*(none yet)*' },
                        { name: 'Recently seen IDs', value: Array.isArray(w.seen_post_ids) && w.seen_post_ids.length ? w.seen_post_ids.slice(0, 10).map(id => `\`${id}\``).join(', ') : '*(none yet)*' },
                        { name: 'Last checked', value: w.last_checked ? `<t:${Math.floor(w.last_checked / 1000)}:R>` : '*(never)*' },
                    );
                if (fetchError) {
                    embed.addFields({ name: 'Live fetch', value: `❌ Error: ${fetchError}` }).setColor('#ff0000');
                } else if (!post) {
                    embed.addFields({ name: 'Live fetch', value: '⚠️ Returned no post (account empty or unparsable).' });
                } else {
                    const alreadySeen = Array.isArray(w.seen_post_ids) && w.seen_post_ids.includes(post.id);
                    embed.addFields(
                        { name: 'Live fetch — latest post ID', value: `\`${post.id}\`` },
                        { name: 'Already notified for this?', value: alreadySeen ? '✅ Yes — no notification will fire' : '🆕 New — notification should fire on next poll/check' },
                        { name: 'Live post', value: post.title ? `[${post.title.slice(0, 150)}](${post.url})` : (post.url || 'N/A') },
                    );
                }
                return interaction.editReply({ embeds: [embed] });
            }

            if (sub === 'link') {
                const platform = interaction.options.getString('platform');
                const cfg = OAUTH_CONFIG[platform];
                if (!cfg.clientId || !cfg.clientSecret) {
                    return reply(`❌ ${PLATFORMS[platform].label} OAuth isn't configured on this bot yet (missing app credentials env vars). Ask the bot owner to set them up.`);
                }
                if (!PUBLIC_BASE_URL) {
                    return reply('❌ PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) isn\'t set, so OAuth redirects have nowhere to go. Ask the bot owner to configure it.');
                }
                const { state, expires } = createOAuthState(guildId, interaction.user.id, platform);
                const authUrl = `${cfg.authUrl}?${cfg.clientIdParam}=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&scope=${encodeURIComponent(cfg.scope)}&response_type=code&state=${state}`;
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel(`Authorize with ${PLATFORMS[platform].label}`).setStyle(ButtonStyle.Link).setURL(authUrl)
                );
                return reply({
                    embeds: [E('#5865F2', `Link ${PLATFORMS[platform].label}`).setDescription(`Click below and log in with the **${PLATFORMS[platform].label} account you want this bot to track**. That account has to authorize this app — the bot can't watch accounts that haven't consented.\n\nThis link expires <t:${Math.floor(expires / 1000)}:R>.`)],
                    components: [row],
                    flags: [MessageFlags.Ephemeral],
                });
            }

            if (sub === 'links') {
                const { embeds, components } = await buildSocialLinksEmbed(guildId);
                return reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
            }

            if (sub === 'oauthdebug') {
                const ownerId = process.env.BOT_OWNER_ID;
                if (!ownerId || interaction.user.id !== ownerId) {
                    return reply('❌ This command is owner-only (it can reveal partial app credentials).');
                }
                const platform = interaction.options.getString('platform');
                const cfg = OAUTH_CONFIG[platform];
                const maskedSecret = cfg.clientSecret ? `${cfg.clientSecret.slice(0, 4)}${'*'.repeat(Math.max(0, cfg.clientSecret.length - 8))}${cfg.clientSecret.slice(-4)}` : '(not set)';
                const { state } = createOAuthState(guildId, interaction.user.id, platform);
                const authUrl = `${cfg.authUrl}?${cfg.clientIdParam}=${encodeURIComponent(cfg.clientId || '')}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&scope=${encodeURIComponent(cfg.scope)}&response_type=code&state=${state}`;
                const embed = E('#5865F2', `OAuth Debug — ${PLATFORMS[platform].label}`).setDescription(
                    'This is exactly what the bot is sending right now, read live from environment variables — compare each value character-by-character against the platform\'s developer dashboard.'
                ).addFields(
                    { name: 'client_id (full)', value: `\`${cfg.clientId || '(not set)'}\`` },
                    { name: 'client_secret (masked)', value: `\`${maskedSecret}\`` },
                    { name: 'redirect_uri', value: `\`${cfg.redirectUri}\`` },
                    { name: 'scope', value: `\`${cfg.scope}\`` },
                    { name: 'PUBLIC_BASE_URL resolved to', value: `\`${PUBLIC_BASE_URL || '(empty!)'}\`` },
                    { name: 'Full authorize URL', value: authUrl.length > 1000 ? authUrl.slice(0, 1000) + '…' : authUrl },
                );
                return reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
            }
        }
        if (commandName === 'invite' || commandName === 'help' || commandName === 'social') return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'killbot') {
        const ownerId = process.env.BOT_OWNER_ID;
        if (!ownerId || interaction.user.id !== ownerId) {
            return interaction.reply({ content: '❌ This command is owner-only.', flags: [MessageFlags.Ephemeral] });
        }
        await interaction.reply({ content: '🛑 Suspending the Render service…', flags: [MessageFlags.Ephemeral] });
        const renderKey = process.env.RENDER_API_KEY, serviceId = process.env.RENDER_SERVICE_ID;
        if (renderKey && serviceId) {
            try {
                const { status } = await postJson(`https://api.render.com/v1/services/${serviceId}/suspend`, {}, { Authorization: `Bearer ${renderKey}` });
                if (status >= 200 && status < 300) {
                    await interaction.followUp({ content: '✅ Render service suspended — it will stay off (and stop using hours) until manually resumed from the Render dashboard.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                } else {
                    await interaction.followUp({ content: `⚠️ Render API returned status ${status}. Falling back to crashing the process.`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
                    process.exit(1);
                }
            } catch (e) {
                await interaction.followUp({ content: `⚠️ Render suspend call failed (${e.message}). Falling back to crashing the process.`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
                process.exit(1);
            }
        } else {
            await interaction.followUp({ content: '⚠️ RENDER_API_KEY/RENDER_SERVICE_ID not set, so I can\'t properly suspend the service — just crashing the process instead. Note: on most Render plans this alone gets restarted automatically and will keep using hours. Set those two env vars for a real stop.', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            process.exit(1);
        }
        return;
    }

    // ── Role select: access role ──────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('social_access_role_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: '❌ Only administrators can do this.', flags: [MessageFlags.Ephemeral] });
        const role = interaction.values[0];
        const cfg = await getConfig(guildId);
        cfg.accessRoleId = role; saveConfig(guildId, cfg);
        return interaction.update({ embeds: [E('#00ff00', '✅ Access Updated').setDescription(`<@&${role}> can now manage social notifications.`)], components: [] });
    }

    // ── Buttons: /help category tabs ─────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('help_cat_')) {
        const catId = interaction.customId.slice(9);
        return interaction.update(buildHelpView(catId));
    }

    // ── Buttons: refresh list ───────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sociallist_refresh_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = await buildWatchListEmbed(guildId);
        return interaction.update({ embeds, components });
    }

    // ── Button: "View My Watches" from the legacy-migration announcement — same
    // output as running /social list, replied ephemerally to whoever clicked it. ──
    if (interaction.isButton() && interaction.customId === 'legacymigration_viewwatches') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = await buildWatchListEmbed(guildId);
        return interaction.reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
    }

    // ── Buttons: refresh linked-accounts list ───────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sociallinks_refresh_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = await buildSocialLinksEmbed(guildId);
        return interaction.update({ embeds, components });
    }

    // ── Select: open manage view for a linked account ───────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallinks_manage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const [platform, idStr] = interaction.values[0].split(':');
        const link = await getSocialLinkById(parseInt(idStr, 10));
        if (!link || link.guild_id !== guildId || link.platform !== platform) {
            return interaction.reply({ content: '❌ Linked account not found (it may have been removed).', flags: [MessageFlags.Ephemeral] });
        }
        const { embeds, components } = buildSocialLinkManageView(link);
        return interaction.update({ embeds, components });
    }

    // ── Buttons: linked-account manage view actions ─────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sociallinkmanage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const parts = interaction.customId.split('_'); // sociallinkmanage_<action>_[platform_]<id>
        const action = parts[1];

        if (action === 'back') {
            const { embeds, components } = await buildSocialLinksEmbed(guildId);
            return interaction.update({ embeds, components });
        }

        if (action === 'unlink') {
            const platform = parts[2];
            const id = parseInt(parts[3], 10);
            const link = await getSocialLinkById(id);
            if (!link || link.guild_id !== guildId) {
                const { embeds, components } = await buildSocialLinksEmbed(guildId);
                return interaction.update({ content: '❌ Linked account not found (it may have already been removed).', embeds, components });
            }

            let revokeNote = '';
            if (platform === 'tiktok') {
                const result = await revokeTikTokToken(link);
                revokeNote = result.ok
                    ? '\nToken revoked with TikTok — the bot no longer shows in their Manage app permissions page.'
                    : `\n⚠️ Couldn't revoke the token with TikTok (${result.reason}) — removing our local copy anyway, but the account owner may want to remove app access manually from TikTok's app permissions settings.`;
            } else if (platform === 'instagram') {
                // Meta doesn't expose an app-triggered revoke endpoint for this login
                // type — only the account owner can pull access, from Instagram itself.
                revokeNote = '\nInstagram doesn\'t let apps revoke their own tokens — if the account owner wants to fully disconnect on their end too, they can do it from Instagram → Settings → Apps and Websites → Notifyer → Remove.';
            }

            await deleteSocialLink(guildId, id);
            const { embeds, components } = await buildSocialLinksEmbed(guildId);
            return interaction.update({ content: `✅ Unlinked **${link.external_username}** (${PLATFORMS[platform].label}). Any watches for that account are now paused until it's re-linked and re-added.${revokeNote}`, embeds, components });
        }
    }

    // ── Select: open manage view for a watch ────────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallist_manage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.values[0], 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found (it may have been removed).', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Select menu: /social preview watch picker ───────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialpreview_pick_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.values[0], 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', components: [] });
        const p = PLATFORMS[w.platform];
        const types = (PLATFORM_NOTIFY_TYPES[w.platform] || [{ id: null, label: 'Post' }]);
        await interaction.update({ content: `Previewing **${p?.label || w.platform} — ${w.handle}** (${types.length} notify type${types.length > 1 ? 's' : ''}):`, components: [] });
        for (const t of types) {
            const post = buildSamplePost(w, t.id);
            const payload = buildNotificationPayload(w, post);
            const note = payload.wantsNativeVideo
                ? `-# *${t.label}: Discord would normally show a native video/image embed here once posted with a real link.*\n`
                : '';
            await interaction.followUp({
                content: `**— ${t.label} —**\n${note}${payload.content}`,
                embeds: payload.embeds,
                components: payload.components,
                flags: [MessageFlags.Ephemeral],
            }).catch(e => console.error(`social preview followUp (${w.id}, ${t.id}):`, e.message));
        }
        return;
    }

    // ── Buttons: manage view actions ─────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialmanage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const [, action, idStr] = interaction.customId.split('_');

        if (action === 'back') {
            const { embeds, components } = await buildWatchListEmbed(guildId);
            return interaction.update({ embeds, components });
        }

        const id = parseInt(idStr, 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', embeds: [], components: [] });

        if (action === 'msg') {
            const modal = new ModalBuilder().setCustomId(`socialmsg_modal_${id}`).setTitle('Edit Notification Message')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('template').setLabel('Custom message (leave blank for default)')
                            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000)
                            .setValue(w.message_template || '')
                            .setPlaceholder('{author} just posted on {platform}!\n{url}')
                    )
                );
            return interaction.showModal(modal);
        }

        if (action === 'batchheader') {
            const modal = new ModalBuilder().setCustomId(`socialbatchheader_modal_${id}`).setTitle('Edit Batch Header')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder().setCustomId('template').setLabel('Header shown when 3+ posts land at once')
                            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
                            .setValue(w.batch_header_template || '')
                            .setPlaceholder(DEFAULT_BATCH_HEADER)
                    )
                );
            return interaction.showModal(modal);
        }

        if (action === 'channel') {
            return interaction.update({
                embeds: [E('#5865F2', `Change Channel — ${w.handle}`).setDescription('Select the new channel for this watch\'s notifications.')],
                components: [new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder().setCustomId(`socialchannel_select_${id}`).setPlaceholder('Select a channel…')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )],
            });
        }

        if (action === 'role') {
            return interaction.update({
                embeds: [E('#5865F2', `Ping Role — ${w.handle}`).setDescription('Select a role to ping on every notification, or click "Clear Role" to remove it.')],
                components: [
                    new ActionRowBuilder().addComponents(
                        new RoleSelectMenuBuilder().setCustomId(`socialrole_select_${id}`).setPlaceholder('Select a role…')
                    ),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`socialrole_clear_${id}`).setLabel('Clear Role').setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId(`socialmanage_backto_${id}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
                    ),
                ],
            });
        }

        if (action === 'types') {
            const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
            if (types.length <= 1) return interaction.update({ content: 'This platform only has one notification type.', embeds: [], components: [] });
            const current = Array.isArray(w.notify_types) && w.notify_types.length ? w.notify_types : types.map(t => t.id);
            return interaction.update({
                embeds: [E('#5865F2', `Notification Types — ${w.handle}`).setDescription(`Choose which **${PLATFORMS[w.platform].label}** content types to get notified for.`)],
                components: [
                    new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder().setCustomId(`socialtype_select_${id}`)
                            .setPlaceholder('Select types…').setMinValues(1).setMaxValues(types.length)
                            .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description, default: current.includes(t.id) })))
                    ),
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`socialmanage_backto_${id}`).setLabel('← Back').setStyle(ButtonStyle.Secondary),
                    ),
                ],
            });
        }

        if (action === 'toggle') {
            await updateWatchActive(guildId, id, !w.active);
            const updated = await getWatch(guildId, id);
            const { embeds, components } = buildManageView(updated);
            return interaction.update({ embeds, components });
        }

        if (action === 'remove') {
            let unlinkNote = '';
            if (w.social_link_id) {
                // A linked account can be tracked into more than one channel — only
                // unlink if no OTHER watch still references it, so removing one
                // doesn't silently break a sibling watch of the same account.
                const guildWatches = await getWatches(guildId);
                const stillUsed = guildWatches.some(other => other.id !== w.id && other.social_link_id === w.social_link_id);
                if (!stillUsed) {
                    const link = await getSocialLinkById(w.social_link_id);
                    if (link) {
                        if (w.platform === 'tiktok') {
                            const result = await revokeTikTokToken(link);
                            unlinkNote = result.ok
                                ? '\nAlso unlinked the TikTok account (token revoked with TikTok) since no other watches were using it.'
                                : `\nAlso unlinked the TikTok account locally, though revoking the token with TikTok failed (${result.reason}) — the account owner may want to remove app access manually from TikTok's app permissions settings.`;
                        } else if (w.platform === 'instagram') {
                            unlinkNote = '\nAlso unlinked the Instagram account locally since no other watches were using it. Instagram doesn\'t let apps revoke their own tokens — the account owner can fully disconnect from Instagram → Settings → Apps and Websites → Notifyer → Remove.';
                        }
                        await deleteSocialLink(guildId, w.social_link_id);
                    }
                }
            }
            await removeWatch(guildId, id);
            const { embeds, components } = await buildWatchListEmbed(guildId);
            return interaction.update({ content: `✅ Removed ${PLATFORMS[w.platform].label} — ${w.handle}.${unlinkNote}`, embeds, components });
        }

        if (action === 'backto') {
            const { embeds, components } = buildManageView(w);
            return interaction.update({ content: null, embeds, components });
        }
    }

    // ── Select/skip: notification types from the guided /social add flow —
    // chains straight into the per-type message modal instead of just confirming.
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialtypeadd_select_')) {
        const id = parseInt(interaction.customId.slice(21), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, interaction.values);
        const updated = await getWatch(guildId, id);
        return interaction.showModal(buildPerTypeMessageModal(updated));
    }
    if (interaction.isButton() && interaction.customId.startsWith('socialtypeadd_skip_')) {
        const id = parseInt(interaction.customId.slice(19), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, null);
        const updated = await getWatch(guildId, id);
        return interaction.showModal(buildPerTypeMessageModal(updated));
    }

    // ── Select: notification types (post-add and manage flows) ──────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialtype_select_')) {
        const id = parseInt(interaction.customId.slice(18), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, interaction.values);
        const typeNames = interaction.values.map(v => PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === v)?.label || v).join(', ');
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.update({ content: `✅ Notification types set to: **${typeNames}**`, embeds, components });
    }

    // ── Button: skip type selector (all types) ───────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialtype_skip_')) {
        const id = parseInt(interaction.customId.slice(16), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, null);
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.update({ content: '✅ Will notify for all content types.', embeds, components });
    }

    // ── Select: change channel ───────────────────────────────────────────────
    // ── /setup wizard ─────────────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId === 'setup_start') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const ownerHere = isOwner(interaction.user.id);
        const options = Object.entries(PLATFORMS)
            .filter(([, v]) => !v.unavailable || (v.ownerOnly && ownerHere))
            .map(([k, v]) => ({ label: v.label, value: k, emoji: v.emojiButton }));
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('setup_platform_pick').setPlaceholder('Choose a platform…').addOptions(options)
        );
        return interaction.update({ content: 'Which platform is the account on?', embeds: [], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_platform_pick') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const platform = interaction.values[0];
        pendingSetupPicks.set(`${guildId}_${interaction.user.id}`, { platform, expires: Date.now() + SETUP_PICK_TTL_MS });
        const modal = new ModalBuilder().setCustomId('setup_handle_modal').setTitle(`Add a ${PLATFORMS[platform].label} account`)
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('handle').setLabel('Username, handle, or profile URL').setStyle(TextInputStyle.Short).setRequired(true)
            ));
        return interaction.showModal(modal);
    }

    if (interaction.isModalSubmit() && interaction.customId === 'setup_handle_modal') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const key = `${guildId}_${interaction.user.id}`;
        const pending = pendingSetupPicks.get(key);
        if (!pending || pending.expires < Date.now()) {
            pendingSetupPicks.delete(key);
            return interaction.reply({ content: '❌ This setup session expired — run `/setup` again.', flags: [MessageFlags.Ephemeral] });
        }
        const rawHandle = interaction.fields.getTextInputValue('handle').trim();
        pendingSetupPicks.set(key, { ...pending, rawHandle, expires: Date.now() + SETUP_PICK_TTL_MS });
        const row = new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId('setup_channel_pick').setPlaceholder('Choose a channel for notifications…').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        );
        return interaction.reply({ content: `Got it — **${rawHandle}**. Which channel should notifications post to?`, components: [row], flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_channel_pick') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const key = `${guildId}_${interaction.user.id}`;
        const pending = pendingSetupPicks.get(key);
        if (!pending || !pending.rawHandle || pending.expires < Date.now()) {
            pendingSetupPicks.delete(key);
            return interaction.update({ content: '❌ This setup session expired — run `/setup` again.', components: [] });
        }
        pendingSetupPicks.delete(key);
        const channelId = interaction.values[0];
        const channel = interaction.guild.channels.cache.get(channelId);
        await interaction.update({ content: 'Setting that up…', components: [] });
        const bypassUnavailable = Boolean(PLATFORMS[pending.platform]?.ownerOnly && isOwner(interaction.user.id));
        const result = await createWatchFlow(guildId, pending.platform, pending.rawHandle, channelId, interaction.user.tag, bypassUnavailable);
        if (!result.ok) return interaction.editReply({ content: result.message });
        const { embeds, components } = buildAddWatchSuccessResponse(result.watch, result.post, result.handle, channel);
        return interaction.editReply({ content: null, embeds, components });
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('socialchannel_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(21), 10);
        const channelId = interaction.values[0];
        await updateWatchChannel(guildId, id, channelId);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Select: set ping role ────────────────────────────────────────────────
    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('socialrole_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(18), 10);
        const roleId = interaction.values[0];
        await updateWatchRole(guildId, id, roleId);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Button: clear ping role ──────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialrole_clear_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(17), 10);
        await updateWatchRole(guildId, id, null);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Modal: save custom message ──────────────────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialmsg_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(16), 10);
        const template = interaction.fields.getTextInputValue('template').trim() || null;
        await updateWatchTemplate(guildId, id, template);
        await interaction.deferUpdate();
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.editReply({ embeds, components });
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialbatchheader_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(25), 10);
        const template = interaction.fields.getTextInputValue('template').trim() || null;
        await updateWatchBatchHeader(guildId, id, template);
        await interaction.deferUpdate();
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.editReply({ embeds, components });
    }

    // ── Button: open per-post-type custom message popup form ────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialpertype_open_')) {
        const id = parseInt(interaction.customId.slice(19), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        return interaction.showModal(buildPerTypeMessageModal(w));
    }

    // ── Modal: save per-post-type custom messages ────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialpertype_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(20), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
        const updatedTemplates = {};
        for (const t of types.slice(0, 5)) {
            const val = interaction.fields.getTextInputValue(`tmpl_${t.id}`).trim();
            if (val) updatedTemplates[t.id] = val;
        }
        await updateWatchMessageTemplates(guildId, id, updatedTemplates);
        await interaction.deferUpdate();
        const updated = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(updated);
        return interaction.editReply({ embeds, components });
    }

  } catch (error) {
      if (error?.code === 40060) return;
      console.error('❌ Interaction error:', error);
      try {
          const detail = error?.message ? `\n\`\`\`${String(error.message).slice(0, 500)}\`\`\`` : '';
          const content = `❌ Something went wrong.${detail}\nIf this keeps happening, please try again or report it in the support server.`;
          if (interaction.deferred) await interaction.editReply({ content }).catch(() => {});
          else if (!interaction.replied) await interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => {});
      } catch {}
  }
});

(async () => {
    await ensureIPv4Pool();
    try {
        await initDB();
    } catch (e) {
        console.error('⚠️ initDB failed, starting bot anyway:', e.message);
    }
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_TOKEN.trim()) {
        console.error('❌ DISCORD_TOKEN is missing or empty. Set it in this service\'s environment variables and redeploy.');
        process.exit(1);
    }
    try {
        await client.login(process.env.DISCORD_TOKEN.trim());
    } catch (e) {
        console.error('❌ Discord login failed:', e.message, '\nDouble-check DISCORD_TOKEN on this service — copy it fresh from the Developer Portal with no extra whitespace/quotes.');
        process.exit(1);
    }
})();

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));
client.on('error', e => console.error('⚠️ Discord client error:', e));

// ── OAuth code exchange (called from the HTTP callback routes) ────────────
// Uses the newer "Instagram API with Instagram Login" (launched July 2024) — unlike the
// older Facebook Login flow, this does NOT require the account to be linked to a Facebook
// Page. The account just needs to be an Instagram Business/Creator account.
async function exchangeInstagramCode(code) {
    const cfg = OAUTH_CONFIG.instagram;
    // 1. Exchange the auth code for a short-lived Instagram User access token.
    const { json: tokenRes } = await postForm('https://api.instagram.com/oauth/access_token', {
        client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code,
    });
    if (!tokenRes?.access_token) throw new Error(tokenRes?.error_message || tokenRes?.error?.message || 'Instagram token exchange failed');

    // 2. Exchange for a long-lived token (~60 days).
    const { json: longRes } = await fetchJson(
        `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${cfg.clientSecret}&access_token=${encodeURIComponent(tokenRes.access_token)}`
    );
    const accessToken = longRes?.access_token || tokenRes.access_token;
    const expiresIn = longRes?.expires_in || 60 * 24 * 60 * 60;

    // 3. Get the account's own ID + username directly — no Facebook Page lookup needed.
    const { json: profile } = await fetchJson(`https://graph.instagram.com/me?fields=user_id,username&access_token=${encodeURIComponent(accessToken)}`);
    if (!profile?.user_id) throw new Error('Could not fetch the Instagram profile — make sure it\'s a Business or Creator account.');

    return { externalUserId: profile.user_id, externalUsername: profile.username || profile.user_id, accessToken, refreshToken: null, expiresAt: Date.now() + expiresIn * 1000 };
}

async function exchangeTikTokCode(code) {
    const cfg = OAUTH_CONFIG.tiktok;
    const { json } = await postForm('https://open.tiktokapis.com/v2/oauth/token/', {
        client_key: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri,
    });
    if (!json?.access_token) throw new Error(json?.error_description || 'TikTok token exchange failed');
    // GET, not POST — the query string carries `fields`, there's no request body.
    // `username` (needs user.info.profile scope) is the real @handle people type into
    // /social add — display_name is just the shown nickname and often differs from it.
    const { json: userInfo } = await fetchJson('https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,username', { Authorization: `Bearer ${json.access_token}` });
    const username = userInfo?.data?.user?.username || userInfo?.data?.user?.display_name || json.open_id;
    return {
        externalUserId: json.open_id, externalUsername: username,
        accessToken: json.access_token, refreshToken: json.refresh_token,
        expiresAt: Date.now() + (json.expires_in || 86400) * 1000,
    };
}

function htmlResponse(res, status, title, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>${title}</h2><p>${message}</p></body></html>`);
}

// ── YouTube WebSub (PubSubHubbub) callback ──────────────────────────────────
// GET: the hub's subscribe/unsubscribe verification handshake — echo back
// hub.challenge if hub.verify_token matches what we sent when subscribing.
function handleYouTubeWebSubVerify(req, res) {
    const u = new URL(req.url, `https://${req.headers.host}`);
    const mode = u.searchParams.get('hub.mode');
    const challenge = u.searchParams.get('hub.challenge');
    const verifyToken = u.searchParams.get('hub.verify_token');
    if ((mode === 'subscribe' || mode === 'unsubscribe') && verifyToken === WEBSUB_VERIFY_TOKEN && challenge) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(challenge);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
}
// POST: the actual push — an Atom feed with one or more <entry> elements. Each
// entry means "this video is new or was just updated" (a live stream typically
// triggers this the moment it starts). We still share the same seen_post_ids
// dedup as routine polling, so if a poll and a push both catch the same video,
// only the first one to arrive actually sends anything.
async function handleYouTubeWebSubPush(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); // ack immediately, hub expects a quick 2xx
        try {
            const data = xmlParser.parse(body);
            const rawEntries = data?.feed?.entry;
            if (!rawEntries) return;
            const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
            for (const entry of entries) {
                const videoId = entry['yt:videoId'];
                const channelId = entry['yt:channelId'];
                if (!videoId || !channelId) continue;
                const watches = await getWatchesByYouTubeChannel(channelId);
                for (const w of watches) {
                    const seenIds = Array.isArray(w.seen_post_ids) ? w.seen_post_ids : [];
                    if (w.last_post_id === null || seenIds.includes(videoId)) continue; // baseline not seeded yet, or already handled
                    const classified = await classifyYouTubeVideos([videoId]);
                    const c = classified[videoId];
                    const post = {
                        id: videoId,
                        url: c?.postType === 'shorts' ? `https://www.youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`,
                        title: entry.title,
                        author: entry.author?.name,
                        thumbnail: null,
                        timestamp: entry.published,
                        postType: c?.postType || 'videos',
                        isLive: Boolean(c?.isLive),
                    };
                    const mergedSeen = [...new Set([videoId, ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
                    await updateLastPost(w.id, videoId, mergedSeen, true);
                    if (!shouldNotify(w, post)) continue;
                    const sent = await sendNotification(w, post);
                    if (post.isLive && sent) { await setWatchLiveMessage(w.id, sent.id); await setWatchYouTubeLiveVideo(w.id, videoId); }
                }
            }
        } catch (e) {
            console.error('YouTube WebSub push handling:', e.message);
        }
    });
}

async function handleOAuthCallback(platform, req, res) {
    const u = new URL(req.url, `https://${req.headers.host}`);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const oauthError = u.searchParams.get('error');
    const oauthErrorDescription = u.searchParams.get('error_description') || u.searchParams.get('error_reason');
    if (oauthError) return htmlResponse(res, 400, 'Authorization denied', `${platform === 'instagram' ? 'Meta' : 'TikTok'} returned: <code>${oauthError}</code>${oauthErrorDescription ? ` — ${oauthErrorDescription}` : ''}.<br>You can close this tab and run /social link again if this wasn't intentional.`);

    const stateEntry = state ? consumeOAuthState(state) : null;
    if (!stateEntry || stateEntry.platform !== platform) return htmlResponse(res, 400, 'Invalid or expired link', 'Run /social link again in Discord and try once more within 10 minutes.');
    if (!code) return htmlResponse(res, 400, 'Missing authorization code', `${platform === 'instagram' ? 'Meta' : 'TikTok'} redirected back without a code — no query parameters other than what's in the URL bar above were received. Close this tab and run /social link again.`);

    try {
        const identity = platform === 'instagram' ? await exchangeInstagramCode(code) : await exchangeTikTokCode(code);
        await upsertSocialLink({
            guildId: stateEntry.guildId, platform,
            externalUserId: identity.externalUserId, externalUsername: identity.externalUsername,
            accessToken: identity.accessToken, refreshToken: identity.refreshToken, expiresAt: identity.expiresAt,
            linkedBy: stateEntry.userId,
        });
        return htmlResponse(res, 200, 'Linked!', `<b>${identity.externalUsername}</b> is now linked. You can close this tab and go back to Discord, then use <code>/social add</code> to start tracking it.`);
    } catch (e) {
        console.error(`OAuth callback (${platform}):`, e.message);
        return htmlResponse(res, 500, 'Link failed', `${e.message} — you can close this tab and try /social link again.`);
    }
}

// Notifyer's bell-icon logo, inlined as base64 so the site doesn't depend on
// hosting a separate image file — used as both the favicon and the on-page logo.
const NOTIFYER_FAVICON_URI = 'data:image/png;base64,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';
const NOTIFYER_LOGO_URI = 'data:image/png;base64,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';
function legalPage(title, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Notifyer</title>
<link rel="icon" type="image/png" href="${NOTIFYER_FAVICON_URI}">
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a;} .brand{display:flex;align-items:center;gap:10px;margin-bottom:20px;} .brand img{width:36px;height:36px;border-radius:8px;} .brand span{font-weight:600;font-size:1.15em;} h1{margin-bottom:4px;} .updated{color:#666;font-size:0.9em;margin-top:0;} h2{margin-top:28px;} a{color:#5865F2;}</style>
</head><body><div class="brand"><img src="${NOTIFYER_LOGO_URI}" alt="Notifyer logo"><span>Notifyer</span></div>${bodyHtml}</body></html>`;
}

const LEGAL_LAST_UPDATED = 'August 29, 2026';
const LEGAL_CONTACT = process.env.LEGAL_CONTACT_EMAIL || process.env.BOT_OWNER_DISCORD_TAG || 'the bot owner via the support server';

const TERMS_HTML = legalPage('Terms of Service', `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>These Terms govern your use of the Notifyer Discord bot ("the Bot"). By adding the Bot to a server or using its commands, you agree to these Terms.</p>

<h2>What the Bot does</h2>
<p>The Bot watches accounts you configure on YouTube, Twitter/X, Twitch, Instagram, and TikTok, and posts a notification in a Discord channel you choose when those accounts publish new content. For Instagram and TikTok, this only works for accounts that have explicitly authorized the Bot via OAuth (<code>/social link</code>) — the Bot cannot and does not access those platforms' accounts without their consent.</p>

<h2>Acceptable use</h2>
<ul>
<li>You must comply with Discord's <a href="https://discord.com/terms">Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a> while using the Bot.</li>
<li>You must have the right to link any Instagram or TikTok account you connect via <code>/social link</code> — only link accounts you own or are authorized to manage.</li>
<li>Don't use the Bot to spam, harass, or send notifications to channels/servers without appropriate permission.</li>
<li>Don't attempt to abuse, overload, or reverse-engineer the Bot's infrastructure.</li>
</ul>

<h2>No warranty</h2>
<p>The Bot is provided "as is," without warranty of any kind. Notifications may be delayed, missed, or occasionally inaccurate, particularly where the Bot relies on unofficial or rate-limited data sources (e.g. Twitter). We don't guarantee uninterrupted availability.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, the Bot's operator is not liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the Bot.</p>

<h2>Termination</h2>
<p>We may suspend or terminate the Bot's access to your server, or discontinue the Bot entirely, at any time. You can remove the Bot from your server at any time via Discord's server settings.</p>

<h2>Changes</h2>
<p>We may update these Terms from time to time. Continued use of the Bot after changes are posted constitutes acceptance of the revised Terms.</p>

<h2>Contact</h2>
<p>Questions about these Terms can be directed to ${LEGAL_CONTACT}.</p>
`);

const PRIVACY_HTML = legalPage('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>This Privacy Policy explains what data the Notifyer Discord bot ("the Bot") collects and how it's used.</p>

<h2>Data we collect</h2>
<ul>
<li><b>Server configuration:</b> the Discord server (guild) ID, channel IDs, role IDs, and the account handles/URLs you choose to track, along with any custom notification message templates you set.</li>
<li><b>Discord identifiers:</b> the Discord user ID and username of whoever adds a watch or links an account, stored only to show who configured something.</li>
<li><b>OAuth tokens:</b> if you use <code>/social link</code> to connect an Instagram or TikTok account, we store the access token, refresh token, and the linked account's platform user ID/username, so the Bot can check that account for new posts on your behalf.</li>
<li><b>Post metadata:</b> IDs and timestamps of posts already seen, so the Bot doesn't re-notify for the same content.</li>
</ul>
<p>We do not collect message content from your Discord server beyond what's needed to operate slash commands, and we do not read or store the content of DMs.</p>

<h2>How we use data</h2>
<p>Data is used solely to operate the Bot's core function: checking tracked accounts on a schedule and posting notifications to the channel you specify. We do not sell data, use it for advertising, or share it with third parties except the platform APIs (Instagram/TikTok) strictly as needed to fetch posts from accounts you've linked.</p>

<h2>Data retention & deletion</h2>
<p>Watch configurations and linked accounts are retained until you remove them (<code>/social list</code> → Remove, or by revoking a link) or remove the Bot from your server. You can request deletion of any data tied to your server or Discord account by contacting ${LEGAL_CONTACT}.</p>

<h2>Third-party services</h2>
<p>The Bot communicates with Discord's API, and — where you've configured it — YouTube, Twitter/X, Twitch, Meta's Instagram Graph API, and TikTok's API. Each of those platforms has its own privacy policy governing data you share with them directly.</p>

<h2>Security</h2>
<p>OAuth tokens are stored in a private database and are not exposed through any Bot command or public endpoint. No storage method is 100% secure, but we take reasonable steps to protect stored data.</p>

<h2>Children's privacy</h2>
<p>The Bot is not directed at children under 13, consistent with Discord's own age requirements.</p>

<h2>Changes</h2>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

<h2>Contact</h2>
<p>Questions about this policy, or requests to access/delete your data, can be directed to ${LEGAL_CONTACT}.</p>
`);

function buildStatusHTML() {
    const isUp = client.isReady();
    const statusLine = isUp
        ? '<p class="updated">Status: <strong style="color:#3ba55d">● Online</strong></p>'
        : '<p class="updated" style="background:#f8d7da;color:#842029;padding:10px 14px;border-radius:6px;display:inline-block;">🔴 <strong>Bot is currently down</strong> — this page is still up, but the Discord connection is not. Check back shortly.</p>';
    return legalPage('Notifyer — Social Media Notifications for Discord', `
<h1>Notifyer</h1>
${statusLine}
<p style="font-size:1.1em;">Notifyer is a Discord bot that watches creators across YouTube, Twitter/X, Twitch, Kick, Instagram, and TikTok, and posts directly in a channel you choose the moment they upload, post, or go live.</p>

<h2>What it does</h2>
<ul>
<li><strong>Multi-platform tracking</strong> — follow accounts on YouTube, Twitter/X, Twitch, Kick, Instagram, and TikTok from one bot, each with its own channel and settings.</li>
<li><strong>Custom notification messages</strong> — write your own message per platform and per post type (video, short, live, VOD, reel, story, etc.), with placeholders like <code>{author}</code>, <code>{title}</code>, and <code>{url}</code> filled in automatically.</li>
<li><strong>Live stream tracking</strong> — a "went live" message updates itself in place once the stream ends, instead of posting a second message.</li>
<li><strong>Smart batching</strong> — if several posts land at once (one prolific account, or several tracked accounts posting in the same channel back to back), they're combined into a single tidy message instead of flooding the channel.</li>
<li><strong>Preview before it fires</strong> — see exactly what a notification will look like, styling and all, without waiting for a real post.</li>
<li><strong>Consent-based linking</strong> — Instagram and TikTok accounts connect through official OAuth (<code>/social link</code>); Notifyer only ever reads accounts that have explicitly authorized it.</li>
</ul>

<h2>How it works</h2>
<p>An admin invites Notifyer to a Discord server, then runs <code>/setup</code> for a guided walkthrough or <code>/social add</code> to track an account directly: pick a platform, paste a handle, choose a channel. Notifyer checks each tracked account on a short interval and posts automatically the moment something new goes up.</p>

<h2>Get started</h2>
<p>
<a href="https://top.gg/bot/1515779889737896006">Add Notifyer to your server</a> &nbsp;·&nbsp;
<a href="https://github.com/DaniBottoni/Notifyer/tree/main">Source on GitHub</a>
</p>

<h2>Legal</h2>
<p>
<a href="/terms">Terms of Service</a> &nbsp;·&nbsp;
<a href="/privacy">Privacy Policy</a>
</p>
`);
}

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('OK');
    }
    if (path === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(buildStatusHTML());
    }
    if (path === '/terms') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(TERMS_HTML); }
    if (path === '/privacy') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PRIVACY_HTML); }
    // TikTok (and similar) domain-ownership verification file, hardcoded from the
    // actual downloaded file's content to avoid copy/paste corruption through env vars.
    const TIKTOK_VERIFY_FILENAME = process.env.TIKTOK_VERIFY_FILENAME || 'tiktok54ye0zN8LYl3cx2fMAolswrgKzdRfnvK.txt';
    const TIKTOK_VERIFY_CONTENT = process.env.TIKTOK_VERIFY_CONTENT || 'tiktok-developers-site-verification=54ye0zN8LYl3cx2fMAolswrgKzdRfnvK';
    if (path === `/${TIKTOK_VERIFY_FILENAME}`) {
        res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(TIKTOK_VERIFY_CONTENT);
    }
    if (path === '/oauth/instagram/callback') return handleOAuthCallback('instagram', req, res);
    if (path === '/oauth/tiktok/callback') return handleOAuthCallback('tiktok', req, res);
    if (path === '/youtube/websub') {
        if (req.method === 'GET') return handleYouTubeWebSubVerify(req, res);
        if (req.method === 'POST') return handleYouTubeWebSubPush(req, res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
}).listen(PORT, () => console.log(`🌐 HTTP server on port ${PORT}`));

// Keep-alive: ping our own URL periodically so Render's free tier doesn't spin down.
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (KEEP_ALIVE_URL) {
    setInterval(() => {
        https.get(`${KEEP_ALIVE_URL.replace(/\/$/, '')}/health`, res => res.resume())
            .on('error', e => console.error('⚠️ Keep-alive ping failed:', e.message));
    }, 10 * 60 * 1000); // every 10 minutes
} else {
    console.log('ℹ️ KEEP_ALIVE_URL/RENDER_EXTERNAL_URL not set — self-ping disabled.');
}
