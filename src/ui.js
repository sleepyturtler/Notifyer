// Embed/modal/view builders: watch list, manage view, help, setup wizard screens.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getSocialLinks, getWatches } = require('./db.js');
const { LEGAL_BASE_URL, PLATFORMS, PLATFORM_NOTIFY_TYPES, activeTypeIds } = require('./config.js');
const { DEFAULT_BATCH_HEADER, MAX_BATCH_ENTRIES_PER_MESSAGE } = require('./batch.js');
const { PLACEHOLDER_HELP } = require('./notify.js');
const { canWatchBatch } = require('./helpers.js');
const fs = require('fs');
const path = require('path');
// Beta-only "Admin" help category (see debugTools.js) — only added if that file is
// present in this build's src/.
const debugTools = fs.existsSync(path.join(__dirname, 'debugTools.js')) ? require('./debugTools.js') : null;
// Help embed title: "Notifyer Beta" on a build that has debugTools.js, plain "Notifyer" without it,
// so removing that one file is all it takes to turn a beta build into a release build.
const BUILD_NAME = debugTools ? 'Notifyer Beta' : 'Notifyer';

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

// Shared modal builder used both from the manage view's "Edit Messages"
// button and from the new guided /social add flow, so both stay in sync.
// isNewFlow tags the modal's customId so its submit handler knows whether to
// continue the add-flow wizard (offer the batch-header step next) or just
// return to the manage view, since this same modal serves both entry points.
function buildPerTypeMessageModal(w, isNewFlow = false) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const modal = new ModalBuilder().setCustomId(`socialpertype_modal_${w.id}${isNewFlow ? '_new' : ''}`).setTitle(`Edit Messages for ${w.handle}`.slice(0, 45));
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

// Shared by the manage view's "Batch Header" button and the guided add-flow's
// optional batch-header step below, so both stay in sync.
function buildBatchHeaderModal(w) {
    return new ModalBuilder().setCustomId(`socialbatchheader_modal_${w.id}`).setTitle('Edit Batch Header')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('template').setLabel('Header shown when 2+ posts land within 10 min')
                    .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
                    .setValue(w.batch_header_template || '')
                    .setPlaceholder(DEFAULT_BATCH_HEADER)
            )
        );
}

// One line per active notify type: that type's own message, else the watch's old single message, else "default".
function describeMessages(w) {
    const all = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const ids = activeTypeIds(w);
    const active = all.filter(t => ids.includes(t.id));
    const templates = w.message_templates || {};
    return active.map(t => {
        const text = String(templates[t.id] || w.message_template || '').replace(/\s+/g, ' ').replace(/`/g, "'").trim();
        return `**${t.label}:** ${text ? `\`${text.slice(0, 60)}${text.length > 60 ? '…' : ''}\`` : 'default'}`;
    }).join('\n') || 'default';
}

function buildManageView(w) {
    const p = PLATFORMS[w.platform];
    const embed = new EmbedBuilder().setColor(p.color).setTitle(`Manage — ${p.emojiTag} ${w.handle}`).setTimestamp()
        .addFields(
            { name: 'Channel', value: `<#${w.channel_id}>`, inline: true },
            { name: 'Status', value: w.active ? '▶️ Active' : '⏸️ Paused', inline: true },
            { name: 'Ping role', value: w.role_id ? `<@&${w.role_id}>` : 'None', inline: true },
            { name: 'Types', value: (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types.map(t => PLATFORM_NOTIFY_TYPES[w.platform]?.find(x => x.id === t)?.label || t).join(', ') : ((PLATFORM_NOTIFY_TYPES[w.platform] || []).some(t => t.defaultOff) ? activeTypeIds(w).map(id => PLATFORM_NOTIFY_TYPES[w.platform].find(x => x.id === id).label).join(', ') : 'All types'), inline: true },
        );
    embed.addFields({ name: 'Messages', value: describeMessages(w) });
    embed.addFields({ name: 'Placeholders', value: PLACEHOLDER_HELP });
    if (p.unavailable) {
        embed.addFields({ name: '⚠️ Unavailable', value: `${p.label} isn't working right now (see /help, Info). Your settings are kept.` });
    }
    // A watch can only ever contribute to a batch if at least one of its active
    // notify types isn't "live" — live events always send individually (see
    // pollAll), so a Kick watch (live-only) or a YouTube watch restricted to
    // just Live can never actually batch, regardless of platform.
    const batchPossible = canWatchBatch(w); // this watch has at least one non-live type
    const canBatch = batchPossible && !w.batch_disabled;
    if (batchPossible && w.batch_disabled) embed.addFields({ name: 'Batching', value: 'Off for this watch. Its posts always send on their own.' });
    else if (canBatch) embed.addFields({ name: 'Batching', value: `Header: \`${w.batch_header_template || DEFAULT_BATCH_HEADER}\` (use \`{creators}\` to list accounts)` });
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialpertype_open_${w.id}`).setLabel('Edit Messages').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`socialmanage_channel_${w.id}`).setLabel('Change Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_role_${w.id}`).setLabel('Ping Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_types_${w.id}`).setLabel('Edit Types').setStyle(ButtonStyle.Secondary),
    );
    // Batch Settings is server-wide (min posts / cross-channel), so it is offered on every
    // watch; Batch Header is per-watch and only matters when this watch can batch at all.
    const row1b = [new ActionRowBuilder().addComponents(
        ...(canBatch ? [new ButtonBuilder().setCustomId(`socialmanage_batchheader_${w.id}`).setLabel('Batch Header').setStyle(ButtonStyle.Secondary)] : []),
        new ButtonBuilder().setCustomId(`socialmanage_batchsettings_${w.id}`).setLabel('Batch Settings').setStyle(ButtonStyle.Secondary),
        ...(batchPossible ? [new ButtonBuilder().setCustomId(`socialmanage_togglebatch_${w.id}`).setLabel(w.batch_disabled ? 'Batching: Off' : 'Batching: On').setStyle(w.batch_disabled ? ButtonStyle.Secondary : ButtonStyle.Success)] : []),
    )];
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_toggle_${w.id}`).setLabel(w.active ? 'Pause' : 'Resume').setStyle(w.active ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`socialmanage_remove_${w.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`socialmanage_back_${w.guild_id}`).setLabel('← Back to List').setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, ...row1b, row2] };
}

// Server-wide batch settings (replaces the former batch config slash command), reached from a
// watch's manage view. cfg is the guild config; w is only used to route the Back button.
function buildBatchSettingsView(w, cfg) {
    const minPosts = cfg.batchMinThreshold || 2;
    const cross = !!cfg.batchCrossChannel;
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Batch Settings')
        .setDescription('Applies to every watch in this server.')
        .addFields(
            { name: 'Posts needed to combine', value: `\`${minPosts}\` posts within 10 minutes merge into one message.` },
            { name: 'Batch across channels', value: cross ? '✅ On: one batch can span every channel' : '❌ Off: batches stay within one channel' },
        );
    const options = [];
    for (let n = 2; n <= MAX_BATCH_ENTRIES_PER_MESSAGE; n++) options.push({ label: `${n} posts`, value: String(n), default: n === minPosts });
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`socialbatchsettings_min_${w.id}`).setPlaceholder('Posts needed to combine').addOptions(options)),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`socialbatchsettings_cross_${w.id}`).setLabel(cross ? 'Cross-channel: On' : 'Cross-channel: Off').setStyle(cross ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`socialmanage_backto_${w.id}`).setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
            ),
        ],
    };
}

// ── Help (tabbed) ────────────────────────────────────────────────────────
const HELP_CATEGORIES = [
    {
        id: 'general', emoji: '🏠', label: 'General',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle(`🔔 ${BUILD_NAME} — General`)
            .setDescription('Get a notification when a tracked account posts or goes live.')
            .addFields(
                { name: '/setup', value: 'A short guided tour, then add your first account.' },
                { name: '/help', value: 'This menu.' },
                { name: '/invite', value: 'Invite the bot to another server.' },
            ),
    },
    {
        id: 'tracking', emoji: '📡', label: 'Tracking',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle(`🔔 ${BUILD_NAME} — Tracking`)
            .addFields(
                { name: '/social add', value: 'Track an account: pick a platform, enter the handle or URL, choose a channel.' },
                { name: '/social list', value: 'See everything you track. Pick one to edit, pause or remove it.' },
                { name: '/social preview', value: 'Preview a notification without waiting for a post.' },
                { name: '/social check', value: 'Check all accounts now.' },
                { name: 'Batching', value: '2 or more posts in the same channel within 10 minutes merge into one message. Tune it under Manage, Batch Settings.' },
            ),
    },
    {
        id: 'linking', emoji: '🔗', label: 'Linking',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle(`🔔 ${BUILD_NAME} — Linking`)
            .setDescription("Instagram and TikTok need the account owner's consent.")
            .addFields(
                { name: '/social link', value: 'Link an Instagram or TikTok account. The owner opens the link and approves.' },
                { name: '/social links', value: 'See linked accounts. Pick one to unlink it.' },
            ),
    },
    {
        id: 'settings', emoji: '⚙️', label: 'Settings',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle(`🔔 ${BUILD_NAME} — Settings`)
            .addFields(
                { name: '/social access', value: 'Choose a role (besides admins) that can manage notifications.' },
            ),
    },
    {
        id: 'info', emoji: 'ℹ️', label: 'Info',
        build: () => new EmbedBuilder().setColor('#5865F2').setTitle(`🔔 ${BUILD_NAME} — Info`)
            .addFields(
                { name: 'Platforms', value: Object.values(PLATFORMS).map(p => `${p.emojiTag} ${p.label}${p.unavailable ? ' ⚠️' : ''}`).join('  ·  ') + '\n⚠️ = unavailable right now' },
                { name: 'Placeholders', value: '`{author}` `{handle}` `{platform}` `{title}` `{url}`, plus `{is/was}` for Live.' },
                { name: 'Check speed', value: 'Twitch, Kick, TikTok, Instagram: about every 20 seconds. Twitter and Bluesky: every 2 minutes. YouTube: new uploads and streams arrive instantly by push, with a backup check every 20 minutes (every 2 minutes if push is not active for that channel).' },
                { name: 'Legal', value: `[Terms of Service](${LEGAL_BASE_URL}/terms) • [Privacy Policy](${LEGAL_BASE_URL}/privacy)` },
                { name: 'Links', value: `[GitHub](https://github.com/sleepyturtler/Notifyer) • [top.gg](https://top.gg/bot/1515779889737896006)` },
            ),
    },
];
// Beta-only — see debugTools.js. Pushed here rather than inline above so this array
// is identical whether or not that file is present.
if (debugTools) HELP_CATEGORIES.push(debugTools.getExtraHelpCategory());

// ── /setup wizard ────────────────────────────────────────────────────────
// Tabs of the /setup tour. Every tab keeps the "Add account" button, which starts the unchanged
// first-watch flow (setup_start -> platform -> handle -> channel -> types/messages/batch header).
const SETUP_TABS = [
    { id: 'welcome', label: 'Welcome' },
    { id: 'track', label: 'Track' },
    { id: 'customize', label: 'Customize' },
    { id: 'batching', label: 'Batching' },
    { id: 'admin', label: 'Admin' },
];

function buildSetupView(tabId, watchCount = 0) {
    const tab = SETUP_TABS.find(t => t.id === tabId) || SETUP_TABS[0];
    const oauthAvailable = ['instagram', 'tiktok'].some(k => PLATFORMS[k] && !PLATFORMS[k].unavailable);
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle(`Notifyer setup: ${tab.label}`);
    const n = watchCount;
    switch (tab.id) {
        case 'welcome':
            embed.setDescription(
                'Notifyer posts in a channel when an account you track uploads, posts or goes live.\n\n' +
                `**Platforms:** ${Object.values(PLATFORMS).map(p => p.label + (p.unavailable ? ' (unavailable)' : '')).join(', ')}\n\n` +
                'Click through the tabs to see how it works, then add your first account.');
            break;
        case 'track':
            embed.setDescription(
                (n ? `You're tracking **${n}** account${n > 1 ? 's' : ''}.\n\n` : '') +
                '`/social add` Track an account: pick a platform, enter a handle or URL, pick a channel.\n' +
                '`/social list` See every tracked account. Pick one to manage it.\n' +
                '`/social preview` See a sample notification for any account.\n' +
                '`/social check` Check everything now instead of waiting.' +
                (oauthAvailable ? '\n`/social link` Link an Instagram or TikTok account first. The owner approves it.' : ''));
            break;
        case 'customize':
            embed.setDescription(
                'In `/social list`, pick an account, then:\n' +
                '**Edit Messages** Write your own text per post type. Placeholders: `{author}` `{title}` `{url}` `{platform}` `{handle}` (`{is/was}` for Live).\n' +
                '**Ping Role** Mention a role with every post.\n' +
                '**Edit Types** Choose which post types are announced.\n' +
                '**Change Channel, Pause, Remove** do what they say.');
            break;
        case 'batching':
            embed.setDescription(
                'Two or more posts in the same channel within 10 minutes become **one** combined message, so busy accounts do not flood the channel.\n\n' +
                '**Batch Settings** (in Manage) sets how many posts it takes and whether channels can share a batch. It applies to the whole server.\n' +
                '**Batching: On/Off** (in Manage) turns it off for one account.\n' +
                'Live streams always post on their own.');
            break;
        case 'admin':
            embed.setDescription(
                '`/social access` Let a role besides admins manage the bot.\n' +
                'In every channel you post to, the bot needs **View Channel, Send Messages, Embed Links** and **Read Message History**.\n' +
                "If a post can't be delivered, an admin channel gets a short report with a link to fix it.\n" +
                '`/help` lists every command.');
            break;
    }
    const tabs = new ActionRowBuilder().addComponents(SETUP_TABS.map(t =>
        new ButtonBuilder().setCustomId(`setup_tab_${t.id}`).setLabel(t.label).setStyle(t.id === tab.id ? ButtonStyle.Primary : ButtonStyle.Secondary)));
    const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_start').setLabel(n ? 'Add another account' : 'Add my first account').setStyle(ButtonStyle.Success),
        ...(tab.id === 'customize' ? [new ButtonBuilder().setCustomId('setup_sample').setLabel('Show me a sample').setStyle(ButtonStyle.Secondary)] : []),
    );
    return { embeds: [embed], components: [tabs, actions] };
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

module.exports = { buildBatchHeaderModal, buildBatchSettingsView, buildHelpView, buildManageView, buildPerTypeMessageModal, buildSetupView, buildSocialLinkManageView, buildSocialLinksEmbed, buildWatchListEmbed };
