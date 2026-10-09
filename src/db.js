// Postgres pool (with IPv4 fallback), schema init, and every watch/config/social-link query.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { Pool } = require('pg');
const { URL } = require('url');
const dns = require('dns');
const { SEEN_HISTORY_SIZE } = require('./config.js');

let pool; // created in initDB() after resolving the DB host to IPv4

// TLS to Postgres is encrypted but, by default, the server certificate is NOT verified
// (many managed databases, Render's included, present certificates a default CA bundle can't
// validate). Set DATABASE_SSL_VERIFY=true to enforce verification when your provider supports it.
const dbSsl = (extra = {}) => ({ rejectUnauthorized: process.env.DATABASE_SSL_VERIFY === 'true', ...extra });

pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: dbSsl() });

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
                ssl: dbSsl({ servername: original }), // keep SNI (and the cert check, when enabled) against the original hostname
            });
            pool.on('error', e => console.error('⚠️ Postgres pool error:', e.message));
            console.log(`🔧 Using IPv4 address ${address} for Postgres host ${original}`);
        }
    } catch (e) {
        console.error('⚠️ IPv4 DB lookup failed, using default resolver:', e.message);
    }
}

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
        ALTER TABLE youtube_subscriptions ADD COLUMN IF NOT EXISTS signed BOOLEAN NOT NULL DEFAULT FALSE;
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

async function getWatches(guildId) {
    const res = await pool.query('SELECT * FROM watches WHERE guild_id = $1 ORDER BY id', [guildId]);
    return res.rows;
}

// Unfiltered variant kept for the rare, non-hot-path callers below (startup
// announcements) that need to see every watch regardless of platform/active
// status. pollAll (the actual hot path — runs every 20s/2min) passes
// `platforms` and gets the filtering pushed into SQL instead: previously it
// pulled every row in the whole table on every single cycle and threw most
// of them away in JS afterward, which is wasted DB I/O and network transfer
// that scales with total watches across every server, not just the ones
// this cycle actually needs.
async function getAllWatches(platforms = null) {
    if (platforms) {
        const res = await pool.query('SELECT * FROM watches WHERE active = TRUE AND platform = ANY($1) ORDER BY id', [[...platforms]]);
        return res.rows;
    }
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
    await pool.query('UPDATE watches SET message_templates = $1 WHERE guild_id = $2 AND id = $3', [JSON.stringify(templatesObj), guildId, id]);
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
        // signed = subscribed with a hub.secret, so pushes can be HMAC-verified. Rows from before
        // that default to FALSE and get re-subscribed (with a secret) on the next poll.
        'INSERT INTO youtube_subscriptions (channel_id, expires_at, signed) VALUES ($1, $2, TRUE) ON CONFLICT (channel_id) DO UPDATE SET expires_at = $2, signed = TRUE',
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

module.exports = { addWatch, deleteSocialLink, ensureIPv4Pool, getAllWatches, getConfig, getSocialLinkById, getSocialLinkByUsername, getSocialLinks, getWatch, getWatches, getWatchesByYouTubeChannel, getYouTubeSubscription, initDB, removeWatch, saveConfig, setWatchLiveMessage, setWatchSocialLink, setWatchYouTubeLiveVideo, touchLastChecked, updateLastPost, updateSocialLinkTokens, updateWatchActive, updateWatchBatchHeader, updateWatchChannel, updateWatchMessageTemplates, updateWatchNotifyTypes, updateWatchRole, updateWatchYouTubeIds, upsertSocialLink, upsertYouTubeSubscription };
