// /social customize: the notification customizer. It opens a live preview of one watch's notification, and everything that
// shapes it can be changed there: the post type shown, the message, the batch header, the ping role per post type, and the look
// (card or embed, on/off, image size, where the post text goes, accent color). "Apply to..." copies the look to other watches or
// saves it as the server's default. Changes live in a draft and only apply on Save.
//
// The preview is the real thing: a card is a Components V2 message and an embed is a classic message, and Discord cannot turn one
// into the other, so when a change flips the look between the two, the editor continues in a new private message (see show()).
// The ping-role and apply screens are drawn in whichever kind the editor message already is.

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { canWatchBatch, watchName } = require('./helpers.js');
const { copyWatchCustomization, getConfig, getWatch, getWatches, saveConfig, saveWatchCustomization } = require('./db.js');
const { NATIVE_VIDEO_PLATFORMS, buildNotificationPayload, buildSamplePost, lookOf, styleOf } = require('./notify.js');
const { DEFAULT_BATCH_HEADER } = require('./batch.js');
const { RED, isV2Part, view: v2view } = require('./v2.js');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const drafts = new Map(); // `${userId}:${watchId}` -> draft
const HEX_RE = /^#?([0-9a-f]{6})$/i;
const IMAGE_CYCLE = { large: 'small', small: 'none', none: 'large' };
const WHAT = [
    { value: 'look', label: 'Look', description: 'Card or embed, color, image, text placement' },
    { value: 'message', label: 'Message text', description: 'The message for each post type they share' },
    { value: 'header', label: 'Batch header' },
    { value: 'roles', label: 'Ping roles', description: 'The default role and the role per post type' },
];

const keyOf = (userId, watchId) => `${userId}:${watchId}`;
function sweep() { const now = Date.now(); for (const [k, d] of drafts) if (now - d.touched > DRAFT_TTL_MS) drafts.delete(k); }

// Only non-default values are stored, so a watch nobody customized keeps a NULL column and today's exact look.
function cleanSettings(es) {
    const out = {};
    if (es.embed === false) out.embed = false;
    if (es.style === 'card' || es.style === 'embed') out.style = es.style;
    if (es.image === 'small' || es.image === 'none') out.image = es.image;
    if (es.text === 'message') out.text = 'message';
    if (typeof es.color === 'string' && /^#[0-9a-f]{6}$/i.test(es.color)) out.color = es.color.toLowerCase();
    return out;
}
const cleanRoles = roles => Object.fromEntries(Object.entries(roles || {}).filter(([, v]) => v));
const typesOf = w => PLATFORM_NOTIFY_TYPES[w.platform] || [];

function newDraft(w, defaultLook = null) {
    const types = typesOf(w).length ? typesOf(w) : [{ id: null, label: 'Post' }];
    const d = {
        watchId: w.id, watch: w, type: types[0].id, view: 'main', defaultLook,
        es: cleanSettings(w.embed_settings || {}), role_id: w.role_id || null, type_roles: cleanRoles(w.type_roles),
        templates: { ...(w.message_templates || {}) }, header: w.batch_header_template || null,
        roleType: '*', applyScope: 'platform', applyWhat: ['look'], applyPick: [],
        touched: Date.now(),
    };
    d.baseline = snapshot(d);
    return d;
}
const snapshot = d => JSON.stringify([cleanSettings(d.es), d.role_id, cleanRoles(d.type_roles), d.templates, d.header]);
const isDirty = d => snapshot(d) !== d.baseline;
const draftWatch = d => ({
    ...d.watch, default_look: d.defaultLook || undefined, embed_settings: cleanSettings(d.es), role_id: d.role_id, type_roles: cleanRoles(d.type_roles),
    message_templates: d.templates, batch_header_template: d.header,
});
const typeLabel = (w, id) => typesOf(w).find(t => t.id === id)?.label || 'Post';
const isV2View = view => (view.components || []).some(isV2Part);
const isV2Msg = interaction => Boolean(interaction.message?.flags?.has?.(MessageFlags.IsComponentsV2));

// What Discord shows for a YouTube/TikTok link left to Discord (the embed style), drawn from the fake sample post.
function fakeUnfurl(w, post) {
    const p = PLATFORMS[w.platform];
    const e = new EmbedBuilder().setColor(p.color).setAuthor({ name: String(post.author || watchName(w)).slice(0, 256) })
        .setTitle(String(post.title).slice(0, 256)).setURL(post.url).setFooter({ text: p.label });
    if (post.thumbnail) e.setImage(post.thumbnail);
    return e;
}

// ---- the main screen: the real notification, then the controls
function buildMainView(d, note = null) {
    const w = draftWatch(d);
    const types = typesOf(w);
    const sample = buildSamplePost(w, d.type, { withImage: true }); // a made-up title and thumbnail(s)
    const payload = buildNotificationPayload(w, sample);
    const es = cleanSettings(d.es);
    const eff = styleOf(w, sample, lookOf(w));
    const native = NATIVE_VIDEO_PLATFORMS.has(w.platform) && eff === 'embed'; // Discord draws the embed itself from the link
    const embedOff = es.embed === false;
    let { content, embeds } = payload;
    if (native) {
        // The real message is just the link. The preview draws what Discord shows for it from the fake title and thumbnail, and keeps the
        // link itself from unfurling so there is only one embed. With the embed off, the real message is sent with its unfurl suppressed.
        if (payload.embedUrl) content = content.split(payload.embedUrl).join(`<${payload.embedUrl}>`);
        embeds = payload.suppressEmbeds ? [] : [fakeUnfurl(w, sample)];
    }
    const rows = [];
    if (types.length > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sc_type_${d.watchId}`).setPlaceholder('Choose the post type you want to preview')
                .addOptions(types.map(t => ({ label: t.label, value: t.id, default: t.id === d.type })))
        ));
    }
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_msg_${d.watchId}`).setLabel('Edit message').setStyle(ButtonStyle.Primary),
        ...(canWatchBatch(w) ? [new ButtonBuilder().setCustomId(`sc_hdr_${d.watchId}`).setLabel('Batch Header').setStyle(ButtonStyle.Secondary)] : []),
        new ButtonBuilder().setCustomId(`sc_rolebtn_${d.watchId}`).setLabel('Ping role').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`sc_color_${d.watchId}`).setLabel('Embed color').setStyle(ButtonStyle.Secondary).setDisabled(native || embedOff),
        new ButtonBuilder().setCustomId(`sc_image_${d.watchId}`).setLabel('Image').setStyle(ButtonStyle.Secondary).setDisabled(native || embedOff),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_text_${d.watchId}`).setLabel(es.text === 'message' ? 'Text - In message' : 'Text - In embed').setStyle(ButtonStyle.Primary).setDisabled(native),
        new ButtonBuilder().setCustomId(`sc_style_${d.watchId}`).setLabel(eff === 'card' ? 'Style: Card' : (NATIVE_VIDEO_PLATFORMS.has(w.platform) ? 'Style: Native' : 'Style: Embed')).setStyle(ButtonStyle.Secondary).setDisabled(embedOff),
        new ButtonBuilder().setCustomId(`sc_embed_${d.watchId}`).setLabel('Embed').setStyle(embedOff ? ButtonStyle.Danger : ButtonStyle.Success),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_reset_${d.watchId}`).setLabel('RESET').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sc_close_${d.watchId}`).setLabel('Discard').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sc_save_${d.watchId}`).setLabel('Save').setStyle(ButtonStyle.Success).setDisabled(!isDirty(d)),
        new ButtonBuilder().setCustomId(`sc_apply_${d.watchId}`).setLabel('Apply to\u2026').setStyle(ButtonStyle.Secondary).setDisabled(isDirty(d)),
    ));
    if (payload.v2) {
        // a card: the notification's own components, then the controls
        return { components: [...(note ? [new TextDisplayBuilder().setContent(note)] : []), ...payload.components, ...rows], allowedMentions: { parse: [] } };
    }
    return { content: [note, content].filter(Boolean).join('\n').slice(0, 2000), embeds, components: rows, allowedMentions: { parse: [] } };
}

// A screen made of text sections and rows, drawn as a container in a card editor and as a classic embed in an embed editor.
function panelView(v2, title, blocks, rows) {
    if (v2) return v2view(RED, [`## ${title}`, ...blocks], rows);
    return { content: '', embeds: [new EmbedBuilder().setColor(RED).setTitle(title).setDescription(blocks.join('\n\n').slice(0, 4000))], components: rows, allowedMentions: { parse: [] } };
}

// ---- ping roles: one per post type, plus a default for the types without their own
function buildRolesView(d, v2, note = null) {
    const w = draftWatch(d);
    const types = typesOf(w);
    const mention = id => (id ? `<@&${id}>` : 'none');
    const lines = [`**All types (default):** ${mention(d.role_id)}`, ...types.map(t => `**${t.label}:** ${d.type_roles[t.id] ? mention(d.type_roles[t.id]) : `default (${mention(d.role_id)})`}`)];
    const current = d.roleType === '*' ? d.role_id : d.type_roles[d.roleType];
    const picking = d.roleType === '*' ? 'All types (default)' : typeLabel(w, d.roleType);
    const role = new RoleSelectMenuBuilder().setCustomId(`sc_rrole_${d.watchId}`).setPlaceholder(`Role to ping for: ${picking}`).setMinValues(0).setMaxValues(1);
    if (current) role.setDefaultRoles(current);
    const rows = [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sc_rtype_${d.watchId}`).setPlaceholder('Choose a post type')
            .addOptions([{ label: 'All types (default)', value: '*', default: d.roleType === '*' }, ...types.map(t => ({ label: t.label, value: t.id, default: t.id === d.roleType }))])),
        new ActionRowBuilder().addComponents(role),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`sc_rclear_${d.watchId}`).setLabel('Clear role').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`sc_rback_${d.watchId}`).setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
        ),
    ];
    return panelView(v2, `Ping roles - ${watchName(w)}`, [
        ...(note ? [note] : []),
        'Pick a post type, then the role to ping for it. A type without its own role uses the default.',
        lines.join('\n'),
    ], rows);
}

// ---- apply to other watches / the server default
const SCOPES = [
    { value: 'platform', label: 'Every watch on this platform' },
    { value: 'all', label: 'Every watch in this server' },
    { value: 'pick', label: 'Pick watches' },
    { value: 'default', label: "Server default look (watches without their own)" },
];
function buildApplyView(d, v2, others = [], note = null) {
    const w = draftWatch(d);
    const rows = [
        new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sc_ascope_${d.watchId}`).setPlaceholder('Apply to')
            .addOptions(SCOPES.map(s => ({ ...s, default: s.value === d.applyScope })))),
    ];
    if (d.applyScope !== 'default') {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sc_awhat_${d.watchId}`).setPlaceholder('What to copy').setMinValues(1).setMaxValues(WHAT.length)
            .addOptions(WHAT.map(x => ({ ...x, default: d.applyWhat.includes(x.value) })))));
    }
    if (d.applyScope === 'pick') {
        rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`sc_apick_${d.watchId}`).setPlaceholder(others.length ? 'Which watches' : 'No other watches').setMinValues(0).setMaxValues(Math.max(Math.min(others.length, 25), 1))
            .addOptions(others.slice(0, 25).map(o => ({ label: `${PLATFORMS[o.platform]?.label || o.platform} - ${watchName(o)}`.slice(0, 100), value: String(o.id), default: d.applyPick.includes(o.id) }))
                .concat(others.length ? [] : [{ label: 'None', value: '0' }])))); // a menu needs at least one option
    }
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_aapply_${d.watchId}`).setLabel(d.applyScope === 'default' ? 'Save as server default' : 'Apply').setStyle(ButtonStyle.Success),
        ...(d.applyScope === 'default' ? [new ButtonBuilder().setCustomId(`sc_aclear_${d.watchId}`).setLabel('Clear server default').setStyle(ButtonStyle.Danger)] : []),
        new ButtonBuilder().setCustomId(`sc_aback_${d.watchId}`).setLabel('\u2190 Back').setStyle(ButtonStyle.Secondary),
    ));
    const look = cleanSettings(d.es);
    const text = d.applyScope === 'default'
        ? `The look of **${watchName(w)}** (${Object.keys(look).length ? Object.entries(look).map(([k, v]) => `${k}: ${v}`).join(', ') : 'the built-in look'}) becomes this server's default. Watches use it for anything they have not set themselves.`
        : 'Copies the saved settings of this watch onto the watches you choose. Look is on by default. Message text, batch header and roles only copy what the other watch can use.';
    return panelView(v2, 'Apply to other watches', [...(note ? [note] : []), text], rows);
}

// Starts (or resumes) the editor for one watch. `how` is 'reply' (a new private message) or 'update' (replace the picker).
async function openCustomizer(interaction, w, how = 'reply') {
    sweep();
    const defaultLook = (await getConfig(w.guild_id).catch(() => null))?.defaultLook || null;
    const d = newDraft(w, defaultLook);
    drafts.set(keyOf(interaction.user.id, w.id), d);
    const view = buildMainView(d);
    return how === 'update' ? interaction.update(view) : interaction.reply({ ...view, flags: [MessageFlags.Ephemeral] });
}

const expired = interaction => interaction.reply({ content: '\u231b This editor expired. Run /social customize again.', flags: [MessageFlags.Ephemeral] });

// Draws the current screen. When it is a different kind of message than the one on screen (card vs embed), Discord cannot edit one
// into the other, so the old message is closed with a pointer and the editor continues in a new private message.
async function show(interaction, d, note = null) {
    let view;
    if (d.view === 'main') view = buildMainView(d, note);
    else {
        const v2 = isV2Msg(interaction);
        view = d.view === 'roles' ? buildRolesView(d, v2, note) : buildApplyView(d, v2, await othersOf(d), note);
    }
    if (!interaction.message || isV2View(view) === isV2Msg(interaction)) return interaction.update(view);
    await interaction.deferUpdate();
    await interaction.editReply(isV2Msg(interaction) ? { content: 'Continued in the message below.', components: [] } : { content: 'Continued in the message below.', embeds: [], components: [] });
    return interaction.followUp({ ...view, flags: [MessageFlags.Ephemeral] });
}
const othersOf = async d => (await getWatches(d.watch.guild_id).catch(() => [])).filter(o => o.id !== d.watchId);

function textModal(id, title, label, value, placeholder, max) {
    return new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45)).addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('v').setLabel(label.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(false)
                .setMaxLength(max).setValue((value || '').slice(0, max)).setPlaceholder(placeholder.slice(0, 100))
        )
    );
}

// What a copy puts on one target watch: only what that watch can use (its own post types).
function fieldsFor(d, target, what) {
    const ids = new Set(typesOf(target).map(t => t.id));
    const only = obj => Object.fromEntries(Object.entries(obj).filter(([k, v]) => ids.has(k) && v));
    const f = {};
    if (what.includes('look')) f.embed_settings = cleanSettings(d.es);
    if (what.includes('message')) f.message_templates = { ...(target.message_templates || {}), ...only(d.templates) };
    if (what.includes('header')) f.batch_header_template = d.header;
    if (what.includes('roles')) { f.role_id = d.role_id; f.type_roles = only(d.type_roles); }
    return f;
}

// Returns true when the interaction belonged to the editor. `hasPermission(interaction)` is the command's access check.
async function handleCustomizerInteraction(interaction, { guildId, hasPermission }) {
    const id = interaction.customId || '';
    if (!id.startsWith('sc_')) return false;
    if (!await hasPermission(interaction, guildId)) { await interaction.reply({ content: '\u274c No permission.', flags: [MessageFlags.Ephemeral] }); return true; }
    const [, action, rest] = id.split('_');
    const watchId = parseInt(rest, 10);
    const d = drafts.get(keyOf(interaction.user.id, watchId));
    if (!d) { await expired(interaction); return true; }
    d.touched = Date.now();
    const redraw = note => show(interaction, d, note);
    const toggle = (obj, key, on) => { if (on) obj[key] = on; else delete obj[key]; };

    if (interaction.isStringSelectMenu()) {
        if (action === 'type') { d.type = interaction.values[0]; await redraw(); return true; }
        if (action === 'rtype') { d.roleType = interaction.values[0]; await redraw(); return true; }
        if (action === 'ascope') { d.applyScope = interaction.values[0]; await redraw(); return true; }
        if (action === 'awhat') { d.applyWhat = interaction.values; await redraw(); return true; }
        if (action === 'apick') { d.applyPick = interaction.values.map(Number).filter(Boolean); await redraw(); return true; }
    }
    if (interaction.isRoleSelectMenu() && action === 'rrole') {
        const role = interaction.values[0] || null;
        if (d.roleType === '*') d.role_id = role; else toggle(d.type_roles, d.roleType, role);
        await redraw(); return true;
    }

    if (interaction.isButton()) {
        if (action === 'embed') { if (d.es.embed === false) delete d.es.embed; else d.es.embed = false; await redraw(); return true; }
        if (action === 'style') {
            const sample = buildSamplePost(draftWatch(d), d.type, { withImage: true });
            d.es.style = styleOf(draftWatch(d), sample, lookOf(draftWatch(d))) === 'card' ? 'embed' : 'card';
            await redraw(); return true;
        }
        if (action === 'image') { const next = IMAGE_CYCLE[d.es.image || 'large']; if (next === 'large') delete d.es.image; else d.es.image = next; await redraw(); return true; }
        if (action === 'text') { if (d.es.text === 'message') delete d.es.text; else d.es.text = 'message'; await redraw(); return true; }
        if (action === 'reset') { d.es = {}; await redraw(); return true; }
        if (action === 'rolebtn') { d.view = 'roles'; await redraw(); return true; }
        if (action === 'rback' || action === 'aback') { d.view = 'main'; await redraw(); return true; }
        if (action === 'rclear') { if (d.roleType === '*') d.role_id = null; else delete d.type_roles[d.roleType]; await redraw(); return true; }
        if (action === 'apply') { d.view = 'apply'; await redraw(); return true; }
        if (action === 'color') {
            await interaction.showModal(new ModalBuilder().setCustomId(`sc_colormodal_${watchId}`).setTitle('Accent color').addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('v').setLabel('Hex color, like #ff8800 (blank = default)').setStyle(TextInputStyle.Short)
                        .setRequired(false).setMaxLength(7).setValue(d.es.color || '').setPlaceholder('#ff8800')
                )
            ));
            return true;
        }
        if (action === 'msg') {
            const label = typeLabel(d.watch, d.type);
            await interaction.showModal(textModal(`sc_msgmodal_${watchId}`, `Text for ${label}`, `Message for ${label} (blank = default)`,
                d.templates[d.type], d.type === 'live' ? '{author} {is/was} live on {platform}!\n{url}' : '{author} just posted on {platform}!\n{url}', 1000));
            return true;
        }
        if (action === 'hdr') {
            await interaction.showModal(textModal(`sc_hdrmodal_${watchId}`, 'Batch header', 'Header when 2+ posts land within 10 min', d.header, DEFAULT_BATCH_HEADER, 500));
            return true;
        }
        if (action === 'close') {
            drafts.delete(keyOf(interaction.user.id, watchId));
            const closed = { content: 'Discarded. Anything unsaved was thrown away.', embeds: [], components: [] };
            await interaction.update(closed);
            return true;
        }
        if (action === 'save') {
            const fresh = await getWatch(guildId, watchId);
            if (!fresh) { drafts.delete(keyOf(interaction.user.id, watchId)); await interaction.update({ content: '\u274c That watch was removed.', embeds: [], components: [] }); return true; }
            const ok = await saveWatchCustomization(guildId, watchId, {
                embed_settings: cleanSettings(d.es), role_id: d.role_id, type_roles: cleanRoles(d.type_roles),
                message_templates: Object.fromEntries(Object.entries(d.templates).filter(([, v]) => v)), batch_header_template: d.header,
            });
            if (!ok) { await interaction.update({ content: '\u274c Could not save (the watch may have been removed).', embeds: [], components: [] }); return true; }
            d.watch = { ...fresh, embed_settings: cleanSettings(d.es), role_id: d.role_id, type_roles: cleanRoles(d.type_roles), message_templates: d.templates, batch_header_template: d.header };
            d.baseline = snapshot(d);
            await redraw('\u2705 Saved. New notifications use this look.');
            return true;
        }
        if (action === 'aclear') {
            const cfg = { ...(await getConfig(guildId)) }; delete cfg.defaultLook; saveConfig(guildId, cfg); d.defaultLook = null;
            d.view = 'main'; await redraw('\u2705 Server default look cleared.'); return true;
        }
        if (action === 'aapply') {
            if (d.applyScope === 'default') {
                const look = cleanSettings(d.es);
                const cfg = { ...(await getConfig(guildId)) };
                if (Object.keys(look).length) cfg.defaultLook = look; else delete cfg.defaultLook;
                saveConfig(guildId, cfg); d.defaultLook = Object.keys(look).length ? look : null;
                d.view = 'main'; await redraw('\u2705 Saved as the server default look.'); return true;
            }
            const all = await othersOf(d);
            const targets = d.applyScope === 'all' ? all : d.applyScope === 'platform' ? all.filter(o => o.platform === d.watch.platform) : all.filter(o => d.applyPick.includes(o.id));
            let n = 0;
            for (const t of targets) n += await copyWatchCustomization(guildId, [t.id], fieldsFor(d, t, d.applyWhat)).catch(() => 0);
            d.view = 'main';
            await redraw(n ? `\u2705 Applied to ${n} watch${n === 1 ? '' : 'es'}.` : 'No other watches to apply to.');
            return true;
        }
    }

    if (interaction.isModalSubmit()) {
        const value = (interaction.fields.getTextInputValue('v') || '').trim();
        if (action === 'colormodal') {
            if (value && !HEX_RE.test(value)) { await interaction.reply({ content: '\u274c That is not a hex color. Use 6 digits, like `#ff8800`.', flags: [MessageFlags.Ephemeral] }); return true; }
            if (value) d.es.color = `#${HEX_RE.exec(value)[1].toLowerCase()}`; else delete d.es.color;
        } else if (action === 'msgmodal') {
            if (value) d.templates[d.type] = value; else delete d.templates[d.type];
        } else if (action === 'hdrmodal') {
            d.header = value || null;
        } else return false;
        await redraw();
        return true;
    }
    return false;
}

module.exports = { handleCustomizerInteraction, openCustomizer, buildMainView, buildRolesView, buildApplyView, cleanSettings, drafts, newDraft };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
