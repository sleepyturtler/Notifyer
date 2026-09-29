// hasCommandPermission: admin or configured access role.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { PermissionFlagsBits } = require('discord.js');
const { getConfig } = require('./db.js');

async function hasCommandPermission(interaction, guildId) {
    if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const cfg = await getConfig(guildId);
    return cfg.accessRoleId ? interaction.member.roles.cache.has(cfg.accessRoleId) : false;
}

module.exports = { hasCommandPermission };
