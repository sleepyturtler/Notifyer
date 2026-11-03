// Deleting a server's data when the bot is no longer in it.
//
// Two triggers: the bot being removed (guildDelete), and a startup sweep for servers the bot left
// while it was offline (and for any data left behind before this existed). Neither deletes right away: they queue the
// server, and sweepRemovedGuilds() deletes it once GUILD_PURGE_GRACE_MS (7 days) has passed. Re-adding the bot in the
// meantime cancels it and everything is still there. The startup sweep also has safeguards because bulk deletion is not
// reversible: it only runs when the guild list looks complete, and it refuses to queue a large share of stored servers,
// which points to a Discord/connection problem (or the wrong database) rather than real removals.

const { client } = require('./client.js');
const { cancelGuildPurge, deleteGuildData, getQueuedGuildPurges, getStoredGuildIds, getWatches, scheduleGuildPurge, sweepUnusedSocialLinks } = require('./db.js');
const { GUILD_PURGE_GRACE_MS } = require('./config.js');
const { revokeTikTokToken } = require('./platforms/social.js');

// Never throws. Returns what was removed, or null if the deletion itself failed.
async function purgeGuild(guildId, why) {
    let result;
    try {
        result = await deleteGuildData(guildId);
    } catch (e) {
        console.error(`purgeGuild (${guildId}): deletion failed, nothing was removed:`, e.message);
        return null;
    }
    // Linked accounts belong to the account, not the server, so they stay; sweepUnusedLinks() removes any that no watch uses.
    console.log(`🧹 Removed all stored data for guild ${guildId} (${why}): ${result.watches} watch(es)`);
    return result;
}

// Never throws. Starts the grace period for a server the bot is no longer in.
async function queueGuildPurge(guildId, why) {
    try {
        const deleteAfter = Date.now() + GUILD_PURGE_GRACE_MS;
        if (await scheduleGuildPurge(guildId, deleteAfter, why)) console.log(`🕓 Server ${guildId} (${why}): its data will be deleted after ${new Date(deleteAfter).toISOString()} unless the bot is added back before then`);
    } catch (e) {
        console.error(`queueGuildPurge (${guildId}):`, e.message);
    }
}

// The bot is in this server again: forget the pending deletion. Never throws.
async function cancelQueuedPurge(guildId) {
    try {
        if (await cancelGuildPurge(guildId)) console.log(`↩️ Server ${guildId}: the bot is back, so its pending data deletion was cancelled`);
    } catch (e) {
        console.error(`cancelQueuedPurge (${guildId}):`, e.message);
    }
}

// Cancels queued servers the bot is in again, and deletes the ones whose grace period is over and the bot is still not
// in. Skips deleting when the guild list can't be trusted (empty, or some servers unavailable). Never throws.
async function sweepRemovedGuilds() {
    try {
        const guilds = client.guilds.cache;
        const queued = await getQueuedGuildPurges();
        if (!queued.length) return;
        for (const q of queued) if (guilds.has(q.guild_id)) await cancelQueuedPurge(q.guild_id);
        const due = queued.filter(q => q.delete_after <= Date.now() && !guilds.has(q.guild_id));
        if (!due.length) return;
        if (guilds.size === 0 || [...guilds.values()].some(g => g.available === false)) { console.log('🧹 Removed-server deletion postponed: the server list is empty or incomplete (Discord outage?).'); return; }
        for (const q of due) await purgeGuild(q.guild_id, q.reason || 'the bot was removed from the server');
    } catch (e) {
        console.error('removed-server sweep:', e.message);
    }
}

// Queues data for servers that are stored but no longer in the bot's guild list.
async function purgeOrphanedGuilds() {
    const guilds = client.guilds.cache;
    if (guilds.size === 0) { console.log('🧹 Orphan sweep skipped: the bot reports no servers (not trusting an empty guild list).'); return; }
    if ([...guilds.values()].some(g => g.available === false)) { console.log('🧹 Orphan sweep skipped: some servers are unavailable (Discord outage?). It will run on a later start.'); return; }

    const stored = await getStoredGuildIds();
    const orphans = stored.filter(id => !guilds.has(id));
    if (!orphans.length) return;

    const limit = Math.max(5, Math.floor(stored.length * 0.25));
    if (orphans.length > limit && process.env.ALLOW_BULK_ORPHAN_PURGE !== 'true') {
        const sample = [];
        for (const id of orphans.slice(0, 8)) sample.push(`${id} (${(await getWatches(id).catch(() => [])).length} watch(es))`);
        console.warn(`⚠️ Orphan sweep REFUSED: ${orphans.length} of ${stored.length} stored servers are not in this bot's server list (the bot is in ${guilds.size}), more than the safe limit of ${limit}. Nothing was deleted.\n`
            + `   Examples: ${sample.join(', ')}${orphans.length > 8 ? ', ...' : ''}\n`
            + '   If this database belongs to a different bot (wrong DATABASE_URL?), fix that first. Only if these servers really are gone, set ALLOW_BULK_ORPHAN_PURGE=true and restart once.');
        return;
    }
    for (const id of orphans) await queueGuildPurge(id, 'the bot is no longer in this server');
}

// Removes linked accounts no watch has used for UNUSED_LINK_GRACE_MS, revoking the TikTok token (Meta has no app-side
// revoke for Instagram). Never throws. Runs at startup and every few hours; see events.js.
const UNUSED_LINK_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
async function sweepUnusedLinks() {
    try {
        const removed = await sweepUnusedSocialLinks(UNUSED_LINK_GRACE_MS);
        let revoked = 0;
        for (const link of removed) {
            if (link.platform !== 'tiktok') continue;
            const r = await revokeTikTokToken(link).catch(e => ({ ok: false, reason: e.message }));
            if (r.ok) revoked++;
        }
        if (removed.length) console.log(`🧹 Removed ${removed.length} linked account(s) unused for 30 days (${revoked} TikTok token(s) revoked)`);
    } catch (e) {
        console.error('unused-link sweep:', e.message);
    }
}

module.exports = { cancelQueuedPurge, purgeGuild, purgeOrphanedGuilds, queueGuildPurge, sweepRemovedGuilds, sweepUnusedLinks };
