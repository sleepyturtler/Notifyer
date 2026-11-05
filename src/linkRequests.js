// Using someone else's linked Instagram/TikTok account in a server: allowed freely for the person who linked it, the
// bot owner, and any server that already uses it or was the one it was linked from. Anyone else's /social add sends
// the person who linked it a DM with Approve / Deny; an approval is remembered for that server (and disappears when
// the account is unlinked). The buttons carry everything they need in their custom id, so nothing is stored while a
// request is pending, and each one expires after 24 hours.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { client } = require('./client.js');
const { PLATFORMS, isOwner } = require('./config.js');
const { approveLinkForGuild, getSocialLinkById, hasLinkApproval, isLinkUsedInGuild } = require('./db.js');
const { notifyGuildAdmins } = require('./announcements.js');

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const SNOWFLAKE = /^\d{5,25}$/;
const recentRequests = new Map(); // `${linkId}:${guildId}` -> when the last request was DMed (limits DM spam; resets on restart)

const { plainText: clean } = require('./helpers.js');

async function checkLinkAccess(link, guildId, userId) {
    if (userId && link.linked_by && String(link.linked_by) === String(userId)) return { allowed: true, reason: 'linker' };
    if (userId && isOwner(userId)) return { allowed: true, reason: 'owner' };
    if (link.guild_id && String(link.guild_id) === String(guildId)) return { allowed: true, reason: 'origin-server' };
    if (await isLinkUsedInGuild(link.id, guildId)) return { allowed: true, reason: 'already-used' };
    if (await hasLinkApproval(link.id, guildId)) return { allowed: true, reason: 'approved' };
    return { allowed: false, reason: 'needs-approval' };
}

// Sends the approval request (at most one per link and server per 24 hours). Resolves to { message } for the requester.
async function requestLinkApproval(link, guildId, requesterId, requesterTag) {
    const label = PLATFORMS[link.platform]?.label || link.platform;
    const owner = `<@${link.linked_by}>`;
    const key = `${link.id}:${guildId}`;
    const last = recentRequests.get(key);
    if (last && Date.now() - last < REQUEST_TTL_MS) {
        return { message: `⏳ A request to use **${clean(link.external_username)}** in this server is already waiting for ${owner} to approve it (sent <t:${Math.floor(last / 1000)}:R>). Once they approve, run this command again.` };
    }
    if (!requesterId) return { message: `❌ **${clean(link.external_username)}** was linked by ${owner}. Ask them to add it in this server.` };

    const guild = client.guilds.cache.get(guildId);
    const ts = Date.now().toString(36);
    const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Request to use your linked account')
        .setDescription(`**${clean(requesterTag) || 'Someone'}** (<@${requesterId}>) wants to track your ${label} account **${clean(link.external_username)}** in the server **${clean(guild?.name) || guildId}**.\n\nIf you approve, admins of that server can add watches for it. You can take this back any time by unlinking the account with \`/social links\`.\n\nThis request expires in 24 hours.`);
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`linkreq_a_${link.id}_${guildId}_${requesterId}_${ts}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`linkreq_d_${link.id}_${guildId}_${requesterId}_${ts}`).setLabel('Deny').setStyle(ButtonStyle.Danger),
    );
    try {
        const user = await client.users.fetch(link.linked_by);
        await user.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
    } catch {
        return { message: `❌ **${clean(link.external_username)}** was linked by ${owner}, so they have to approve using it here, but I couldn't message them (their DMs are closed). Ask them to run \`/social add\` for this account in this server themselves.` };
    }
    recentRequests.set(key, Date.now());
    for (const [k, t] of recentRequests) if (Date.now() - t > REQUEST_TTL_MS) recentRequests.delete(k);
    return { message: `⏳ **${clean(link.external_username)}** was linked by ${owner}, so they need to approve using it in this server. I've sent them a request. Once they approve, run this command again (the request expires in 24 hours).` };
}

async function handleLinkRequestButton(interaction) {
    const parts = interaction.customId.split('_'); // linkreq_<a|d>_<linkId>_<guildId>_<requesterId>_<sent, base36>
    const [, act, linkIdStr, guildId, requesterId, tsStr] = parts;
    const gone = content => interaction.update({ content, embeds: [], components: [] });
    // parseInt would happily accept "12abc", so every part is checked strictly first.
    if (parts.length !== 6 || !['a', 'd'].includes(act) || !/^\d{1,9}$/.test(linkIdStr) || !SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(requesterId) || !/^[0-9a-z]{1,10}$/.test(tsStr)) {
        return gone('❌ That request is not valid.');
    }
    const linkId = parseInt(linkIdStr, 10);
    const sentAt = parseInt(tsStr, 36);
    const link = await getSocialLinkById(linkId);
    if (!link) return gone('That linked account no longer exists, so there is nothing to approve.');
    if (String(interaction.user.id) !== String(link.linked_by)) {
        return interaction.reply({ content: '❌ Only the person who linked this account can answer this request.', flags: [MessageFlags.Ephemeral] });
    }
    if (Date.now() - sentAt > REQUEST_TTL_MS) return gone('⌛ This request has expired. The requester can ask again.');

    const label = PLATFORMS[link.platform]?.label || link.platform;
    const account = `${label} account **${clean(link.external_username)}**`;
    const approved = act === 'a';
    if (approved) await approveLinkForGuild(link.id, guildId, interaction.user.id);
    recentRequests.delete(`${link.id}:${guildId}`);
    await gone(approved
        ? `✅ Approved. Admins of that server can now add watches for your ${account}. You can undo this by unlinking it with \`/social links\`.`
        : `❌ Denied. Nothing was shared.`);

    // Tell the requester: by DM, falling back to the server's admin channel if their DMs are closed.
    const guild = client.guilds.cache.get(guildId);
    const notice = new EmbedBuilder().setColor(approved ? '#57F287' : '#ED4245')
        .setTitle(approved ? '✅ Linked account approved' : '❌ Linked account request denied')
        .setDescription(approved
            ? `The ${account} can now be added${guild ? ` in **${clean(guild.name)}**` : ''}. Run \`/social add\` again.`
            : `The person who linked the ${account} declined to share it${guild ? ` with **${clean(guild.name)}**` : ''}.`);
    const user = await client.users.fetch(requesterId).catch(() => null);
    const dmd = user ? await user.send({ embeds: [notice], allowedMentions: { parse: [] } }).then(() => true).catch(() => false) : false;
    if (!dmd && guild) await notifyGuildAdmins(guild, notice).catch(() => {});
}

module.exports = { checkLinkAccess, requestLinkApproval, handleLinkRequestButton, resetRecentRequests: () => recentRequests.clear() };
