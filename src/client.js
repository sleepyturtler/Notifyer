// The single shared Discord client instance.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { Client, GatewayIntentBits } = require('discord.js');

// Default: nothing in a message can ping anyone. Titles, usernames and captions come from third
// parties (a video titled "@everyone" would otherwise ping the whole server), so the only pings
// that are ever allowed are the watch's own role, passed explicitly on each send.
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });

module.exports = { client };
