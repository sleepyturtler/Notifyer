// Discord client ready + guildCreate handlers (command registration, poll loops start).
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { ActivityType, SlashCommandBuilder, ChannelType } = require('discord.js');
const { client } = require('./client.js');
const { pollAll } = require('./poller.js');
const { FAST_POLL_INTERVAL_MS, FAST_POLL_PLATFORMS, SLOW_POLL_INTERVAL_MS, SLOW_POLL_PLATFORMS } = require('./config.js');
const { announceLegacyMigrationGuilds, announceSupportServer, announceTwitterRestoredGuilds } = require('./announcements.js');
const { getConfig, saveConfig } = require('./db.js');
const fs = require('fs');
const path = require('path');
// Beta-only owner/debug commands (see debugTools.js) — present only on builds that
// opted in by having that file in src/. Checked once here so a missing file is a
// deliberate, expected release-build state, not a silently-swallowed error.
const debugTools = fs.existsSync(path.join(__dirname, 'debugTools.js')) ? require('./debugTools.js') : null;

// ── Bot ready ──────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
    console.log(`✅ Social notify bot online as ${client.user.tag}`);
    client.user.setPresence({ activities: [{ name: 'Refreshing social media for new posts', type: ActivityType.Watching }], status: 'online' });
    const socialCommand = new SlashCommandBuilder().setName('social').setDescription('Manage social media notifications')
        .addSubcommand(s => s.setName('add').setDescription('Track a new account')
            .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true).setAutocomplete(true))
            .addStringOption(o => o.setName('handle').setDescription('Username, handle, or profile URL').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Channel to post notifications in').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
        .addSubcommand(s => s.setName('list').setDescription('View tracked accounts'))
        .addSubcommand(s => s.setName('preview').setDescription('Preview what a tracked account\'s notifications will look like'))
        .addSubcommand(s => s.setName('check').setDescription('Force an immediate check of all tracked accounts'))
        .addSubcommand(s => s.setName('link').setDescription('Connect an Instagram or TikTok account via OAuth so it can be tracked')
            .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                .addChoices({ name: '📸 Instagram', value: 'instagram' }, { name: '🎵 TikTok', value: 'tiktok' })))
        .addSubcommand(s => s.setName('links').setDescription('View accounts linked via OAuth in this server'))
        .addSubcommand(s => s.setName('access').setDescription('Set which role can manage social notifications'));
    const commands = [
        new SlashCommandBuilder().setName('invite').setDescription('Get a link to invite this bot to another server'),
        new SlashCommandBuilder().setName('help').setDescription('View commands and features'),
        new SlashCommandBuilder().setName('setup').setDescription('New here? Get a quick walkthrough and set up your first tracked account'),
        socialCommand,
    ];
    // Adds /social debug, /social oauthdebug, and /killbot only on builds that have
    // debugTools.js — mutates socialCommand in place and pushes killbot onto commands.
    if (debugTools) debugTools.extendCommands(socialCommand, commands);
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
