// Deleting a server's data when the bot is no longer in it.
//
// Two triggers: the bot being removed (guildDelete), and a startup sweep for servers the bot left
// while it was offline (and for any data left behind before this existed). Both end up in
// purgeGuild(). The sweep has safeguards because deleting is not reversible: it only runs when the
// guild list looks complete, and it refuses to bulk-delete if a large share of stored servers
// appear to be missing, which points to a Discord/connection problem rather than real removals.

const { client } = require('./client.js');
const { deleteGuildData, getStoredGuildIds, getWatches, sweepUnusedSocialLinks } = require('./db.js');
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

// Removes data for servers that are stored but no longer in the bot's guild list.
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
    for (const id of orphans) await purgeGuild(id, 'the bot is no longer in this server');
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

module.exports = { purgeGuild, purgeOrphanedGuilds, sweepUnusedLinks };
