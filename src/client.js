// The single shared Discord client instance.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

module.exports = { client };
