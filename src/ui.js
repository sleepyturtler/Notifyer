// View builders: watch list, manage, linked accounts, batch settings, help and the setup tour. All of them are Components V2:
// one accent-colored container with its sections divided by separators, and the buttons and menus under it.

const { ButtonBuilder, ButtonStyle, ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { getPushCoveredYouTubeChannels, getSocialLinksVisible, getWatches } = require('./db.js');
const { describePollFrequency } = require('./rssPoll.js');
const { LEGAL_BASE_URL, PLATFORMS, PLATFORM_NOTIFY_TYPES, activeTypeIds, linkablePlatforms } = require('./config.js');
const { DEFAULT_BATCH_HEADER, MAX_BATCH_ENTRIES_PER_MESSAGE } = require('./batch.js');
const { canWatchBatch, watchName } = require('./helpers.js');
const { GREEN, ORANGE, RED, clip, toInt, view } = require('./v2.js');
const fs = require('fs');
const path = require('path');
// Beta-only "Admin" help category (see debugTools.js), only added if that file is present in this build's src/.
const debugTools = fs.existsSync(path.join(__dirname, 'debugTools.js')) ? require('./debugTools.js') : null;
// Help title: "Notifyer Beta" on a build that has debugTools.js, plain "Notifyer" without it,
// so removing that one file is all it takes to turn a beta build into a release build.
const BUILD_NAME = debugTools ? 'Notifyer Beta' : 'Notifyer';

const refreshBtn = (id) => new ButtonBuilder().setCustomId(id).setLabel('\u21bb Refresh').setStyle(ButtonStyle.Secondary);

// A page stays small on purpose: a V2 message holds at most 4000 characters of text and a watch's entry can run to a few hundred.
const WATCHES_PER_PAGE = 4;

async function buildWatchListEmbed(guildId, page = 0) {
    const watches = await getWatches(guildId);
    if (!watches.length) return view(RED, ['## Watches\nNo accounts are being tracked yet. Use `/social add` to add one.']);
    const STALE_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
    const pages = Math.ceil(watches.length / WATCHES_PER_PAGE);
    page = Math.min(Math.max(Number.isInteger(page) ? page : 0, 0), pages - 1);
    const shown = watches.slice(page * WATCHES_PER_PAGE, (page + 1) * WATCHES_PER_PAGE);
    // Only YouTube's text depends on live data (whether push is confirmed for the channel).
    const pushCovered = shown.some(x => x.platform === 'youtube') ? await getPushCoveredYouTubeChannels().catch(() => null) : null;
    const blocks = [`## Watches\nTracking ${watches.length} account${watches.length > 1 ? 's' : ''}`];
    for (const w of shown) {
        const p = PLATFORMS[w.platform];
        const lines = [
            `Posts to <#${w.channel_id}>`,
            `ID: \`${w.id}\``,
            `Checks: ${describePollFrequency(w, pushCovered)}`,
            w.message_template ? `Custom message: \`${w.message_template.slice(0, 80)}${w.message_template.length > 80 ? '\u2026' : ''}\`` : 'Using default message',
        ];
        if (w.last_post_at) {
            lines.push(`Last post: <t:${Math.floor(w.last_post_at / 1000)}:R>`);
        } else if (w.last_post_id === null) {
            lines.push('Last post: not checked yet');
        } else {
            lines.push('Last post: none detected yet');
        }
        if (w.role_id) lines.push(`Ping: <@&${w.role_id}>`);
        if (!w.active) lines.push('\u23f8\ufe0f Paused');
        if (w.last_error) {
            lines.push(`\u26a0\ufe0f Last check failed: \`${String(w.last_error).slice(0, 150)}\``);
        } else if (w.last_post_at && (Date.now() - w.last_post_at) > STALE_MS) {
            lines.push('\u26a0\ufe0f No new posts in over 60 days');
        }
        if (p.unavailable) lines.push(`-# \u26a0\ufe0f ${p.label} is currently unavailable \u2014 see \`/help\` \u2192 Info for why.`);
        const head = `**${p.emojiTag} ${p.label} \u2014 ${watchName(w)}**${p.unavailable ? ' *(unavailable)*' : ''}${w.active ? '' : ' (paused)'}`;
        blocks.push(clip([head, ...lines].join('\n'), 900));
    }
    blocks.push(`-# ${pages > 1 ? `Page ${page + 1} of ${pages} \u00b7 ` : ''}<t:${Math.floor(Date.now() / 1000)}:t>`);
    const nav = [refreshBtn(`sociallist_refresh_${guildId}_${page}`)];
    if (pages > 1) {
        nav.unshift(new ButtonBuilder().setCustomId(`sociallist_page_${guildId}_${page - 1}`).setLabel('\u25c0 Prev').setStyle(ButtonStyle.Secondary).setDisabled(page === 0));
        nav.splice(1, 0, new ButtonBuilder().setCustomId(`sociallist_page_${guildId}_${page + 1}`).setLabel('Next \u25b6').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1));
    }
    const rows = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallist_manage_${guildId}`).setPlaceholder('Manage a watch\u2026')
                .addOptions(shown.map(w => ({
                    label: `${PLATFORMS[w.platform].label}${PLATFORMS[w.platform]?.unavailable ? ' (unavailable)' : ''} \u2014 ${watchName(w)}`.slice(0, 100),
                    value: `${w.id}`,
                    emoji: PLATFORMS[w.platform]?.emojiButton,
                })))
        ),
        new ActionRowBuilder().addComponents(...nav),
    ];
    return view(ORANGE, blocks, rows);
}

// One tab per platform that needs linking; `platform` picks the tab (default: the first one that has a link).
async function buildSocialLinksEmbed(guildId, userId, platform = null) {
    const links = await getSocialLinksVisible(guildId, userId);
    const tabs = Object.keys(PLATFORMS).filter(k => PLATFORMS[k].oauth);
    const active = tabs.includes(platform) ? platform : (tabs.find(k => links.some(l => l.platform === k)) || tabs[0]);
    const p = PLATFORMS[active];
    const mine = links.filter(l => l.platform === active);
    const line = l => `\u2022 **${l.external_username}** (Linked by <@${l.linked_by}>)${l.needs_relink_at ? ' \u26a0\ufe0f needs re-link' : ''}`;
    const blocks = [
        '## Linked accounts',
        'Accounts this server tracks, plus accounts you linked. A linked account works in any server that uses Notifyer, and only the person who linked it can unlink it.',
        `${p.emojiTag} **${p.label}:**\n${clip(mine.map(line).join('\n') || '*(none)*', 1800)}`,
    ];
    const canLink = linkablePlatforms().length > 0;
    if (!links.length && !canLink) return view(RED, [...blocks, '-# Linking is not set up on this bot yet.']);
    const tabRow = new ActionRowBuilder().addComponents(
        ...tabs.map(k => new ButtonBuilder().setCustomId(`sociallinks_tab_${guildId}_${k}`).setLabel(PLATFORMS[k].label).setEmoji(PLATFORMS[k].emojiButton)
            .setStyle(k === active ? ButtonStyle.Primary : ButtonStyle.Secondary)),
        // Nothing linked yet: offer to link one right here (the same sign-in a /social link would start).
        ...(!links.length ? [new ButtonBuilder().setCustomId(`sociallinks_add_${guildId}`).setLabel('Link an account').setStyle(ButtonStyle.Success)] : []),
    );
    const rows = [tabRow];
    if (mine.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sociallinks_manage_${guildId}`).setPlaceholder('Manage a linked account\u2026')
                .addOptions(mine.slice(0, 25).map(l => ({
                    label: `${PLATFORMS[l.platform].label} \u2014 ${l.external_username}`.slice(0, 100),
                    value: `${l.platform}:${l.id}`,
                    emoji: PLATFORMS[l.platform]?.emojiButton,
                })))
        ));
    }
    return view(RED, blocks, rows);
}

// canUnlink: only the person who linked it (or the bot owner) may; usage = { watches, guilds } across all servers.
function buildSocialLinkManageView(link, { guildId, canUnlink = false, usage = null } = {}) {
    const p = PLATFORMS[link.platform];
    const info = [
        `**Platform:** ${p.label}`,
        `**Linked by:** <@${link.linked_by}>`,
        `**Status:** ${link.needs_relink_at ? '\u26a0\ufe0f Needs re-link (`/social link`)' : '\u2705 Working'}`,
        ...(usage ? [`**Used by:** ${usage.watches} watch${usage.watches === 1 ? '' : 'es'} in ${usage.guilds} server${usage.guilds === 1 ? '' : 's'}`] : []),
    ].join('\n');
    const row = new ActionRowBuilder();
    if (canUnlink) row.addComponents(new ButtonBuilder().setCustomId(`sociallinkmanage_unlink_${link.platform}_${link.id}`).setLabel('Unlink').setStyle(ButtonStyle.Danger));
    row.addComponents(new ButtonBuilder().setCustomId(`sociallinkmanage_back_${guildId}`).setLabel('\u2190 Back to List').setStyle(ButtonStyle.Secondary));
    return view(toInt(p.color), [`## Manage Link \u2014 ${p.emojiTag} ${link.external_username}`, info, ...(canUnlink ? [] : ['-# Only the person who linked this account can unlink it.'])], [row]);
}

// Shared modal builder used both from the manage view's "Edit Messages"
// button and from the new guided /social add flow, so both stay in sync.
// isNewFlow tags the modal's customId so its submit handler knows whether to
// continue the add-flow wizard (offer the batch-header step next) or just
// return to the manage view, since this same modal serves both entry points.
function buildPerTypeMessageModal(w, isNewFlow = false) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const templates = w.message_templates || {};
    const modal = new ModalBuilder().setCustomId(`socialpertype_modal_${w.id}${isNewFlow ? '_new' : ''}`).setTitle(`Edit Messages for ${watchName(w)}`.slice(0, 45));
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
    const typesText = (Array.isArray(w.notify_types) && w.notify_types.length) ? w.notify_types.map(t => PLATFORM_NOTIFY_TYPES[w.platform]?.find(x => x.id === t)?.label || t).join(', ') : ((PLATFORM_NOTIFY_TYPES[w.platform] || []).some(t => t.defaultOff) ? activeTypeIds(w).map(id => PLATFORM_NOTIFY_TYPES[w.platform].find(x => x.id === id).label).join(', ') : 'All types');
    const info = [
        `**Types:** ${typesText}`,
        `**Ping Role:** ${w.role_id ? `<@&${w.role_id}>` : 'None'}`,
        `**Channel:** <#${w.channel_id}>`,
        ...(w.active ? [] : ['**Status:** \u23f8\ufe0f Paused']),
    ].join('\n');
    const blocks = [`## Manage - ${p.emojiTag} ${watchName(w)}`, info, `**Messages:**\n${describeMessages(w)}`];
    if (p.unavailable) blocks.push(`**\u26a0\ufe0f Unavailable**\n${p.label} isn't working right now (see /help, Info). Your settings are kept.`);
    // A watch can only ever contribute to a batch if at least one of its active notify types isn't "live" (live events
    // always send individually, see pollAll), so a Kick watch (live-only) or a YouTube watch restricted to just Live
    // can never actually batch, regardless of platform.
    const batchPossible = canWatchBatch(w); // this watch has at least one non-live type
    const canBatch = batchPossible && !w.batch_disabled;
    if (batchPossible && w.batch_disabled) blocks.push('**Batching:**\nOff for this watch. Its posts always send on their own.');
    else if (canBatch) blocks.push(`**Batching:**\n**Header:** \`${w.batch_header_template || DEFAULT_BATCH_HEADER}\` (use \`{creators}\` to list accounts).`);
    blocks.push('**Placeholders:**\n\u2022 General: `{author}` `{handle}` `{platform}` `{title}` `{url}`\n\u2022 Lives: `{is/was}` (is/was live) and `{category}`');
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_channel_${w.id}`).setLabel('Change Channel').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_role_${w.id}`).setLabel('Change Ping Role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`socialmanage_types_${w.id}`).setLabel('Edit Types').setStyle(ButtonStyle.Secondary),
    );
    // Batch Settings is server-wide (min posts / cross-channel), so it is offered on every watch.
    const row2 = new ActionRowBuilder().addComponents(
        ...(batchPossible ? [new ButtonBuilder().setCustomId(`socialmanage_togglebatch_${w.id}`).setLabel(w.batch_disabled ? 'Batching: Off' : 'Batching: On').setStyle(w.batch_disabled ? ButtonStyle.Secondary : ButtonStyle.Success)] : []),
        new ButtonBuilder().setCustomId(`socialmanage_batchsettings_${w.id}`).setLabel('Batch Settings').setStyle(ButtonStyle.Secondary),
    );
    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialmanage_toggle_${w.id}`).setLabel(w.active ? 'Pause' : 'Resume').setStyle(w.active ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`socialmanage_remove_${w.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`socialmanage_back_${w.id}`).setLabel('\u2190 Back to list').setStyle(ButtonStyle.Secondary),
    );
    return view(toInt(p.color), blocks, [row1, row2, row3]);
}

// Server-wide batch settings, reached from a watch's manage view. cfg is the guild config; w is only used to route the Back button.
function buildBatchSettingsView(w, cfg) {
    const minPosts = cfg.batchMinThreshold || 2;
    const cross = !!cfg.batchCrossChannel;
    const body = 'Applies to every watch in this server.\n\n' +
        `**Posts needed to combine**\n\`${minPosts}\` posts within 10 minutes merge into one message.\n\n` +
        `**Batch across channels**\n${cross ? '\u2705 On: one batch can span every channel' : '\u274c Off: batches stay within one channel'}`;
    const options = [];
    for (let n = 2; n <= MAX_BATCH_ENTRIES_PER_MESSAGE; n++) options.push({ label: `${n} posts`, value: String(n), default: n === minPosts });
    return view(RED, ['## Batch Settings', body], [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`socialbatchsettings_min_${w.id}`).setPlaceholder('Posts needed to combine').addOptions(options)),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`socialbatchsettings_cross_${w.id}`).setLabel(cross ? 'Cross-channel: On' : 'Cross-channel: Off').setStyle(cross ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`socialmanage_backto_${w.id}`).setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
        ),
    ]);
}

// \u2500\u2500 Help (tabbed) \u2500\u2500
// build() returns the text sections under the title. Command lists are one bulleted section; Info has one section per topic.
const bullets = items => items.map(i => `\u2022 **${i.name}**\n${i.value}`).join('\n');
const HELP_CATEGORIES = [
    {
        id: 'general', label: 'General',
        build: () => [bullets([
            { name: '/setup', value: 'A short guided tour, then add your first account.' },
            { name: '/help', value: 'This menu.' },
            { name: '/invite', value: 'Invite the bot to another server.' },
        ])],
    },
    {
        id: 'watches', label: 'Watches',
        build: () => [bullets([
            { name: '/social add', value: 'Track an account: pick a platform, enter the handle or URL, choose a channel.' },
            { name: '/social list', value: 'See everything you track. Pick one to edit, pause or remove it.' },
            { name: '/social customize', value: 'Customize how notifications look: preview, post text, batch header, ping role, color and image, then Save.' },
            { name: '/social check', value: 'Check all accounts now.' },
            { name: 'Batching', value: '2 or more posts in the same channel within 10 minutes merge into one message. Tune it under Manage, Batch Settings.' },
        ])],
    },
    {
        id: 'linking', label: 'Linking',
        build: () => ["Instagram and TikTok need the account owner's consent.", bullets([
            { name: '/social link', value: 'Link an Instagram or TikTok account once. The owner approves. It then works in any server.' },
            { name: '/social links', value: 'See linked accounts used here or linked by you. Whoever linked one can unlink it.' },
        ])],
    },
    {
        id: 'settings', label: 'Settings',
        build: () => [bullets([
            { name: '/social access', value: 'Choose a role (besides admins) that can manage notifications.' },
        ])],
    },
    {
        id: 'info', label: 'Info',
        build: () => [
            `**Platforms**\n${Object.values(PLATFORMS).filter(p => !p.restricted).map(p => `${p.emojiTag} ${p.label}${p.unavailable ? ' \u26a0\ufe0f' : ''}`).join('  \u00b7  ')}\n\u26a0\ufe0f = unavailable right now`,
            '**Placeholders**\n`{author}` `{handle}` `{platform}` `{title}` `{url}`, plus `{is/was}` for Live.',
            '**Check speed**\n' + 'Twitch, Kick, TikTok, Instagram: about every 20 seconds. Bluesky: every 2 minutes. Twitter and RSS: adapts to how often the account posts (Twitter 2 to 30 min, RSS 2 to 60 min). YouTube: new uploads and streams arrive instantly by push, with a backup check every 20 minutes (every 2 minutes if push is not active for that channel).',
            `**Legal**\n[Terms of Service](${LEGAL_BASE_URL}/terms) \u2022 [Privacy Policy](${LEGAL_BASE_URL}/privacy)`,
            '**Links**\n[GitHub](https://github.com/sleepyturtler/Notifyer) \u2022 [top.gg](https://top.gg/bot/1515779889737896006)',
        ],
    },
];
// Beta-only (see debugTools.js). Pushed here rather than inline above so this array is identical whether or not that file is present.
if (debugTools) HELP_CATEGORIES.push(debugTools.getExtraHelpCategory());

function buildHelpView(activeId) {
    const active = HELP_CATEGORIES.find(c => c.id === activeId) || HELP_CATEGORIES[0];
    const buttons = HELP_CATEGORIES.map(c => new ButtonBuilder()
        .setCustomId(`help_cat_${c.id}`)
        .setLabel(c.label)
        .setStyle(c.id === active.id ? ButtonStyle.Primary : ButtonStyle.Secondary));
    // Chunk into rows of up to 5 buttons (Discord's per-row limit)
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return view(RED, [`## ${BUILD_NAME} - ${active.label}`, ...active.build()], rows);
}

// \u2500\u2500 /setup wizard \u2500\u2500
// Tabs of the /setup tour. Every tab keeps the "Add account" button, which starts the unchanged
// first-watch flow (setup_start -> platform -> handle -> channel -> types/messages/batch header).
const SETUP_TABS = [
    { id: 'welcome', label: 'Welcome' },
    { id: 'track', label: 'Watches' },
    { id: 'customize', label: 'Customize' },
    { id: 'batching', label: 'Batching' },
    { id: 'admin', label: 'Admin' },
];

function buildSetupView(tabId, watchCount = 0) {
    const tab = SETUP_TABS.find(t => t.id === tabId) || SETUP_TABS[0];
    const oauthAvailable = ['instagram', 'tiktok'].some(k => PLATFORMS[k] && !PLATFORMS[k].unavailable);
    const n = watchCount;
    let body = '';
    switch (tab.id) {
        case 'welcome':
            body = 'Notifyer posts in a channel when an account you track uploads, posts or goes live.\n\n' +
                `**Platforms:** ${Object.values(PLATFORMS).filter(p => !p.restricted).map(p => p.label + (p.unavailable ? ' (unavailable)' : '')).join(', ')}\n\n` +
                'Click through the tabs to see how it works, then add your first account.';
            break;
        case 'track':
            body = (n ? `You're tracking **${n}** account${n > 1 ? 's' : ''}.\n\n` : '') +
                '`/social add` Track an account: pick a platform, enter a handle or URL, pick a channel.\n' +
                '`/social list` See every tracked account. Pick one to manage it.\n' +
                "`/social customize` Customize a watch's notification: live preview, then Save.\n" +
                '`/social check` Check everything now instead of waiting.' +
                (oauthAvailable ? '\n`/social link` Link an Instagram or TikTok account first. The owner approves it, once, for every server.' : '');
            break;
        case 'customize':
            body = '`/social customize` Pick an account, preview its notification and change it: the message, batch header, ping role, embed color, image size, or turn the embed off. Nothing applies until you press **Save**.\n\n' +
                'In `/social list`, pick an account to **Change Channel**, **Change Ping Role**, **Edit Types**, **Pause** or **Remove** it.\n' +
                'Placeholders: `{author}` `{title}` `{url}` `{platform}` `{handle}` (`{is/was}` for Live).';
            break;
        case 'batching':
            body = 'Two or more posts in the same channel within 10 minutes become **one** combined message, so busy accounts do not flood the channel.\n\n' +
                '**Batch Settings** (in Manage) sets how many posts it takes and whether channels can share a batch. It applies to the whole server.\n' +
                '**Batching: On/Off** (in Manage) turns it off for one account. The batch header is edited in `/social customize`.\n' +
                'Live streams always post on their own.';
            break;
        case 'admin':
            body = '`/social access` Let a role besides admins manage the bot.\n' +
                'In every channel you post to, the bot needs **View Channel, Send Messages, Embed Links** and **Read Message History**.\n' +
                "If a post can't be delivered, an admin channel gets a short report with a link to fix it.\n" +
                '`/help` lists every command.';
            break;
    }
    const tabs = new ActionRowBuilder().addComponents(SETUP_TABS.map(t =>
        new ButtonBuilder().setCustomId(`setup_tab_${t.id}`).setLabel(t.label).setStyle(t.id === tab.id ? ButtonStyle.Primary : ButtonStyle.Secondary)));
    const actions = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup_start').setLabel(n ? 'Add another account' : 'Add my first account').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('setup_sample').setLabel('Preview').setStyle(ButtonStyle.Secondary),
    );
    return view(RED, [`## Notifyer setup - ${tab.label}`, body], [tabs, actions]);
}

module.exports = { WATCHES_PER_PAGE, buildBatchHeaderModal, buildBatchSettingsView, buildHelpView, buildManageView, buildPerTypeMessageModal, buildSetupView, buildSocialLinkManageView, buildSocialLinksEmbed, buildWatchListEmbed };
