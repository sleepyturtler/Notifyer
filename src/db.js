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
// Picks, for each (platform, account) that has several rows, the row to keep (the one whose token was refreshed
// most recently, so the freshest login) and the rows to merge into it. Pure so it can be tested without a database.
function planSocialLinkMerge(rows) {
    const groups = new Map();
    for (const r of rows) {
        const k = `${r.platform}\u0000${r.external_user_id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    const num = v => (v === null || v === undefined ? -Infinity : Number(v));
    const plan = [];
    for (const g of groups.values()) {
        if (g.length < 2) continue;
        g.sort((a, b) => num(b.expires_at) - num(a.expires_at) || num(b.linked_at) - num(a.linked_at) || b.id - a.id);
        plan.push({ keep: g[0].id, drop: g.slice(1).map(r => r.id) });
    }
    return plan;
}

// Linked accounts used to belong to one server each. They now belong to the account itself (one row per platform
// + account, usable from any server). One-time and idempotent: runs while the unique index doesn't exist yet, in a
// single transaction, and merges any account that was linked in several servers into one row, repointing watches.
// A failure here is logged loudly but doesn't stop the bot: other platforms keep working, only linking is affected.
async function migrateSocialLinks() {
    try {
        await pool.query('ALTER TABLE social_links ADD COLUMN IF NOT EXISTS needs_relink_at BIGINT'); // token rejected: owner must re-link
        await pool.query('ALTER TABLE social_links ADD COLUMN IF NOT EXISTS unused_since BIGINT');     // first sweep that saw no watch using it
        // Servers that may use a linked account they didn't link or first use, approved by the person who linked it.
        // Deleted automatically with the link (unlinking revokes every approval).
        await pool.query(`CREATE TABLE IF NOT EXISTS social_link_approvals (
            link_id INTEGER NOT NULL REFERENCES social_links(id) ON DELETE CASCADE,
            guild_id TEXT NOT NULL, approved_by TEXT, approved_at BIGINT NOT NULL,
            PRIMARY KEY (link_id, guild_id))`);
        const done = (await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'social_links_account'")).rowCount > 0;
        if (done) return;
        const conn = await pool.connect();
        try {
            await conn.query('BEGIN');
            const rows = (await conn.query('SELECT id, platform, external_user_id, expires_at, linked_at FROM social_links')).rows;
            const plan = planSocialLinkMerge(rows);
            for (const { keep, drop } of plan) {
                await conn.query('UPDATE watches SET social_link_id = $1 WHERE social_link_id = ANY($2::int[])', [keep, drop]);
                await conn.query('DELETE FROM social_links WHERE id = ANY($1::int[])', [drop]);
            }
            const olds = (await conn.query("SELECT conname FROM pg_constraint WHERE conrelid = 'social_links'::regclass AND contype = 'u'")).rows;
            for (const { conname } of olds) await conn.query(`ALTER TABLE social_links DROP CONSTRAINT "${conname.replace(/"/g, '')}"`);
            await conn.query('ALTER TABLE social_links ALTER COLUMN guild_id DROP NOT NULL'); // now just "where it was first linked"
            await conn.query('CREATE UNIQUE INDEX social_links_account ON social_links (platform, external_user_id)');
            await conn.query('COMMIT');
            console.log(`🔗 Linked accounts are now per account: ${rows.length} row(s), ${plan.reduce((n, p) => n + p.drop.length, 0)} duplicate(s) merged`);
        } catch (e) {
            await conn.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('❌ social_links migration failed (linking Instagram/TikTok will not work until this is fixed):', e.message);
    }
}

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
        ALTER TABLE watches ADD COLUMN IF NOT EXISTS batch_disabled BOOLEAN NOT NULL DEFAULT FALSE;
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
    // verified_until = when the hub-confirmed push lease runs out (set by the hub's verification request, see
    // markYouTubeSubscriptionVerified). Rows that predate the column were already live, so they start out trusted.
    const hadVerifiedCol = (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'youtube_subscriptions' AND column_name = 'verified_until'")).rowCount > 0;
    await pool.query('ALTER TABLE youtube_subscriptions ADD COLUMN IF NOT EXISTS verified_until BIGINT');
    if (!hadVerifiedCol) await pool.query('UPDATE youtube_subscriptions SET verified_until = expires_at WHERE signed');
    await pool.query('ALTER TABLE watches ADD COLUMN IF NOT EXISTS poll_interval_ms INTEGER'); // RSS adaptive polling
    await migrateSocialLinks();
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

// Per-watch switch: when true, this watch's posts always send on their own and never join a batch.
async function updateWatchBatchDisabled(guildId, id, disabled) {
    await pool.query('UPDATE watches SET batch_disabled = $1 WHERE guild_id = $2 AND id = $3', [!!disabled, guildId, id]);
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

// Called when the hub's verification request for OUR subscription arrives. Upserts, because that request can land
// before ensureYouTubeSubscription has recorded its own row (it records after the hub's 202 comes back).
async function markYouTubeSubscriptionVerified(channelId, leaseSeconds) {
    const until = Date.now() + leaseSeconds * 1000;
    await pool.query(
        'INSERT INTO youtube_subscriptions (channel_id, expires_at, signed, verified_until) VALUES ($1, $2, TRUE, $2) ON CONFLICT (channel_id) DO UPDATE SET verified_until = $2, signed = TRUE',
        [channelId, until]
    );
}

// Channels whose push subscription the hub has confirmed and which hasn't lapsed: polling can slow down for these.
async function getPushCoveredYouTubeChannels() {
    const res = await pool.query('SELECT channel_id FROM youtube_subscriptions WHERE signed AND verified_until > $1', [Date.now()]);
    return new Set(res.rows.map(r => r.channel_id));
}

async function setWatchPollInterval(id, ms) {
    await pool.query('UPDATE watches SET poll_interval_ms = $2 WHERE id = $1', [id, Math.round(ms)]);
}

async function setWatchSocialLink(guildId, id, socialLinkId) {
    await pool.query('UPDATE watches SET social_link_id = $1 WHERE guild_id = $2 AND id = $3', [socialLinkId, guildId, id]);
}

// ── Social account links (OAuth) ────────────────────────────────────────────
async function upsertSocialLink({ guildId, platform, externalUserId, externalUsername, accessToken, refreshToken, expiresAt, linkedBy }) {
    const res = await pool.query(
        `INSERT INTO social_links (guild_id, platform, external_user_id, external_username, access_token, refresh_token, expires_at, linked_by, linked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (platform, external_user_id) DO UPDATE SET
            external_username = EXCLUDED.external_username, access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token, expires_at = EXCLUDED.expires_at,
            linked_by = EXCLUDED.linked_by, linked_at = EXCLUDED.linked_at,
            needs_relink_at = NULL, unused_since = NULL
         RETURNING *`,
        [guildId, platform, externalUserId, externalUsername, accessToken, refreshToken ?? null, expiresAt ?? null, linkedBy, Date.now()]
    );
    const link = res.rows[0];
    // Watches that were paused by an unlink (social_link_id cleared) resume when the same account is linked again,
    // in every server. A watch only ever matches by its tracked username, same as when it was created.
    await pool.query('UPDATE watches SET social_link_id = $1 WHERE platform = $2 AND social_link_id IS NULL AND lower(handle) = lower($3)', [link.id, platform, externalUsername]);
    return link;
}

// What a server's admins see in /social links: accounts this server's watches use, plus accounts they linked
// themselves. Never the whole table, so usernames don't leak between servers.
async function getSocialLinksVisible(guildId, userId) {
    const res = await pool.query(
        `SELECT * FROM social_links
         WHERE linked_by = $2 OR id IN (SELECT social_link_id FROM watches WHERE guild_id = $1 AND social_link_id IS NOT NULL)
         ORDER BY platform, external_username`, [guildId, userId]);
    return res.rows;
}

// Linked accounts work in every server, so the lookup is by account name alone.
async function getSocialLinkByUsername(platform, username) {
    const res = await pool.query('SELECT * FROM social_links WHERE platform = $1 AND lower(external_username) = lower($2) ORDER BY linked_at DESC LIMIT 1', [platform, username]);
    return res.rows[0] || null;
}

async function isLinkUsedInGuild(linkId, guildId) {
    const res = await pool.query('SELECT 1 FROM watches WHERE social_link_id = $1 AND guild_id = $2 LIMIT 1', [linkId, guildId]);
    return res.rowCount > 0;
}

// How widely a link is used, shown to the person deciding whether to unlink it.
async function getLinkUsage(linkId) {
    const res = await pool.query('SELECT COUNT(*)::int AS watches, COUNT(DISTINCT guild_id)::int AS guilds FROM watches WHERE social_link_id = $1', [linkId]);
    return res.rows[0] || { watches: 0, guilds: 0 };
}

async function hasLinkApproval(linkId, guildId) {
    const res = await pool.query('SELECT 1 FROM social_link_approvals WHERE link_id = $1 AND guild_id = $2', [linkId, guildId]);
    return res.rowCount > 0;
}

async function approveLinkForGuild(linkId, guildId, approvedBy) {
    await pool.query('INSERT INTO social_link_approvals (link_id, guild_id, approved_by, approved_at) VALUES ($1, $2, $3, $4) ON CONFLICT (link_id, guild_id) DO UPDATE SET approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at', [linkId, guildId, approvedBy, Date.now()]);
}

async function getWatchesByLink(linkId) {
    return (await pool.query('SELECT id, guild_id, handle, platform FROM watches WHERE social_link_id = $1', [linkId])).rows;
}

async function countOtherWatchesUsingLink(linkId, exceptWatchId) {
    const res = await pool.query('SELECT COUNT(*)::int AS n FROM watches WHERE social_link_id = $1 AND id <> $2', [linkId, exceptWatchId]);
    return res.rows[0].n;
}

// Marks a link whose login the platform rejected. Resolves to the row only on the transition, so the
// notices go out once, not on every poll.
async function markSocialLinkDead(id) {
    const res = await pool.query('UPDATE social_links SET needs_relink_at = $2 WHERE id = $1 AND needs_relink_at IS NULL RETURNING *', [id, Date.now()]);
    return res.rows[0] || null;
}

// Links no watch uses for graceMs are removed (rows returned so the caller can revoke tokens). Self-correcting:
// each run clears the marker on links that are in use again and stamps newly unused ones.
async function sweepUnusedSocialLinks(graceMs, now = Date.now()) {
    await pool.query('UPDATE social_links SET unused_since = NULL WHERE unused_since IS NOT NULL AND EXISTS (SELECT 1 FROM watches w WHERE w.social_link_id = social_links.id)');
    await pool.query('UPDATE social_links SET unused_since = $1 WHERE unused_since IS NULL AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.social_link_id = social_links.id)', [now]);
    const res = await pool.query('DELETE FROM social_links WHERE unused_since IS NOT NULL AND unused_since < $1 AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.social_link_id = social_links.id) RETURNING *', [now - graceMs]);
    return res.rows;
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
async function deleteSocialLink(id) {
    await pool.query('UPDATE watches SET social_link_id = NULL WHERE social_link_id = $1', [id]);
    const res = await pool.query('DELETE FROM social_links WHERE id = $1', [id]);
    return res.rowCount > 0;
}

// Every guild ID that has anything stored (watches, linked accounts or settings).
async function getStoredGuildIds() {
    const res = await pool.query('SELECT guild_id FROM watches UNION SELECT guild_id FROM configs');
    return res.rows.map(r => r.guild_id);
}

// Deletes everything stored for a guild in one transaction (all or nothing). The deleted linked
// accounts are returned so the caller can revoke their tokens. YouTube push subscriptions for
// channels nobody watches any more are dropped too.
async function deleteGuildData(guildId) {
    const conn = await pool.connect();
    try {
        await conn.query('BEGIN');
        // Linked accounts belong to the account, not the server, so they stay; the unused-link sweep removes any that no watch uses.
        const watches = (await conn.query('DELETE FROM watches WHERE guild_id = $1', [guildId])).rowCount;
        await conn.query('DELETE FROM configs WHERE guild_id = $1', [guildId]);
        await conn.query('DELETE FROM social_link_approvals WHERE guild_id = $1', [guildId]);
        await conn.query('DELETE FROM youtube_subscriptions WHERE channel_id NOT IN (SELECT youtube_channel_id FROM watches WHERE youtube_channel_id IS NOT NULL)');
        await conn.query('COMMIT');
        configCache.delete(guildId);
        return { watches, links: [] };
    } catch (e) {
        await conn.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        conn.release();
    }
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

module.exports = { addWatch, approveLinkForGuild, countOtherWatchesUsingLink, deleteGuildData, deleteSocialLink, ensureIPv4Pool, getAllWatches, getConfig, getLinkUsage, getPushCoveredYouTubeChannels, getSocialLinkById, getSocialLinkByUsername, getSocialLinksVisible, getStoredGuildIds, getWatch, getWatches, getWatchesByLink, getWatchesByYouTubeChannel, getYouTubeSubscription, hasLinkApproval, initDB, isLinkUsedInGuild, markSocialLinkDead, markYouTubeSubscriptionVerified, migrateSocialLinks, planSocialLinkMerge, removeWatch, saveConfig, setWatchLiveMessage, setWatchPollInterval, setWatchSocialLink, setWatchYouTubeLiveVideo, sweepUnusedSocialLinks, touchLastChecked, updateLastPost, updateSocialLinkTokens, updateWatchActive, updateWatchBatchDisabled, updateWatchBatchHeader, updateWatchChannel, updateWatchMessageTemplates, updateWatchNotifyTypes, updateWatchRole, updateWatchYouTubeIds, upsertSocialLink, upsertYouTubeSubscription };
