// /social customize: the embed customizer. It opens a live preview of one watch's notification, and everything that shapes
// it can be changed there: which post type is shown, the post text, the batch header, the ping role, and the embed's look
// (on/off, image size, where the post text goes, accent color). Changes live in a draft and only apply on Save.
//
// The editor is a normal message (not Components V2): it has to hold a real embed to preview.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { canWatchBatch, watchName } = require('./helpers.js');
const { getWatch, saveWatchCustomization } = require('./db.js');
const { buildNotificationPayload, buildSamplePost } = require('./notify.js');
const { DEFAULT_BATCH_HEADER } = require('./batch.js');

const DRAFT_TTL_MS = 30 * 60 * 1000;
const drafts = new Map(); // `${userId}:${watchId}` -> draft
const HEX_RE = /^#?([0-9a-f]{6})$/i;
const IMAGE_CYCLE = { large: 'small', small: 'none', none: 'large' };
const IMAGE_LABEL = { large: 'Image: Large', small: 'Image: Small', none: 'Image: Off' };

const keyOf = (userId, watchId) => `${userId}:${watchId}`;
function sweep() { const now = Date.now(); for (const [k, d] of drafts) if (now - d.touched > DRAFT_TTL_MS) drafts.delete(k); }

// Only non-default values are stored, so a watch nobody customized keeps a NULL column and today's exact look.
function cleanSettings(es) {
    const out = {};
    if (es.embed === false) out.embed = false;
    if (es.image === 'small' || es.image === 'none') out.image = es.image;
    if (es.text === 'message') out.text = 'message';
    if (typeof es.color === 'string' && /^#[0-9a-f]{6}$/i.test(es.color)) out.color = es.color.toLowerCase();
    return out;
}

function newDraft(w) {
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [{ id: null, label: 'Post' }];
    const d = {
        watchId: w.id, watch: w, type: types[0].id,
        es: cleanSettings(w.embed_settings || {}), role_id: w.role_id || null,
        templates: { ...(w.message_templates || {}) }, header: w.batch_header_template || null,
        touched: Date.now(),
    };
    d.baseline = snapshot(d);
    return d;
}
const snapshot = d => JSON.stringify([cleanSettings(d.es), d.role_id, d.templates, d.header]);
const isDirty = d => snapshot(d) !== d.baseline;
const draftWatch = d => ({ ...d.watch, embed_settings: cleanSettings(d.es), role_id: d.role_id, message_templates: d.templates, batch_header_template: d.header });
const nativeVideo = w => w.platform === 'youtube' || w.platform === 'tiktok';

// What Discord shows for a YouTube/TikTok link, drawn from the fake sample post.
function fakeUnfurl(w, post) {
    const p = PLATFORMS[w.platform];
    const e = new EmbedBuilder().setColor(p.color).setAuthor({ name: String(post.author || watchName(w)).slice(0, 256) })
        .setTitle(String(post.title).slice(0, 256)).setURL(post.url).setFooter({ text: p.label });
    if (post.thumbnail) e.setImage(post.thumbnail);
    return e;
}

function buildView(d, note = null) {
    const w = draftWatch(d);
    const types = PLATFORM_NOTIFY_TYPES[w.platform] || [];
    const sample = buildSamplePost(w, d.type, { withImage: true }); // a made-up title and thumbnail
    const payload = buildNotificationPayload(w, sample);
    const es = cleanSettings(d.es);
    const off = nativeVideo(w);        // YouTube and TikTok: Discord draws the embed itself from the link, so only on/off applies
    let { content, embeds } = payload;
    if (off) {
        // The real message is just the link. The preview draws what Discord shows for it from the fake title and thumbnail, and keeps the
        // link itself from unfurling so there is only one embed. With the embed off, the real message is sent with its unfurl suppressed.
        if (payload.embedUrl) content = content.split(payload.embedUrl).join(`<${payload.embedUrl}>`);
        embeds = payload.suppressEmbeds ? [] : [fakeUnfurl(w, sample)];
    }
    const embedOff = es.embed === false;
    const rows = [];
    if (types.length > 1) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`sc_type_${d.watchId}`).setPlaceholder('Choose the post type you want to preview')
                .addOptions(types.map(t => ({ label: t.label, value: t.id, default: t.id === d.type })))
        ));
    }
    const role = new RoleSelectMenuBuilder().setCustomId(`sc_role_${d.watchId}`).setPlaceholder('Ping Role').setMinValues(0).setMaxValues(1);
    if (d.role_id) role.setDefaultRoles(d.role_id);
    rows.push(new ActionRowBuilder().addComponents(role));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_msg_${d.watchId}`).setLabel('Edit message').setStyle(ButtonStyle.Primary),
        ...(canWatchBatch(w) ? [new ButtonBuilder().setCustomId(`sc_hdr_${d.watchId}`).setLabel('Batch Header').setStyle(ButtonStyle.Secondary)] : []),
        new ButtonBuilder().setCustomId(`sc_color_${d.watchId}`).setLabel('Embed color').setStyle(ButtonStyle.Secondary).setDisabled(off || embedOff),
        new ButtonBuilder().setCustomId(`sc_image_${d.watchId}`).setLabel('Image').setStyle(ButtonStyle.Secondary).setDisabled(off || embedOff),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_text_${d.watchId}`).setLabel(es.text === 'message' ? 'Text - In message' : 'Text - In embed').setStyle(ButtonStyle.Primary).setDisabled(off),
        new ButtonBuilder().setCustomId(`sc_embed_${d.watchId}`).setLabel('Embed').setStyle(embedOff ? ButtonStyle.Danger : ButtonStyle.Success),
    ));
    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sc_reset_${d.watchId}`).setLabel('RESET').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sc_close_${d.watchId}`).setLabel('Discard').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`sc_save_${d.watchId}`).setLabel('Save').setStyle(ButtonStyle.Success).setDisabled(!isDirty(d)),
    ));
    return { content: [note, content].filter(Boolean).join('\n').slice(0, 2000), embeds, components: rows, allowedMentions: { parse: [] } };
}

// Starts (or resumes) the editor for one watch. `how` is 'reply' (a new private message) or 'update' (replace the picker).
async function openCustomizer(interaction, w, how = 'reply') {
    sweep();
    const k = keyOf(interaction.user.id, w.id);
    const d = newDraft(w);
    drafts.set(k, d);
    const view = buildView(d);
    return how === 'update' ? interaction.update(view) : interaction.reply({ ...view, flags: [MessageFlags.Ephemeral] });
}

const expired = interaction => interaction.reply({ content: '⌛ This editor expired. Run `/social customize` again.', flags: [MessageFlags.Ephemeral] });

function textModal(id, title, label, value, placeholder, max) {
    return new ModalBuilder().setCustomId(id).setTitle(title.slice(0, 45)).addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('v').setLabel(label.slice(0, 45)).setStyle(TextInputStyle.Paragraph).setRequired(false)
                .setMaxLength(max).setValue((value || '').slice(0, max)).setPlaceholder(placeholder.slice(0, 100))
        )
    );
}

// Returns true when the interaction belonged to the editor. `hasPermission(interaction)` is the command's access check.
async function handleCustomizerInteraction(interaction, { guildId, hasPermission }) {
    const id = interaction.customId || '';
    if (!id.startsWith('sc_')) return false;
    if (!await hasPermission(interaction, guildId)) { await interaction.reply({ content: '❌ No permission.', flags: [MessageFlags.Ephemeral] }); return true; }
    const [, action, rest] = id.split('_');
    const watchId = parseInt(rest, 10);
    const d = drafts.get(keyOf(interaction.user.id, watchId));
    if (!d) { await expired(interaction); return true; }
    d.touched = Date.now();
    const redraw = note => interaction.update(buildView(d, note));

    if (interaction.isStringSelectMenu() && action === 'type') { d.type = interaction.values[0]; await redraw(); return true; }
    if (interaction.isRoleSelectMenu() && action === 'role') { d.role_id = interaction.values[0] || null; await redraw(); return true; }

    if (interaction.isButton()) {
        if (action === 'embed') { if (d.es.embed === false) delete d.es.embed; else d.es.embed = false; await redraw(); return true; }
        if (action === 'image') { const next = IMAGE_CYCLE[d.es.image || 'large']; if (next === 'large') delete d.es.image; else d.es.image = next; await redraw(); return true; }
        if (action === 'text') { if (d.es.text === 'message') delete d.es.text; else d.es.text = 'message'; await redraw(); return true; }
        if (action === 'reset') { d.es = {}; await redraw(); return true; }
        if (action === 'color') {
            await interaction.showModal(new ModalBuilder().setCustomId(`sc_colormodal_${watchId}`).setTitle('Accent color').addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('v').setLabel('Hex color, like #ff8800 (blank = platform color)').setStyle(TextInputStyle.Short)
                        .setRequired(false).setMaxLength(7).setValue(d.es.color || '').setPlaceholder('#ff8800')
                )
            ));
            return true;
        }
        if (action === 'msg') {
            const types = PLATFORM_NOTIFY_TYPES[d.watch.platform] || [];
            const label = types.find(t => t.id === d.type)?.label || 'Post';
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
            await interaction.update({ content: 'Discarded. Anything unsaved was thrown away.', embeds: [], components: [] });
            return true;
        }
        if (action === 'save') {
            const fresh = await getWatch(guildId, watchId);
            if (!fresh) { drafts.delete(keyOf(interaction.user.id, watchId)); await interaction.update({ content: '❌ That watch was removed.', embeds: [], components: [] }); return true; }
            const ok = await saveWatchCustomization(guildId, watchId, {
                embed_settings: cleanSettings(d.es), role_id: d.role_id, message_templates: Object.fromEntries(Object.entries(d.templates).filter(([, v]) => v)), batch_header_template: d.header,
            });
            if (!ok) { await interaction.update({ content: '❌ Could not save (the watch may have been removed).', embeds: [], components: [] }); return true; }
            d.watch = { ...fresh, embed_settings: cleanSettings(d.es), role_id: d.role_id, message_templates: d.templates, batch_header_template: d.header };
            d.baseline = snapshot(d);
            await redraw('✅ Saved. New notifications use this look.');
            return true;
        }
    }

    if (interaction.isModalSubmit()) {
        const value = (interaction.fields.getTextInputValue('v') || '').trim();
        if (action === 'colormodal') {
            if (value && !HEX_RE.test(value)) { await interaction.reply({ content: '❌ That is not a hex color. Use 6 digits, like `#ff8800`.', flags: [MessageFlags.Ephemeral] }); return true; }
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

module.exports = { handleCustomizerInteraction, openCustomizer, buildView, cleanSettings, drafts, newDraft };
