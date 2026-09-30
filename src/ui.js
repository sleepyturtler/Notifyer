// Embed/modal/view builders: watch list, manage view, help, setup wizard screens.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { ButtonBuilder, ButtonStyle, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getSocialLinks, getWatches } = require('./db.js');
const { LEGAL_BASE_URL, PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { DEFAULT_BATCH_HEADER } = require('./batch.js');
const { DEFAULT_TEMPLATE, PLACEHOLDER_HELP } = require('./notify.js');
const { canWatchBatch, isLegacyMessageFormat } = require('./helpers.js');
const fs = require('fs');
const path = require('path');
// Beta-only "Admin" help category (see debugTools.js) — only added if that file is
// present in this build's src/.
const debugTools = fs.existsSync(path.join(__dirname, 'debugTools.js')) ? require('./debugTools.js') : null;

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

// Shared modal builder used both from the manage view's "Per-Type Messages"
// button and from the new guided /social add flow, so both stay in sync.
// isNewFlow tags the modal's customId so its submit handler knows whether to
// continue the add-flow wizard (offer the batch-header step next) or just
// return to the manage view, since this same modal serves both entry points.
function buildPerTypeMessageModal(w, isNewFlow = false) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const modal = new ModalBuilder().setCustomId(`socialpertype_modal_${w.id}${isNewFlow ? '_new' : ''}`).setTitle(`Per-Type Messages — ${w.handle}`.slice(0, 45));
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

// Shared by the manage view's "📦 Batch Header" button and the guided add-flow's
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
    const canBatch = canWatchBatch(w);
    if (canBatch) embed.addFields({ name: 'Batch header', value: `${w.batch_header_template ? `\`${w.batch_header_template}\`` : `Default: \`${DEFAULT_BATCH_HEADER}\``}\n\`{author}\`/\`{handle}\`/\`{platform}\`/\`{count}\` work as usual; use \`{creators}\` instead of \`{author}\` if you want this header to also read well when more than one tracked account contributes to the same batch (e.g. "X and Y posted 5 times!").` });
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
                { name: '📦 Batched notifications', value: 'If a second new post lands in the same channel for the same platform within 10 minutes of the last one — whether from one account or several tracked accounts — the earlier message is turned into a combined one instead of pinging again: a header line, then a compact title+button per post. Each further post within 10 minutes of the last keeps extending the same message. Customize the header from a watch\'s manage view ("📦 Batch Header") — use `{creators}` instead of `{author}` if you want it to also read well with multiple accounts (e.g. "X and Y posted 5 times!"); otherwise a batch with more than one account falls back to that generic form automatically. "Went live" notifications are never batched.' },
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
                { name: 'Notes', value: 'TikTok, Instagram, Twitch, and Kick are checked about every 20 seconds; YouTube and Twitter are checked every 2 minutes — YouTube to conserve API quota (new uploads/live starts still arrive near-instantly via push notifications), Twitter because it relies on unofficial scraping and needs a gentler pace. New watches start tracking from the next post onward (no notification for existing content). Twitter relies on unofficial scraping and may occasionally fail or lag.' },
                { name: 'Legal', value: `[Terms of Service](${LEGAL_BASE_URL}/terms) • [Privacy Policy](${LEGAL_BASE_URL}/privacy)` },
                { name: 'Links', value: `[GitHub](https://github.com/DaniBottoni/Notifyer/tree/main) • [top.gg](https://top.gg/bot/1515779889737896006)` },
            ),
    },
];
// Beta-only — see debugTools.js. Pushed here rather than inline above so this array
// is identical whether or not that file is present.
if (debugTools) HELP_CATEGORIES.push(debugTools.getExtraHelpCategory());

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

module.exports = { buildBatchHeaderModal, buildHelpView, buildManageView, buildPerTypeMessageModal, buildSetupIntroEmbed, buildSetupIntroRow, buildSetupReturningEmbed, buildSocialLinkManageView, buildSocialLinksEmbed, buildWatchListEmbed };
