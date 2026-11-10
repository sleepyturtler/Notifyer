// /social status: how this server's watches and the bot are doing, in one screen.
// Everyone who can use /social sees this server's problems and each platform's state. The bot owner also sees the bot-wide part:
// the YouTube quota, every Nitter mirror, how many servers and watches, and the database.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { client } = require('./client.js');
const { NITTER_INSTANCES, PLATFORMS } = require('./config.js');
const { getAllWatches, getWatches, pingDb } = require('./db.js');
const { watchName } = require('./helpers.js');
const { mirrorStats, platformStats } = require('./health.js');
const { formatDuration } = require('./notify.js');
const { youtubeQuotaBlockedUntil } = require('./platforms/youtube.js');
const { GREEN, ORANGE, RED, clip, view } = require('./v2.js');

const STALE_MS = 60 * 24 * 60 * 60 * 1000; // no post in 60 days
const MAX_PROBLEMS = 8;
const ago = at => (at ? `<t:${Math.floor(at / 1000)}:R>` : 'not yet');

// What is wrong with one watch, as short phrases (empty when nothing is).
function problemsOf(w) {
    const out = [];
    if (!w.active) out.push('paused');
    if (PLATFORMS[w.platform]?.unavailable) out.push(`${PLATFORMS[w.platform].label} is unavailable on this bot right now`);
    if (w.last_error) out.push(`last check failed: \`${String(w.last_error).replace(/`/g, "'").slice(0, 110)}\``);
    else if (w.last_post_at && Date.now() - w.last_post_at > STALE_MS) out.push('no new posts in over 60 days');
    return out;
}

async function thisServer(guildId) {
    const watches = await getWatches(guildId);
    const active = watches.filter(w => w.active).length;
    const lines = [];
    for (const w of watches) {
        const p = problemsOf(w);
        if (p.length) lines.push(`${PLATFORMS[w.platform].emojiTag} **${watchName(w)}** (<#${w.channel_id}>): ${p.join('; ')}`);
    }
    const shown = lines.slice(0, MAX_PROBLEMS);
    if (lines.length > shown.length) shown.push(`-# and ${lines.length - shown.length} more`);
    const head = `**This server**\n${watches.length} watch${watches.length === 1 ? '' : 'es'}: ${active} active, ${watches.length - active} paused`;
    return { watches, problems: lines.length, text: `${head}\n\n${shown.length ? `**Needs attention**\n${shown.join('\n')}` : 'No problems found.'}` };
}

function platformsText(watches) {
    const stats = platformStats();
    const lines = [];
    for (const [key, p] of Object.entries(PLATFORMS)) {
        if (p.restricted) continue;
        const here = watches.filter(w => w.platform === key).length;
        if (!here && !p.unavailable) continue;
        const s = stats.get(key);
        const state = p.unavailable ? '\u26a0\ufe0f unavailable' : 'available';
        const checks = s ? `last check ${ago(s.at)}, ${s.checked - s.failed} of ${s.checked} checks fine since the bot started` : 'not checked since the bot started';
        lines.push(`${p.emojiTag} **${p.label}** (${here} here): ${state}, ${checks}`);
    }
    return lines.length ? `**Platforms**\n${lines.join('\n')}` : null;
}

async function botWide() {
    const lines = ['**Bot-wide** (owner only)'];
    const until = youtubeQuotaBlockedUntil();
    lines.push(until > Date.now() ? `**YouTube quota:** used up, checks resume ${ago(until)}` : '**YouTube quota:** fine');
    const ms = await pingDb().then(n => `${n} ms`, e => `not answering (${String(e.message).slice(0, 60)})`);
    lines.push(`**Database:** ${ms}`);
    const all = await getAllWatches(null).catch(() => []);
    lines.push(`**Servers:** ${client.guilds?.cache?.size ?? '?'}, **watches:** ${all.length} (${all.filter(w => w.active).length} active)`);
    const mirrors = mirrorStats();
    const rows = NITTER_INSTANCES.map(base => {
        const m = mirrors.get(base);
        const host = base.replace(/^https?:\/\//, '');
        if (!m) return `\u2022 ${host}: not used yet`;
        const good = m.streak === 0 && m.ok > 0;
        return `\u2022 ${good ? '\u2705' : '\u274c'} ${host}: ${m.ok} ok, ${m.fail} failed${m.streak ? `, ${m.streak} in a row (${m.lastError})` : ''}, last ok ${ago(m.lastOk)}`;
    });
    if (rows.length) lines.push(`**Nitter mirrors**\n${rows.join('\n')}`);
    return lines.join('\n');
}

async function buildStatusView(guildId, { isOwnerHere = false } = {}) {
    const server = await thisServer(guildId);
    const ping = client.ws?.ping;
    const head = `## Status\nOnline${Number.isFinite(ping) && ping >= 0 ? `, ${Math.round(ping)} ms to Discord` : ''}, up ${formatDuration(process.uptime() * 1000)}`;
    const blocks = [head, server.text, platformsText(server.watches)];
    if (isOwnerHere) blocks.push(await botWide());
    blocks.push(`-# Updated <t:${Math.floor(Date.now() / 1000)}:t>`);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`socialstatus_refresh_${guildId}`).setLabel('\u21bb Refresh').setStyle(ButtonStyle.Secondary));
    return view(server.problems ? ORANGE : GREEN, blocks.filter(Boolean).map(b => clip(b, 3500)), [row]);
}

module.exports = { buildStatusView, problemsOf };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
