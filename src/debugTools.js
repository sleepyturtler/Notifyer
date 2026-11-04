// Beta-only developer/owner tooling that will never ship to release: /social debug,
// /social oauthdebug, and /killbot — plus the /help "Admin" category that documents
// them. This file is designed to be dropped into (or deleted from) this build's
// directory, next to notifyer-beta_1_.js, with ZERO other code changes. The main
// file checks for its presence at load time and no-ops gracefully if it's missing.
//
// To turn the release build into a beta-test build: copy this file next to it, restart.
// To make a beta build release-ready: delete this file, restart. That's the whole
// process — nothing else in the codebase needs to change either direction.
//
// Unlike the module-split beta build's version of this file, this one can't
// require() the main file back to get things like E/PLATFORMS/getWatches — the main
// file requires this one near its own top, before any of its own functions exist
// yet, so a circular require would hand back an empty object. Instead, the main
// file passes everything this file needs as plain arguments at the point it calls
// in — see the ctx/deps parameters below. If you add more owner-only/debug-only
// commands later, follow the same pattern: add what you need to the ctx objects at
// the two call sites in notifyer-beta_1_.js, and handle it here.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

// ── Command registration ────────────────────────────────────────────────────
// Called while building the command list, if this file is present. Mutates the
// existing /social builder in place (adding subcommands) and pushes /killbot onto
// the commands array — both happen before client.application.commands.set().
function extendCommands(socialCommandBuilder, commands) {
    socialCommandBuilder
        .addSubcommand(s => s.setName('debug').setDescription('Show live fetch result vs stored baseline for a watch')
            .addIntegerOption(o => o.setName('id').setDescription('Watch ID (see /social list)').setRequired(true)))
        .addSubcommand(s => s.setName('oauthdebug').setDescription('Owner only: show the exact OAuth config being sent to a platform')
            .addStringOption(o => o.setName('platform').setDescription('Platform').setRequired(true)
                .addChoices({ name: '📸 Instagram', value: 'instagram' }, { name: '🎵 TikTok', value: 'tiktok' })));
    commands.push(new SlashCommandBuilder().setName('killbot').setDescription('Owner only: suspend the Render service to stop usage'));
}

// ── /help category ───────────────────────────────────────────────────────────
// Called while building HELP_CATEGORIES, if this file is present.
function getExtraHelpCategory() {
    return {
        id: 'admin', emoji: '🔧', label: 'Admin',
        build: () => new EmbedBuilder().setColor('#ED4245').setTitle('🔔 Notifyer Beta — Admin')
            .setDescription('These commands are gated to the bot owner (`BOT_OWNER_ID`) and mainly exist for debugging this beta build.')
            .addFields(
                { name: '/social debug', value: 'Show a watch\'s live fetch result vs its stored baseline, to check whether it\'d fire a notification.' },
                { name: '/social oauthdebug', value: 'Show the exact OAuth config (client ID, redirect URI, scope, full authorize URL) currently being sent for a platform.' },
                { name: '/killbot', value: 'Suspend the Render service to stop usage/billing. Falls back to crashing the process if RENDER_API_KEY/RENDER_SERVICE_ID aren\'t set.' },
            ),
    };
}

// ── /social debug, oauthdebug ────────────────────────────────────────────────
// ctx carries everything this needs from the main file, since it can't require()
// that file back (see the note at the top). Returns true if it handled the
// subcommand (caller should stop dispatching further), false to let the normal
// chain continue.
async function handleSocialSubcommand(sub, ctx) {
    const {
        interaction, reply, guildId,
        E, PLATFORMS, OAUTH_CONFIG, PUBLIC_BASE_URL,
        getWatches, getSocialLinkById,
        fetchLatestYouTubeEntries, fetchLatestTwitchAll, fetchLatestKickAll,
        fetchLatestInstagramAll, fetchLatestTikTokAll, fetchLatestPost,
        createOAuthState,
    } = ctx;

    if (sub === 'debug') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const id = interaction.options.getInteger('id');
        const watches = await getWatches(guildId);
        const w = watches.find(x => x.id === id);
        if (!w) { await interaction.editReply(`❌ No watch with ID \`${id}\` in this server. Use \`/social list\` to see IDs.`); return true; }

        let post = null, fetchError = null;
        try {
            if (w.platform === 'youtube') post = (await fetchLatestYouTubeEntries(w))[0] || null;
            else if (w.platform === 'twitch') post = (await fetchLatestTwitchAll(w.handle))[0] || null;
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
        await interaction.editReply({ embeds: [embed] });
        return true;
    }

    if (sub === 'oauthdebug') {
        const ownerId = process.env.BOT_OWNER_ID;
        if (!ownerId || interaction.user.id !== ownerId) {
            await reply('❌ This command is owner-only (it can reveal partial app credentials).');
            return true;
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
        await reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    return false;
}

// ── /killbot ─────────────────────────────────────────────────────────────────
// deps carries just postJson, since this needs nothing else from the main file.
// Returns true if it handled the command, false otherwise.
async function handleTopLevelCommand(interaction, deps) {
    const { postJson } = deps;
    if (interaction.commandName !== 'killbot') return false;

    const ownerId = process.env.BOT_OWNER_ID;
    if (!ownerId || interaction.user.id !== ownerId) {
        await interaction.reply({ content: '❌ This command is owner-only.', flags: [MessageFlags.Ephemeral] });
        return true;
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
    return true;
}

module.exports = { extendCommands, getExtraHelpCategory, handleSocialSubcommand, handleTopLevelCommand };
