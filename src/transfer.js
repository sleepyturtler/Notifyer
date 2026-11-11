// /transfer: move your watches over from another notification bot.
//
//   /transfer start channel:#alerts bot:@OtherBot   starts a transfer period: Notifyer reads the last messages OtherBot posted in
//                                                   that channel and every new one from then on. Each message is read for the account
//                                                   it is about, the kind of post, the message text, the embed color and look and the
//                                                   ping role, and a matching watch is created, PAUSED, in the same channel.
//   /transfer status | rescan                       see what was copied / read the channel history again
//   /transfer finish                                ends the period: every copied watch is switched on (after recording what its account
//                                                   already posted, so nothing is announced twice)
//   /transfer cancel                                ends it and deletes the copied watches that are still paused
//
// Reading another bot's messages needs the privileged Message Content intent, so all of this only runs when TRANSFER_ENABLED=true
// (see config.js and client.js). What each message means is worked out in transferParse.js (pure, tested on its own); this file
// does the Discord and database side.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Events, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { client } = require('./client.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES, TRANSFER_ENABLED, TRANSFER_SCAN_PAGES, canUsePlatform } = require('./config.js');
const { normalizeHandle, watchName } = require('./helpers.js');
const {
    addTransferWatch, createTransfer, deletePausedTransferWatches, getActiveTransfers, getSocialLinkByUsername, getTransferWatches, getWatches,
    saveTransferProgress, setTransferStatus, updateTransferWatchFields, updateWatchActive,
} = require('./db.js');
const { fetchJson } = require('./net.js');
const { NATIVE_VIDEO_PLATFORMS } = require('./notify.js');
const { checkLinkAccess } = require('./linkRequests.js');
const { seedWatchBaseline } = require('./watchFlow.js');
const { pollAll } = require('./poller.js');
const { hasCommandPermission } = require('./permissions.js');
const P = require('./transferParse.js');
const { GREEN, ORANGE, RED, view } = require('./v2.js');

const MAX_ACTIVE_PER_GUILD = 5;
const MAX_WATCHES_PER_GUILD = 50; // the same cap /social add enforces
const MAX_SKIPPED_KEPT = 60;
const TWITCH_NAME = /^[A-Za-z0-9_]{4,25}$/;

// ── What is running ─────────────────────────────────────────────────────────
// Transfers in progress, in memory so that reading every message in every channel costs one Map lookup. A transfer is its database
// row plus the working state below, which is rebuilt by reading the channel again (/transfer rescan) after a restart.
const byId = new Map();          // transfer id -> transfer
const byChannel = new Map();     // channel id -> [transfer, ...]
const chains = new Map();        // transfer id -> the promise of the last thing queued for it

function hydrate(row) {
    return { ...row, stats: new Map(), voteOf: new Map(), seen: new Set(), unrec: new Set() };
}
function register(t) {
    byId.set(t.id, t);
    byChannel.set(t.channel_id, [...(byChannel.get(t.channel_id) || []).filter(x => x.id !== t.id), t]);
}
function unregister(t) {
    byId.delete(t.id);
    const rest = (byChannel.get(t.channel_id) || []).filter(x => x.id !== t.id);
    if (rest.length) byChannel.set(t.channel_id, rest); else byChannel.delete(t.channel_id);
}
const activeIn = guildId => [...byId.values()].filter(t => t.guild_id === guildId);

// Everything for one transfer runs one step at a time: two messages about the same account can't race to create the same watch,
// and finishing waits for whatever is still being read.
function enqueue(t, fn) {
    const run = (chains.get(t.id) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    chains.set(t.id, tail);
    tail.then(() => { if (chains.get(t.id) === tail) chains.delete(t.id); });
    return run;
}
const drained = t => chains.get(t.id) || Promise.resolve();

async function init() {
    if (!TRANSFER_ENABLED) return;
    for (const row of await getActiveTransfers()) register(hydrate(row));
    if (byId.size) console.log(`🔁 ${byId.size} transfer(s) in progress`);
}

// ── Reading a message ───────────────────────────────────────────────────────
// A discord.js message as the plain snapshot transferParse.js works on.
function snapshotOf(message) {
    const embeds = [...(message.embeds || [])].map(e => {
        const d = e.data || e;
        return {
            type: d.type || null, color: d.color ?? null, title: d.title || null, description: d.description || null, url: d.url || null,
            author: d.author ? { name: d.author.name || null, url: d.author.url || null } : null,
            image: d.image?.url || null, thumbnail: d.thumbnail?.url || null,
            fields: (d.fields || []).map(f => ({ name: f.name, value: f.value })),
        };
    });
    const buttons = [], texts = [], topTexts = [];
    const v2 = { accent: null, topTexts, texts, hasGallery: false, hasThumb: false };
    // Components can be nested (rows, containers, sections) and, depending on the discord.js version, either plain data or objects
    // with their own toJSON(); read both shapes, and never let an odd component break reading the rest of the message.
    const visit = (c, top) => {
        try {
            const j = (typeof c?.toJSON === 'function' ? c.toJSON() : c) || {};
            const type = j.type ?? c.type;
            if (type === 2 && j.url) buttons.push({ label: j.label || '', url: j.url });
            else if (type === 10) { const t = j.content ?? c.content; if (t) { texts.push(t); if (top) topTexts.push(t); } }
            else if (type === 11) v2.hasThumb = true;
            else if (type === 12) v2.hasGallery = true;
            else if (type === 17) v2.accent = j.accent_color ?? j.accentColor ?? c.accentColor ?? c.accent_color ?? null;
            for (const kid of (j.components || c.components || [])) visit(kid, false);
            const acc = j.accessory || c.accessory;
            if (acc) visit(acc, false);
        } catch { /* skip this component */ }
    };
    for (const c of message.components || []) visit(c, true);
    const isV2 = Boolean(message.flags?.has?.(MessageFlags.IsComponentsV2));
    return {
        content: message.content || '', embeds, buttons, v2: isV2 ? v2 : null,
        suppressed: Boolean(message.flags?.has?.(MessageFlags.SuppressEmbeds)),
    };
}

// A post link that doesn't say whose it is (a YouTube video, a TikTok short link) can be looked up: both sites answer oEmbed for free.
const resolved = new Map(); // post link -> handle; only successes are kept, so a failed lookup is tried again
async function resolveHandle(ident) {
    if (ident.handle) return ident.handle;
    const r = ident.resolve;
    if (!r) return null;
    const key = `${r.platform}:${r.id || r.url}`;
    if (resolved.has(key)) return resolved.get(key);
    let handle = null;
    try {
        if (r.platform === 'youtube' && r.id) {
            const { status, json } = await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${r.id}`)}`);
            if (status === 200 && json?.author_url) handle = P.classifyUrl(json.author_url)?.handle || null;
        } else if (r.platform === 'tiktok') {
            const { status, json } = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(r.url)}`);
            if (status === 200 && json) handle = P.classifyUrl(json.author_url || '')?.handle || json.author_unique_id || null;
        } else if (r.platform === 'twitch' && ident.nameHint && TWITCH_NAME.test(ident.nameHint)) {
            handle = ident.nameHint.toLowerCase(); // a VOD link has no channel in it; the embed's author is the channel's display name
        } else if (r.platform === 'instagram' && ident.nameHint) {
            const m = String(ident.nameHint).match(/@([A-Za-z0-9._]{1,30})/) || String(ident.nameHint).match(/^([A-Za-z0-9._]{1,30})$/);
            handle = m ? m[1] : null; // checked against the linked accounts afterwards, so a wrong guess can't create anything
        }
    } catch (e) {
        console.warn(`transfer: couldn't look up ${key}:`, e.message);
    }
    if (handle) {
        if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
        resolved.set(key, handle);
    }
    return handle;
}

const platformInfo = p => ({ label: PLATFORMS[p].label, defaultColor: PLATFORMS[p].color, native: NATIVE_VIDEO_PLATFORMS.has(p) });

// The notify type a message stands for, if that is one Notifyer has for the platform (else the only one the platform has, else none).
function validType(platform, type) {
    const types = PLATFORM_NOTIFY_TYPES[platform] || [];
    if (type && types.some(t => t.id === type)) return type;
    return types.length === 1 ? types[0].id : null;
}

function noteSkip(t, platform, handle, reason) {
    const key = `${platform}:${String(handle).toLowerCase()}`;
    t.skipped = t.skipped.filter(s => `${s.platform}:${String(s.handle).toLowerCase()}` !== key);
    t.skipped.push({ platform, handle, reason });
    if (t.skipped.length > MAX_SKIPPED_KEPT) t.skipped.shift();
}
const saveProgress = t => saveTransferProgress(t.id, { messagesSeen: t.messages_seen, unrecognized: t.unrecognized, skipped: t.skipped }).catch(e => console.error('transfer progress:', e.message));

// Step 1 for a message: what is it about? Reads it, looks up whose it is if needed and records its message text as a vote (see
// trustedTemplate: a text is only copied when it repeats). Resolves to null when there is nothing to copy from it.
async function analyze(t, message) {
    // Messages are counted once however often they are read again (rescans, and Discord editing in a link preview a moment later).
    if (!t.seen.has(message.id)) { t.seen.add(message.id); t.messages_seen++; if (t.seen.size > 5000) t.seen.clear(); }
    const snap = snapshotOf(message);
    const ident = P.identify(snap);
    if (!ident) {
        if (!t.unrec.has(message.id)) { t.unrec.add(message.id); t.unrecognized++; if (t.unrec.size > 5000) t.unrec.clear(); }
        return null;
    }
    if (t.unrec.delete(message.id)) t.unrecognized = Math.max(0, t.unrecognized - 1); // its link preview arrived and made it readable
    const raw = await resolveHandle(ident);
    const handle = raw ? normalizeHandle(ident.platform, raw) : '';
    if (!handle) {
        noteSkip(t, ident.platform, ident.nameHint || 'unknown account', `a ${PLATFORMS[ident.platform].label} post link doesn't say whose it is`);
        return null;
    }
    const type = validType(ident.platform, ident.postType);
    const desc = P.describe(snap, { ...ident, handle }, platformInfo(ident.platform));
    const key = `${ident.platform}:${type || '*'}`;
    const prev = t.voteOf.get(message.id);
    if (!prev || prev.key !== key || prev.tpl !== desc.template) { // an edit (Discord adds the link preview a moment later) replaces this message's vote
        if (prev) P.unvoteTemplate(t.stats, prev.key, prev.tpl);
        P.voteTemplate(t.stats, key, desc.template);
        t.voteOf.set(message.id, { key, tpl: desc.template });
        if (t.voteOf.size > 5000) { t.voteOf.clear(); t.stats.clear(); }
    }
    return { platform: ident.platform, handle, type, key, desc };
}

// Step 2: make or complete the paused watch. Resolves to 'created', 'merged', 'exists' or 'skipped'.
async function apply(t, a) {
    const { platform, handle, type, key, desc } = a;
    const p = PLATFORMS[platform];
    if (p.unavailable) { noteSkip(t, platform, handle, `${p.label} isn't set up on this bot`); return 'skipped'; }
    if (!canUsePlatform(platform, t.started_by)) { noteSkip(t, platform, handle, `only the bot owner can add ${p.label} accounts`); return 'skipped'; }

    const watches = await getWatches(t.guild_id);
    const existing = watches.find(w => w.platform === platform && w.handle.toLowerCase() === handle.toLowerCase() && w.channel_id === t.channel_id);
    const guild = client.guilds.cache.get(t.guild_id);
    const template = P.trustedTemplate(t.stats, key, desc.template);
    const roleId = desc.roleIds.find(id => guild?.roles.cache.has(id)) || null;

    if (existing) {
        // Only a watch this transfer made (and that is still paused) is refined; a watch that was already there is never touched.
        if (existing.transfer_id !== t.id) { noteSkip(t, platform, handle, 'already tracked in this channel'); return 'exists'; }
        if (existing.active) return 'exists'; // one of this transfer's watches that an admin already switched on by hand
        const patch = {};
        const templates = { ...(existing.message_templates || {}) };
        if (template && type && !templates[type]) { templates[type] = template; patch.message_templates = templates; }
        if (Object.keys(desc.look).length && !Object.keys(existing.embed_settings || {}).length) patch.embed_settings = desc.look; // the whole look at once, never a mix of two messages'
        if (roleId && !existing.role_id) patch.role_id = roleId;
        if (!Object.keys(patch).length) return 'exists';
        await updateTransferWatchFields(existing.id, patch);
        return 'merged';
    }

    let socialLinkId = null;
    if (p.oauth) {
        // Instagram/TikTok can only be watched for accounts that linked themselves (/social link), same rule as /social add.
        const link = await getSocialLinkByUsername(platform, handle);
        if (!link) { noteSkip(t, platform, handle, `hasn't linked their ${p.label} account yet (they need to run /social link)`); return 'skipped'; }
        if (link.needs_relink_at) { noteSkip(t, platform, handle, 'their linked account needs to be re-linked (/social link)'); return 'skipped'; }
        if (!(await checkLinkAccess(link, t.guild_id, t.started_by)).allowed) { noteSkip(t, platform, handle, 'the person who linked it has to approve this server: add it once with /social add'); return 'skipped'; }
        socialLinkId = link.id;
    }
    if (watches.length >= MAX_WATCHES_PER_GUILD) { noteSkip(t, platform, handle, `this server is at the ${MAX_WATCHES_PER_GUILD}-watch limit`); return 'skipped'; }

    const w = await addTransferWatch({
        guildId: t.guild_id, platform, handle, channelId: t.channel_id, addedBy: t.started_by, transferId: t.id,
        messageTemplates: template && type ? { [type]: template } : null, roleId, embedSettings: desc.look, socialLinkId,
    });
    if (!w) return 'exists'; // another message got there first
    t.skipped = t.skipped.filter(s => !(s.platform === platform && String(s.handle).toLowerCase() === handle.toLowerCase()));
    return 'created';
}

// A message that arrived (or was edited) while the transfer is running.
async function ingestLive(t, message) {
    const a = await analyze(t, message);
    if (a) await apply(t, a);
    await saveProgress(t);
}

// Reads the channel's recent history. Newest first, so the newest message's look is the one a watch starts with; every message is read
// before any watch is made, so a message text that repeats across accounts is recognized as the bot's wording and not as one post's words.
async function scan(t, channel) {
    const found = [];
    let before = null, scanned = 0;
    for (let page = 0; page < TRANSFER_SCAN_PAGES; page++) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        scanned += batch.size;
        for (const m of batch.values()) {
            if (fromSource(m, t.source_bot_id)) found.push(m);
            if (before === null || BigInt(m.id) < BigInt(before)) before = m.id;
        }
        if (batch.size < 100) break;
    }
    found.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    const analyses = [];
    for (const m of found) { const a = await analyze(t, m); if (a) analyses.push(a); }
    for (const a of analyses) await apply(t, a);
    await saveProgress(t);
    return { scanned, fromBot: found.length };
}

const fromSource = (message, botId) => message.author?.id === botId || message.applicationId === botId;

function onMessage(message) {
    if (!byId.size || !message.guildId || message.partial) return;
    const list = byChannel.get(message.channelId);
    if (!list) return;
    const t = list.find(x => x.guild_id === message.guildId && fromSource(message, x.source_bot_id));
    if (!t) return;
    enqueue(t, () => ingestLive(t, message)).catch(e => console.error(`transfer ${t.id} (message ${message.id}):`, e.message));
}

if (TRANSFER_ENABLED) {
    client.on(Events.MessageCreate, onMessage);
    client.on(Events.MessageUpdate, (_old, message) => onMessage(message));
}

// ── Screens ─────────────────────────────────────────────────────────────────
// A Components V2 message can hold about 4000 characters of text in total, so every list is cut to a budget.
function fit(lines, budget, more = n => `…and ${n} more`) {
    const out = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
        if (used + lines[i].length + 1 > budget) { out.push(more(lines.length - i)); break; }
        out.push(lines[i]); used += lines[i].length + 1;
    }
    return out.join('\n');
}
const platformName = p => `${PLATFORMS[p]?.emojiTag || ''} ${PLATFORMS[p]?.label || p}`.trim();

function watchLine(w) {
    const bits = [];
    if (w.message_templates && Object.keys(w.message_templates).length) bits.push('message');
    if (w.embed_settings?.color) bits.push(`\`${w.embed_settings.color}\``);
    if (w.embed_settings?.style) bits.push(w.embed_settings.style);
    if (w.role_id) bits.push(`<@&${w.role_id}>`);
    return `${platformName(w.platform)} **${watchName(w)}**${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

async function reportView(t, { head, note = null, color = RED, rows = [] } = {}) {
    const watches = await getTransferWatches(t.guild_id, t.id);
    const paused = watches.filter(w => !w.active).length;
    const blocks = [`## ${head || `Transfer #${t.id}`}`];
    blocks.push(`Copying <@${t.source_bot_id}>'s notifications in <#${t.channel_id}>.\nRead **${t.messages_seen}** message${t.messages_seen === 1 ? '' : 's'} so far, **${watches.length}** watch${watches.length === 1 ? '' : 'es'} made${paused ? ` (${paused} paused)` : ''}.`);
    if (note) blocks.push(note);
    if (watches.length) blocks.push(`**Copied**\n${fit(watches.map(watchLine), 1500)}`);
    else blocks.push('**Copied**\nNothing yet. Watches appear as soon as the bot posts a notification I can read (a link to YouTube, Twitch, Kick, TikTok, Instagram, Bluesky or X).');
    if (t.skipped.length) blocks.push(`**Couldn't copy**\n${fit(t.skipped.map(s => `• ${platformName(s.platform)} **${s.handle}**: ${s.reason}`), 1000)}`);
    if (t.unrecognized) blocks.push(`-# ${t.unrecognized} message${t.unrecognized === 1 ? ' had' : 's had'} no link I could use (RSS posts, for example, can't be copied: add those with /social add).`);
    return view(color, blocks, rows);
}

const ephemeral = payload => ({ ...payload, flags: [MessageFlags.Ephemeral] });

// ── Commands ────────────────────────────────────────────────────────────────
function notEnabledView() {
    return ephemeral(view(ORANGE, [
        '## Transfer isn\'t enabled on this bot',
        'To copy another bot\'s watches, Notifyer has to read that bot\'s messages. That needs the **Message Content Intent**.\n\nThe bot owner can enable it by turning on **Message Content Intent** for the bot in the Discord Developer Portal (Bot tab), setting `TRANSFER_ENABLED=true` and restarting the bot.',
    ]));
}

function pickTransfer(interaction, guildId) {
    const wanted = interaction.options.getInteger('transfer');
    const list = activeIn(guildId);
    if (wanted !== null && wanted !== undefined) {
        const t = list.find(x => x.id === wanted);
        return t ? { t } : { error: '❌ There is no transfer in progress with that ID. Pick one from the list that appears as you type, or use `/transfer status`.' };
    }
    if (list.length === 1) return { t: list[0] };
    if (!list.length) return { error: '❌ No transfer is in progress. Start one with `/transfer start`.' };
    return { error: `❌ More than one transfer is in progress. Use the \`transfer\` option to pick one:\n${list.map(x => `• **#${x.id}** <@${x.source_bot_id}> in <#${x.channel_id}>`).join('\n')}` };
}

async function handleCommand(interaction, { guildId, reply }) {
    if (!TRANSFER_ENABLED) return reply(notEnabledView());
    const sub = interaction.options.getSubcommand();
    const admin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (['start', 'finish', 'cancel'].includes(sub) && !admin) return reply('❌ Only administrators can start, finish or cancel a transfer.');
    if (!admin && !(await hasCommandPermission(interaction, guildId))) return reply('❌ No permission. An administrator must configure access with `/social access`.');

    if (sub === 'start') return start(interaction, guildId, reply);

    if (sub === 'status') {
        const list = activeIn(guildId);
        const wanted = interaction.options.getInteger('transfer');
        if (!list.length) return reply('No transfer is in progress. Start one with `/transfer start`.');
        if (wanted === null && list.length > 1) {
            return reply(ephemeral(view(RED, ['## Transfers in progress', fit(list.map(x => `• **#${x.id}** <@${x.source_bot_id}> in <#${x.channel_id}>: ${x.messages_seen} messages read`), 3000), 'Use the `transfer` option of `/transfer status` to see one in detail.'])));
        }
        const { t, error } = pickTransfer(interaction, guildId);
        if (error) return reply(error);
        return reply(ephemeral(await reportView(t, { note: 'When you\'re ready, run `/transfer finish`. Until then the copied watches stay paused, so nothing is announced twice.' })));
    }

    const { t, error } = pickTransfer(interaction, guildId);
    if (error) return reply(error);

    if (sub === 'rescan') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const channel = interaction.guild.channels.cache.get(t.channel_id) || await interaction.guild.channels.fetch(t.channel_id).catch(() => null);
        if (!channel) return interaction.editReply('❌ I can no longer see that channel.');
        let info;
        try { info = await enqueue(t, () => scan(t, channel)); } catch (e) { return interaction.editReply(`❌ Couldn't read the channel: ${e.message}`); }
        return interaction.editReply(await reportView(t, { head: `Transfer #${t.id} — read again`, note: `Looked through the last ${info.scanned} messages and found ${info.fromBot} from <@${t.source_bot_id}>.` }));
    }

    if (sub === 'finish') {
        const watches = (await getTransferWatches(guildId, t.id)).filter(w => !w.active);
        if (!watches.length) return reply('❌ Nothing has been copied yet, so there is nothing to switch on. Wait for the bot to post a notification, or use `/transfer rescan`. To stop the transfer without switching anything on, use `/transfer cancel`.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`transfer_finish_${t.id}`).setLabel(`Switch on ${watches.length} watch${watches.length === 1 ? '' : 'es'}`).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`transfer_wait_${t.id}`).setLabel('Not yet').setStyle(ButtonStyle.Secondary),
        );
        return reply(ephemeral(view(RED, [
            `## Finish transfer #${t.id}?`,
            `This switches on **${watches.length}** watch${watches.length === 1 ? '' : 'es'} in <#${t.channel_id}> and stops reading <@${t.source_bot_id}>'s messages.\n\nFirst I note down what each account has already posted, so nothing the old bot announced is announced again.\n\n⚠️ **Turn off or remove <@${t.source_bot_id}> around now**, or both bots will post every new notification.`,
        ], [row])));
    }

    if (sub === 'cancel') {
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`transfer_cancel_${t.id}`).setLabel('Cancel transfer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`transfer_wait_${t.id}`).setLabel('Keep it going').setStyle(ButtonStyle.Secondary),
        );
        return reply(ephemeral(view(RED, [`## Cancel transfer #${t.id}?`, `This stops reading <@${t.source_bot_id}>'s messages and **deletes the paused watches** it created. Watches that are already on, and anything you added yourself, are kept.`], [row])));
    }
}

async function start(interaction, guildId, reply) {
    const botUser = interaction.options.getUser('bot', true);
    const picked = interaction.options.getChannel('channel', true);
    if (!botUser.bot) return reply(`❌ <@${botUser.id}> isn't a bot. Pick the bot account that posts your current notifications.`);
    if (botUser.id === client.user.id) return reply('❌ That\'s this bot. Pick the other notification bot you want to copy.');
    const channel = interaction.guild.channels.cache.get(picked.id) || await interaction.guild.channels.fetch(picked.id).catch(() => null);
    if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return reply('❌ Pick a text or announcement channel.');

    const list = activeIn(guildId);
    if (list.some(x => x.channel_id === channel.id && x.source_bot_id === botUser.id)) return reply(`❌ A transfer from <@${botUser.id}> in ${channel} is already in progress. See it with \`/transfer status\`.`);
    if (list.length >= MAX_ACTIVE_PER_GUILD) return reply(`❌ ${MAX_ACTIVE_PER_GUILD} transfers are already in progress in this server. Finish or cancel one first.`);

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const perms = me ? channel.permissionsFor(me) : null;
    const missing = [];
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    if (!perms?.has(PermissionFlagsBits.ReadMessageHistory)) missing.push('Read Message History');
    if (missing.length) return reply(`❌ I need **${missing.join('** and **')}** in ${channel} to read the other bot's notifications. Give me that permission there and run this again.`);

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const t = hydrate(await createTransfer({ guildId, channelId: channel.id, sourceBotId: botUser.id, startedBy: interaction.user.id }));
    register(t);
    let note;
    try {
        const info = await enqueue(t, () => scan(t, channel));
        note = `Looked through the last ${info.scanned} messages and found ${info.fromBot} from <@${botUser.id}>. I'm still listening: every new notification it posts is copied too.\n\nThe new watches are **paused**. When you're ready, run \`/transfer finish\`.`;
    } catch (e) {
        console.error(`transfer ${t.id} history scan:`, e);
        note = `⚠️ I couldn't read the channel's history (${e.message}), but I'm listening for new notifications from <@${botUser.id}>.`;
    }
    return interaction.editReply(await reportView(t, { head: `Transfer #${t.id} started`, note, color: GREEN }));
}

// Buttons of /transfer finish and /transfer cancel. Resolves to true when the interaction was one of ours.
async function handleComponent(interaction, { guildId }) {
    if (!interaction.isButton() || !interaction.customId.startsWith('transfer_')) return false;
    const [, action, idStr] = interaction.customId.split('_');
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({ content: '❌ Only administrators can finish or cancel a transfer.', flags: [MessageFlags.Ephemeral] });
        return true;
    }
    const t = byId.get(parseInt(idStr, 10));
    if (!t || t.guild_id !== guildId) {
        await interaction.update(view(RED, ['## That transfer isn\'t in progress any more', 'It was already finished or cancelled.']));
        return true;
    }
    if (action === 'wait') {
        await interaction.update(view(RED, [`## Transfer #${t.id} is still running`, 'Still reading new notifications. Run `/transfer finish` when you\'re ready.']));
        return true;
    }
    if (action !== 'finish' && action !== 'cancel') return false;

    await interaction.deferUpdate();
    // Stop reading first and let whatever is in the middle of being read finish, so nothing is created behind our back.
    unregister(t);
    await drained(t);
    try {
        await conclude(interaction, t, guildId, action);
    } catch (e) {
        console.error(`transfer ${t.id} ${action}:`, e);
        register(t); // it didn't finish, so it is still running; trying again is safe (watches already switched on are skipped)
        await interaction.editReply(view(RED, [`## Couldn't ${action} transfer #${t.id}`, `Something went wrong (${e.message}). The transfer is still running; run the command again to retry.`])).catch(() => {});
    }
    return true;
}

async function conclude(interaction, t, guildId, action) {
    if (action === 'cancel') {
        const removed = await deletePausedTransferWatches(guildId, t.id);
        await setTransferStatus(t.id, 'cancelled');
        await interaction.editReply(view(RED, [`## Transfer #${t.id} cancelled`, `Stopped reading <@${t.source_bot_id}>. Deleted **${removed}** paused watch${removed === 1 ? '' : 'es'}.`]));
        return;
    }

    // Finish: each watch gets its baseline first and only then goes live. A watch left from an interrupted finish is simply picked up again.
    const paused = (await getTransferWatches(guildId, t.id)).filter(w => !w.active);
    const unseeded = [];
    for (const w of paused) {
        if (!await seedWatchBaseline(w)) unseeded.push(w);
        await updateWatchActive(guildId, w.id, true);
        await new Promise(r => setTimeout(r, 250)); // the account lookups are real requests; don't fire them all at once
    }
    await setTransferStatus(t.id, 'finished');
    if (unseeded.length) pollAll(null, guildId).catch(e => console.error('transfer finish poll:', e.message)); // gives those their baseline right away

    const blocks = [
        `## Transfer #${t.id} finished`,
        `Switched on **${paused.length}** watch${paused.length === 1 ? '' : 'es'} in <#${t.channel_id}>. They announce new posts from now on.`,
        '**Next**\n• Turn off or remove the old bot if you haven\'t yet.\n• `/social status` shows any account that has a problem.\n• `/social customize` fine-tunes how a watch looks. Copied message texts are worth a quick check.',
    ];
    if (unseeded.length) blocks.push(`⚠️ I couldn't read the current posts of ${unseeded.length} account${unseeded.length === 1 ? '' : 's'} (${fit(unseeded.map(w => `**${watchName(w)}**`), 400, n => `+${n} more`).split('\n').join(', ')}). Their first successful check only records what is already there, so the first post it finds may not be announced.`);
    if (t.skipped.length) blocks.push(`**Couldn't copy**\n${fit(t.skipped.map(s => `• ${platformName(s.platform)} **${s.handle}**: ${s.reason}`), 900)}`);
    await interaction.editReply(view(GREEN, blocks));
}

async function handleAutocomplete(interaction, guildId) {
    const admin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!TRANSFER_ENABLED || (!admin && !await hasCommandPermission(interaction, guildId))) return interaction.respond([]);
    const typed = String(interaction.options.getFocused() || '').toLowerCase();
    const choices = activeIn(guildId).map(t => {
        const channel = interaction.guild.channels.cache.get(t.channel_id);
        const bot = client.users.cache.get(t.source_bot_id);
        return { name: `#${t.id} — ${bot?.username || t.source_bot_id} in #${channel?.name || t.channel_id}`.slice(0, 100), value: t.id };
    }).filter(c => c.name.toLowerCase().includes(typed));
    return interaction.respond(choices.slice(0, 25));
}

module.exports = { handleAutocomplete, handleCommand, handleComponent, init };
