// The interactionCreate handler: every slash command, button, select menu and modal.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, EmbedBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, ChannelType } = require('discord.js');
const { client } = require('./client.js');
const { fetchJson, fetchText, postForm, postJson, request } = require('./net.js');
const { OAUTH_CONFIG, PLATFORMS, PLATFORM_NOTIFY_TYPES, PUBLIC_BASE_URL, activeTypeIds, canUnlinkLink, canUsePlatform, isOwner, linkablePlatforms } = require('./config.js');
const { E, canWatchBatch, watchName } = require('./helpers.js');
const { buildBatchHeaderModal, buildBatchSettingsView, buildHelpView, buildManageView, buildPerTypeMessageModal, buildSetupView, buildSocialLinkManageView, buildSocialLinksEmbed, buildWatchListEmbed } = require('./ui.js');
const { countOtherWatchesUsingLink, deleteSocialLink, getConfig, getLinkUsage, getSocialLinkById, getWatch, getWatches, getWatchesByLink, isLinkUsedInGuild, removeWatch, saveConfig, updateWatchActive, updateWatchBatchDisabled, updateWatchBatchHeader, updateWatchChannel, updateWatchMessageTemplates, updateWatchNotifyTypes, updateWatchRole } = require('./db.js');
const { hasCommandPermission } = require('./permissions.js');
const { buildAddWatchSuccessResponse, createWatchFlow } = require('./watchFlow.js');
const { pollAll } = require('./poller.js');
const { reportLinkProblem } = require('./announcements.js');
const { handleLinkRequestButton } = require('./linkRequests.js');
const { revokeTikTokToken } = require('./platforms/social.js');
const { SETUP_PICK_TTL_MS, createOAuthState, pendingSetupPicks } = require('./state.js');
const { buildNotificationPayload, buildOnboardingPreview, buildSamplePost } = require('./notify.js');
const { DEFAULT_BATCH_HEADER, MAX_BATCH_ENTRIES_PER_MESSAGE } = require('./batch.js');
const fs = require('fs');
const path = require('path');
// Beta-only owner/debug commands (/social debug, /social oauthdebug, /killbot) —
// see debugTools.js. Only wired in if that file is present in this build's src/;
// entirely absent (not just disabled) on a release build that never had it dropped in.
const debugTools = fs.existsSync(path.join(__dirname, 'debugTools.js')) ? require('./debugTools.js') : null;

// ── Interaction handling ────────────────────────────────────────────────────

// The private "Authorize with <platform>" message, shared by /social link and the Link button in /social links.
// Resolves to { error } (a message to show) or { payload } (a ready ephemeral reply).
function buildLinkPrompt(guildId, userId, platform) {
    const cfg = OAUTH_CONFIG[platform];
    if (!cfg) return { error: '❌ That platform can not be linked.' };
    if (!cfg.clientId || !cfg.clientSecret) {
        return { error: `❌ ${PLATFORMS[platform].label} OAuth isn't configured on this bot yet (missing app credentials env vars). Ask the bot owner to set them up.` };
    }
    if (!PUBLIC_BASE_URL) {
        return { error: '❌ PUBLIC_BASE_URL (or RENDER_EXTERNAL_URL) isn\'t set, so OAuth redirects have nowhere to go. Ask the bot owner to configure it.' };
    }
    const { state, expires } = createOAuthState(guildId, userId, platform);
    const authUrl = `${cfg.authUrl}?${cfg.clientIdParam}=${encodeURIComponent(cfg.clientId)}&redirect_uri=${encodeURIComponent(cfg.redirectUri)}&scope=${encodeURIComponent(cfg.scope)}&response_type=code&state=${state}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(`Authorize with ${PLATFORMS[platform].label}`).setStyle(ButtonStyle.Link).setURL(authUrl)
    );
    return {
        payload: {
            embeds: [E('#5865F2', `Link ${PLATFORMS[platform].label}`).setDescription(`Click below and log in with the **${PLATFORMS[platform].label} account you want this bot to track**. That account has to authorize this app — the bot can't watch accounts that haven't consented.\n\nOnce linked, the account can be tracked in **any server** that uses Notifyer. You can unlink it any time from \`/social links\`.\n\nThis link expires <t:${Math.floor(expires / 1000)}:R>.`)],
            components: [row],
            flags: [MessageFlags.Ephemeral],
        },
    };
}

client.on('interactionCreate', async interaction => {
  try {
    // Approve/Deny buttons arrive by DM, so there is no guild: handle them before the guild-only checks below.
    if (interaction.isButton() && interaction.customId.startsWith('linkreq_')) return await handleLinkRequestButton(interaction);
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
                .filter(([k, v]) => canUsePlatform(k, interaction.user.id) && (!v.unavailable || (v.ownerOnly && ownerHere)))
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
            return reply({ ...buildSetupView(watches.length ? 'track' : 'welcome', watches.length), flags: [MessageFlags.Ephemeral] });
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
                if (PLATFORMS[platform] && !canUsePlatform(platform, interaction.user.id)) return reply('❌ That platform is not available yet.');

                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

                const result = await createWatchFlow(guildId, platform, rawHandle, channel.id, interaction.user.tag, bypassUnavailable, interaction.user.id);
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
                            label: `${PLATFORMS[w.platform]?.label || w.platform} — ${watchName(w)}`.slice(0, 100),
                            value: `${w.id}`,
                            emoji: PLATFORMS[w.platform]?.emojiButton,
                        })))
                );
                return reply({ content: 'Select a watch to preview its notification(s):', components: [row], flags: [MessageFlags.Ephemeral] });
            }

            if (sub === 'check') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                await pollAll(null, guildId);
                return interaction.editReply('✅ Checked all tracked accounts for new posts.');
            }

            // Beta-only: /social debug, /social oauthdebug — see debugTools.js.
            // Entirely skipped (falls through to "if commandName is social, return"
            // below) on a build that doesn't have that file.
            if (debugTools && (sub === 'debug' || sub === 'oauthdebug')) {
                const handled = await debugTools.handleSocialSubcommand(sub, { interaction, reply });
                if (handled) return;
            }

            if (sub === 'link') {
                const result = buildLinkPrompt(guildId, interaction.user.id, interaction.options.getString('platform'));
                return reply(result.error || result.payload);
            }

            if (sub === 'links') {
                const { embeds, components } = await buildSocialLinksEmbed(guildId, interaction.user.id);
                return reply({ embeds, components, flags: [MessageFlags.Ephemeral] });
            }
        }
        if (commandName === 'invite' || commandName === 'help' || commandName === 'social') return;
    }

    // Beta-only: /killbot — see debugTools.js. Entirely absent as a registered
    // command on a build that doesn't have that file, so this never matches there.
    if (debugTools && interaction.isChatInputCommand() && interaction.commandName === 'killbot') {
        // debugTools destructures its helpers from a second argument (it threw "Cannot destructure 'postJson' of 'deps'").
        const handled = await debugTools.handleTopLevelCommand(interaction, { postJson, fetchJson, fetchText, postForm, request, client, PLATFORMS, isOwner });
        if (handled) return;
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

    // ── Buttons: refresh linked-accounts list ───────────────────────────────
    // "Link an account" (shown when nothing is linked yet): same permission as /social link; if both Instagram and TikTok
    // can be linked it asks which, otherwise it goes straight to the authorize message.
    if (interaction.isButton() && interaction.customId.startsWith('sociallinks_add_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const options = linkablePlatforms();
        if (!options.length) return reply('❌ Linking is not set up on this bot yet. Ask the bot owner to configure Instagram or TikTok.');
        if (options.length === 1) {
            const r = buildLinkPrompt(guildId, interaction.user.id, options[0]);
            return reply(r.error || r.payload);
        }
        const menu = new StringSelectMenuBuilder().setCustomId(`sociallinks_addpick_${guildId}`).setPlaceholder('Which account do you want to link?')
            .addOptions(options.map(k => ({ label: PLATFORMS[k].label, value: k, emoji: PLATFORMS[k].emojiButton })));
        return reply({ content: 'Which account do you want to link?', components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallinks_addpick_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const platform = interaction.values[0];
        if (!linkablePlatforms().includes(platform)) return interaction.update({ content: '❌ That platform can not be linked right now.', components: [] });
        const r = buildLinkPrompt(guildId, interaction.user.id, platform);
        if (r.error) return interaction.update({ content: r.error, components: [] });
        const { flags, ...rest } = r.payload; // the picker message is already private
        return interaction.update({ content: null, ...rest });
    }

    if (interaction.isButton() && interaction.customId.startsWith('sociallinks_refresh_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = await buildSocialLinksEmbed(guildId, interaction.user.id);
        return interaction.update({ embeds, components });
    }

    // ── Select: open manage view for a linked account ───────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('sociallinks_manage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const [platform, idStr] = interaction.values[0].split(':');
        const link = await getSocialLinkById(parseInt(idStr, 10));
        // Visible if this server's watches use it or you linked it; never just because it exists.
        if (!link || link.platform !== platform || !(link.linked_by === interaction.user.id || await isLinkUsedInGuild(link.id, guildId))) {
            return interaction.reply({ content: '❌ Linked account not found (it may have been removed).', flags: [MessageFlags.Ephemeral] });
        }
        const { embeds, components } = buildSocialLinkManageView(link, { guildId, canUnlink: canUnlinkLink(link, interaction.user.id), usage: await getLinkUsage(link.id) });
        return interaction.update({ embeds, components });
    }

    // ── Buttons: linked-account manage view actions ─────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('sociallinkmanage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const parts = interaction.customId.split('_'); // sociallinkmanage_<action>_[platform_]<id>
        const action = parts[1];

        if (action === 'back') {
            const { embeds, components } = await buildSocialLinksEmbed(guildId, interaction.user.id);
            return interaction.update({ embeds, components });
        }

        if (action === 'unlink') {
            const platform = parts[2];
            const id = parseInt(parts[3], 10);
            const link = await getSocialLinkById(id);
            if (!link || link.platform !== platform || !(link.linked_by === interaction.user.id || await isLinkUsedInGuild(link.id, guildId))) {
                const { embeds, components } = await buildSocialLinksEmbed(guildId, interaction.user.id);
                return interaction.update({ content: '❌ Linked account not found (it may have already been removed).', embeds, components });
            }
            // A linked account may be used by other servers, and unlinking pauses all of them.
            if (!canUnlinkLink(link, interaction.user.id)) {
                return interaction.reply({ content: `❌ Only <@${link.linked_by}> (who linked it) or the bot owner can unlink this account, because other servers may be using it. To stop it in this server, remove its watches from \`/social list\`.`, flags: [MessageFlags.Ephemeral], allowedMentions: { parse: [] } });
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

            const affected = await getWatchesByLink(link.id);
            await deleteSocialLink(link.id);
            // Tells the affected servers' admins (and you, if the bot owner did it). Fire and forget.
            reportLinkProblem(link, 'unlinked', affected, link.linked_by === interaction.user.id ? null : 'unlinked by someone else');
            const servers = new Set(affected.map(a => a.guild_id)).size;
            const { embeds, components } = await buildSocialLinksEmbed(guildId, interaction.user.id);
            return interaction.update({ content: `✅ Unlinked **${link.external_username}** (${PLATFORMS[platform].label}).${affected.length ? ` ${affected.length} watch${affected.length === 1 ? '' : 'es'} in ${servers} server${servers === 1 ? '' : 's'} paused; they resume if the account is linked again.` : ''}${revokeNote}`, embeds, components });
        }
    }

    // ── Select: open manage view for a watch ────────────────────────────────
    // "Manage <handle>" button on a delivery-failure report: opens that watch's manage view privately
    // (ephemeral), so the admin can change the channel without the report message being replaced.
    if (interaction.isButton() && interaction.customId.startsWith('deliveryfail_manage_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const w = await getWatch(guildId, parseInt(interaction.customId.slice(20), 10));
        if (!w) return interaction.reply({ content: '❌ Watch not found (it may have been removed).', flags: [MessageFlags.Ephemeral] });
        return interaction.reply({ ...buildManageView(w), flags: [MessageFlags.Ephemeral] });
    }
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
        await interaction.update({ content: `Previewing **${p?.label || w.platform} — ${watchName(w)}** (${types.length} notify type${types.length > 1 ? 's' : ''}):`, components: [] });
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

        if (action === 'batchsettings') {
            const cfg = await getConfig(guildId);
            return interaction.update(buildBatchSettingsView(w, cfg));
        }

        if (action === 'batchheader') {
            return interaction.showModal(buildBatchHeaderModal(w));
        }

        if (action === 'togglebatch') {
            await updateWatchBatchDisabled(guildId, id, !w.batch_disabled);
            const { embeds, components } = buildManageView(await getWatch(guildId, id));
            return interaction.update({ embeds, components });
        }

        if (action === 'channel') {
            return interaction.update({
                embeds: [E('#5865F2', `Change Channel — ${watchName(w)}`).setDescription('Select the new channel for this watch\'s notifications.')],
                components: [new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder().setCustomId(`socialchannel_select_${id}`).setPlaceholder('Select a channel…')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                )],
            });
        }

        if (action === 'role') {
            return interaction.update({
                embeds: [E('#5865F2', `Ping Role — ${watchName(w)}`).setDescription('Select a role to ping on every notification, or click "Clear Role" to remove it.')],
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
            const current = activeTypeIds(w);
            return interaction.update({
                embeds: [E('#5865F2', `Notification Types — ${watchName(w)}`).setDescription(`Choose which **${PLATFORMS[w.platform].label}** content types to get notified for.`)],
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
                // Linked accounts are shared across servers, so only say something when no watch anywhere uses it any
                // more. It isn't deleted right away (you may track it elsewhere); the daily sweep removes it after 30 days.
                if (await countOtherWatchesUsingLink(w.social_link_id, w.id) === 0) {
                    unlinkNote = '\nNo watches use that linked account any more. It stays linked for 30 days in case you track it again, then is removed automatically. To remove it now, use `/social links`.';
                }
            }
            await removeWatch(guildId, id);
            const { embeds, components } = await buildWatchListEmbed(guildId);
            return interaction.update({ content: `✅ Removed ${PLATFORMS[w.platform].label} — ${watchName(w)}.${unlinkNote}`, embeds, components });
        }

        if (action === 'backto') {
            const { embeds, components } = buildManageView(w);
            return interaction.update({ content: null, embeds, components });
        }
    }

    // ── Select/skip: notification types from the guided /social add flow —
    // chains straight into the per-type message modal instead of just confirming.
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialtypeadd_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(21), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, interaction.values);
        const updated = await getWatch(guildId, id);
        return interaction.showModal(buildPerTypeMessageModal(updated, true));
    }
    if (interaction.isButton() && interaction.customId.startsWith('socialtypeadd_skip_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(19), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchNotifyTypes(guildId, id, null);
        const updated = await getWatch(guildId, id);
        return interaction.showModal(buildPerTypeMessageModal(updated, true));
    }

    // ── Select: notification types (post-add and manage flows) ──────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialtype_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
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
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
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
    // /setup tour: tab navigation (informational, so no permission check; the add button checks its own)
    if (interaction.isButton() && interaction.customId.startsWith('setup_tab_')) {
        const watches = await getWatches(guildId);
        return interaction.update(buildSetupView(interaction.customId.slice(10), watches.length));
    }
    // Preview: a fake channel and video as a real embed. Built from constants (no YouTube fetch, no database), only
    // shown to the person who clicked, and informational, so no permission check.
    if (interaction.isButton() && interaction.customId === 'setup_sample') {
        return interaction.reply({ ...buildOnboardingPreview(), flags: [MessageFlags.Ephemeral] });
    }
    if (interaction.isButton() && interaction.customId === 'setup_start') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const ownerHere = isOwner(interaction.user.id);
        const options = Object.entries(PLATFORMS)
            .filter(([k, v]) => canUsePlatform(k, interaction.user.id) && (!v.unavailable || (v.ownerOnly && ownerHere)))
            .map(([k, v]) => ({ label: v.label, value: k, emoji: v.emojiButton }));
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId('setup_platform_pick').setPlaceholder('Choose a platform…').addOptions(options)
        );
        return interaction.update({ content: 'Which platform is the account on?', embeds: [], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'setup_platform_pick') {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const platform = interaction.values[0];
        if (!canUsePlatform(platform, interaction.user.id)) return interaction.update({ content: '❌ That platform is not available yet.', components: [] });
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
        if (!canUsePlatform(pending.platform, interaction.user.id)) return interaction.editReply({ content: '❌ That platform is not available yet.' });
        const bypassUnavailable = Boolean(PLATFORMS[pending.platform]?.ownerOnly && isOwner(interaction.user.id));
        const result = await createWatchFlow(guildId, pending.platform, pending.rawHandle, channelId, interaction.user.tag, bypassUnavailable, interaction.user.id);
        if (!result.ok) return interaction.editReply({ content: result.message });
        const { embeds, components } = buildAddWatchSuccessResponse(result.watch, result.post, result.handle, channel);
        return interaction.editReply({ content: null, embeds, components });
    }

    if (interaction.isChannelSelectMenu() && interaction.customId.startsWith('socialchannel_select_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(21), 10);
        const channelId = interaction.values[0];
        if (!await getWatch(guildId, id)) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
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
        if (!await getWatch(guildId, id)) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchRole(guildId, id, roleId);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // ── Button: clear ping role ──────────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('socialrole_clear_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(17), 10);
        if (!await getWatch(guildId, id)) return interaction.update({ content: '❌ Watch not found.', embeds: [], components: [] });
        await updateWatchRole(guildId, id, null);
        const w = await getWatch(guildId, id);
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
    }

    // Batch settings (server-wide), opened from a watch's manage view.
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('socialbatchsettings_min_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(24), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', embeds: [], components: [] });
        const n = Math.min(Math.max(parseInt(interaction.values[0], 10) || 2, 2), MAX_BATCH_ENTRIES_PER_MESSAGE);
        const cfg = { ...(await getConfig(guildId)), batchMinThreshold: n };
        saveConfig(guildId, cfg);
        return interaction.update(buildBatchSettingsView(w, cfg));
    }
    if (interaction.isButton() && interaction.customId.startsWith('socialbatchsettings_cross_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const id = parseInt(interaction.customId.slice(26), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', embeds: [], components: [] });
        const current = await getConfig(guildId);
        const cfg = { ...current, batchCrossChannel: !current.batchCrossChannel };
        saveConfig(guildId, cfg);
        return interaction.update(buildBatchSettingsView(w, cfg));
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
        const isNewFlow = interaction.customId.endsWith('_new');
        const id = parseInt(interaction.customId.slice(19), 10); // parseInt stops at the trailing "_new" on its own
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        return interaction.showModal(buildPerTypeMessageModal(w, isNewFlow));
    }

    // ── Modal: save per-post-type custom messages ────────────────────────────
    if (interaction.isModalSubmit() && interaction.customId.startsWith('socialpertype_modal_')) {
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const isNewFlow = interaction.customId.endsWith('_new');
        const id = parseInt(interaction.customId.slice(20), 10); // parseInt stops at the trailing "_new" on its own
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
        // Still mid-wizard (came from /social add or /setup, not a later manage-view
        // edit) and this watch can actually batch — offer the batch-header step as
        // its own explicit part of the flow, rather than only ever being reachable
        // by noticing the button buried in the manage view afterward.
        if (isNewFlow && canWatchBatch(updated)) {
            const embed = new EmbedBuilder().setColor(PLATFORMS[updated.platform].color)
                .setTitle('One more optional step')
                .setDescription(`Want a custom header for when 2+ posts from ${watchName(updated)} (or another watch in the same channel) land within 10 minutes of each other? Default is \`${DEFAULT_BATCH_HEADER}\`.`);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`socialbatchheaderadd_open_${id}`).setLabel('Set Batch Header').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`socialbatchheaderadd_skip_${id}`).setLabel('Skip').setStyle(ButtonStyle.Secondary)
            );
            return interaction.editReply({ embeds: [embed], components: [row] });
        }
        const { embeds, components } = buildManageView(updated);
        return interaction.editReply({ embeds, components });
    }

    // ── Buttons: optional batch-header step at the end of the add-flow wizard ──
    if (interaction.isButton() && interaction.customId.startsWith('socialbatchheaderadd_open_')) {
        const id = parseInt(interaction.customId.slice(26), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.reply({ content: '❌ Watch not found.', flags: [MessageFlags.Ephemeral] });
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        return interaction.showModal(buildBatchHeaderModal(w));
    }
    if (interaction.isButton() && interaction.customId.startsWith('socialbatchheaderadd_skip_')) {
        const id = parseInt(interaction.customId.slice(26), 10);
        const w = await getWatch(guildId, id);
        if (!w) return interaction.update({ content: '❌ Watch not found (it may have been removed).', embeds: [], components: [] });
        if (!await hasCommandPermission(interaction, guildId)) return interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] });
        const { embeds, components } = buildManageView(w);
        return interaction.update({ embeds, components });
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
