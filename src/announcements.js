// One-off / recurring admin announcements (support server, Twitter restored) and delivery-failure reports.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { PermissionFlagsBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORMS, SUPPORT_SERVER_URL } = require('./config.js');
const { getAllWatches, getConfig, getWatches, saveConfig } = require('./db.js');
const { client } = require('./client.js');

// Finds a channel to post admin/mod updates in. Prefers a channel hidden from
// @everyone where every role that can view it has an elevated permission
// (Administrator/Manage*/Kick/Ban), with dev/admin/staff/mod/owner in the name
// preferred within that set. Falls back to any @everyone-hidden channel, then
// any matching-named channel, then the first postable channel.
const ANNOUNCEMENT_NAME_HINT = /dev|admin|staff|mod|owner/i;

const ELEVATED_PERMS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
];

function findAnnouncementChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;
    const textChannels = guild.channels.cache.filter(c =>
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) &&
        c.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel)
    );
    if (!textChannels.size) return null;

    const everyoneRole = guild.roles.everyone;
    const everyoneCanView = c => c.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.ViewChannel);
    // Non-@everyone roles that can view this channel
    const viewerRoles = c => guild.roles.cache.filter(r => r.id !== everyoneRole.id && c.permissionsFor(r)?.has(PermissionFlagsBits.ViewChannel));
    const isElevatedRole = r => ELEVATED_PERMS.some(p => r.permissions.has(p));

    const restricted = textChannels.filter(c => !everyoneCanView(c));
    if (restricted.size) {
        const highPriv = restricted.filter(c => {
            const roles = viewerRoles(c);
            return roles.size > 0 && roles.every(isElevatedRole);
        });
        const pool = highPriv.size ? highPriv : restricted;
        const named = pool.find(c => ANNOUNCEMENT_NAME_HINT.test(c.name));
        return named || pool.first();
    }
    // No restricted channel found — fall back to first available postable channel
    const named = textChannels.find(c => ANNOUNCEMENT_NAME_HINT.test(c.name) || /general/i.test(c.name));
    return named || textChannels.first();
}

// Returns true only if the message was actually sent, so callers can avoid marking it as done otherwise.
async function announceSupportServer(guild) {
    try {
        const channel = findAnnouncementChannel(guild);
        if (!channel) return false;
        const embed = new EmbedBuilder().setColor('#5865F2').setTitle('👋 Thanks for using Notifyer!')
            .setDescription(`Run **/setup** to get a quick walkthrough of what this bot does and set up your first tracked account.\n\nJoin the support server for help, updates, and to report issues:\n${SUPPORT_SERVER_URL}`);
        await channel.send({ embeds: [embed] });
        console.log(`📨 Sent support server announcement to ${guild.name} (#${channel.name})`);
        return true;
    } catch (e) {
        console.error(`announceSupportServer (${guild.id}):`, e.message);
        return false;
    }
}

// One-time follow-up that a mirror is back — separate flag so it sends even to
// guilds already warned about the outage.
async function announceTwitterRestoredForGuild(guildId) {
    try {
        const cfg = await getConfig(guildId);
        if (cfg.twitterRestoredAnnounced) return;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;
        const channel = findAnnouncementChannel(guild);
        if (!channel) return;
        const embed = new EmbedBuilder().setColor('#00ff00').setTitle('✅ Twitter/X tracking is back')
            .setDescription(
                'This server has one or more Twitter/X watches. The Nitter mirrors this bot reads through have held up reliably, so Twitter/X tracking is fully re-enabled — no action needed, existing watches resume automatically.'
            );
        await channel.send({ embeds: [embed] }); // a failed send throws to the catch below, so the flag below is not set and it retries next boot
        saveConfig(guildId, { ...cfg, twitterRestoredAnnounced: true });
        console.log(`✅ Sent Twitter restored update to ${guild.name} (#${channel.name})`);
    } catch (e) {
        console.error(`announceTwitterRestoredForGuild (${guildId}):`, e.message);
    }
}

async function announceTwitterRestoredGuilds() {
    const watches = await getAllWatches(['twitter']);
    const guildIdsWithTwitter = [...new Set(watches.map(w => w.guild_id))];
    for (const guildId of guildIdsWithTwitter) await announceTwitterRestoredForGuild(guildId);
}

// ── Delivery-failure reports ────────────────────────────────────────────────
// When a notification can't be sent because of the channel (missing permissions, no access,
// deleted), tell the server's admins where they will see it instead of only logging it.
// Goes to the same private channel as the other admin announcements; if there is none (or it
// is the very channel that's broken) the server owner gets a DM instead.

const DELIVERY_REPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // at most one report per failing channel per day
const REPORTABLE_CODES = new Set([50013, 50001, 10003]); // Missing Permissions, Missing Access, Unknown Channel
const REQUIRED_CHANNEL_PERMS = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Send Messages', PermissionFlagsBits.SendMessages],
    ['Embed Links', PermissionFlagsBits.EmbedLinks],
    ['Read Message History', PermissionFlagsBits.ReadMessageHistory],
];
const lastDeliveryReport = new Map(); // `${guildId}:${channelId}` -> timestamp (claimed before the first await)

function describeDeliveryProblem(guild, channel, cause) {
    const code = cause?.code;
    if (code === 10003) {
        return { noLink: true, problem: 'Discord says this channel no longer exists.', fix: 'Pick a new channel for the watch with **Manage** (button below) and then **Change Channel**, or use `/social list`.' };
    }
    if (!channel) {
        return { noLink: false, problem: "The bot can't find this channel. It was deleted, or the bot can no longer see it.", fix: 'Give the bot access to the channel again, or pick a different one with **Manage** (button below) and then **Change Channel**.' };
    }
    const perms = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
    const missing = perms ? REQUIRED_CHANNEL_PERMS.filter(([, flag]) => !perms.has(flag)).map(([name]) => name) : [];
    if (missing.length) {
        return { noLink: false, problem: `The bot is missing **${missing.join(', ')}** in ${channel}.`,
            fix: "Open the channel's permissions (Edit Channel, then Permissions) and allow those for the bot or its role, or pick a different channel with **Manage** (button below)." };
    }
    return { noLink: false, problem: `Discord refused the message (${code === 50001 ? 'Missing Access' : 'Missing Permissions'}) even though the basic permissions look fine.`,
        fix: `Check ${channel} for a permission override on the bot or its role. Delivery resumes by itself once that's fixed.` };
}

// Resolves to a short description of where the report went, or null if it couldn't be delivered.
async function sendDeliveryReport(guild, adminChannel, embed, rows, dmRows) {
    if (adminChannel) {
        try {
            await adminChannel.send({ embeds: [embed], components: rows, allowedMentions: { parse: [] } });
            return `#${adminChannel.name}`;
        } catch (e) { console.error(`delivery report to #${adminChannel.name} (${guild.id}):`, e.message); }
    }
    try {
        const owner = await guild.fetchOwner();
        await owner.send({ embeds: [embed], components: dmRows });
        return 'the server owner by DM';
    } catch (e) {
        console.error(`delivery report DM to owner (${guild.id}):`, e.message);
        return null;
    }
}

// Never throws and is safe to call without await.
async function reportDeliveryFailure(w, cause) {
    try {
        if (cause !== 'missing_channel' && !REPORTABLE_CODES.has(cause?.code)) return; // transient (network/rate limit/5xx): not actionable
        const guild = client.guilds.cache.get(w.guild_id);
        if (!guild) return;

        const key = `${guild.id}:${w.channel_id}`, now = Date.now();
        for (const [k, ts] of lastDeliveryReport) if (now - ts > DELIVERY_REPORT_COOLDOWN_MS) lastDeliveryReport.delete(k);
        if (lastDeliveryReport.has(key)) return;
        lastDeliveryReport.set(key, now); // claim synchronously: several watches failing at once produce one report
        const cfg = await getConfig(guild.id);
        const prev = cfg.deliveryWarned?.[w.channel_id];
        if (prev && now - prev < DELIVERY_REPORT_COOLDOWN_MS) { lastDeliveryReport.set(key, prev); return; } // already reported before a restart

        const failing = guild.channels.cache.get(w.channel_id);
        const { problem, fix, noLink } = describeDeliveryProblem(guild, failing, cause);
        const affected = (await getWatches(guild.id).catch(() => [])).filter(x => x.channel_id === w.channel_id && x.active !== false);
        if (!affected.some(x => x.id === w.id)) affected.unshift(w);
        const label = x => `\`${String(x.handle).replace(/`/g, '')}\` (${PLATFORMS[x.platform]?.label || x.platform})`;
        const listed = affected.slice(0, 5).map(label).join(', ') + (affected.length > 5 ? ` and ${affected.length - 5} more` : '');

        const embed = new EmbedBuilder().setColor('#ED4245')
            .setTitle("⚠️ Couldn't send a notification")
            .setDescription(`Notifications for ${affected.length === 1 ? 'a watch' : `**${affected.length} watches**`} that post to ${failing ? failing.toString() : `<#${w.channel_id}>`} can't be delivered.`)
            .addFields(
                { name: 'Affected', value: listed.slice(0, 1000) },
                { name: "What's wrong", value: problem.slice(0, 1000) },
                { name: 'How to fix it', value: fix.slice(0, 1000) },
            )
            .setFooter({ text: `Server: ${guild.name} | You'll only get this once a day per channel` });

        const link = new ButtonBuilder().setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${guild.id}/${w.channel_id}`)
            .setLabel((failing ? `Open #${failing.name}` : 'Open channel').slice(0, 80));
        const manage = new ButtonBuilder().setStyle(ButtonStyle.Secondary).setCustomId(`deliveryfail_manage_${w.id}`)
            .setLabel(`Manage ${String(w.handle)}`.slice(0, 80));
        const rows = [new ActionRowBuilder().addComponents(...(noLink ? [] : [link]), manage)];
        // The manage button needs a server context, so a DM only carries the channel link (when it can exist).
        const dmRows = noLink ? [] : [new ActionRowBuilder().addComponents(link)];

        const adminChannel = findAnnouncementChannel(guild);
        const sentTo = await sendDeliveryReport(guild, adminChannel && adminChannel.id !== w.channel_id ? adminChannel : null, embed, rows, dmRows);
        if (!sentTo) { lastDeliveryReport.delete(key); return; } // nothing went out: let the next failure try again
        console.log(`📨 Delivery-failure report for ${guild.name}/${failing ? '#' + failing.name : w.channel_id} sent to ${sentTo}`);
        const fresh = await getConfig(guild.id);
        const warned = Object.fromEntries(Object.entries({ ...fresh.deliveryWarned, [w.channel_id]: now }).filter(([, ts]) => now - ts < 7 * 24 * 60 * 60 * 1000));
        saveConfig(guild.id, { ...fresh, deliveryWarned: warned });
    } catch (e) {
        console.error(`reportDeliveryFailure (watch ${w?.id}):`, e.message);
    }
}

module.exports = { announceSupportServer, announceTwitterRestoredGuilds, reportDeliveryFailure };
