// One-off / recurring admin announcements (support server, Twitter restored, legacy-format migration).
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEGACY_MIGRATION_TS, SUPPORT_SERVER_URL } = require('./config.js');
const { getAllWatches, getConfig, saveConfig } = require('./db.js');
const { client } = require('./client.js');
const { isLegacyMessageFormat } = require('./helpers.js');

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

module.exports = { announceLegacyMigrationGuilds, announceSupportServer, announceTwitterRestoredGuilds };
