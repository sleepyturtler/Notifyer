// The single shared Discord client instance.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { Client, GatewayIntentBits, Options } = require('discord.js');
const { TRANSFER_ENABLED } = require('./config.js');

// Only /transfer reads messages, so the message intents (Message Content is privileged: it must also be switched on in the
// Developer Portal) are requested only when TRANSFER_ENABLED=true; every other build stays on the Guilds intent alone.
const intents = [GatewayIntentBits.Guilds];
if (TRANSFER_ENABLED) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);

// Default: nothing in a message can ping anyone. Titles, usernames and captions come from third
// parties (a video titled "@everyone" would otherwise ping the whole server), so the only pings
// that are ever allowed are the watch's own role, passed explicitly on each send.
const client = new Client({
    intents,
    allowedMentions: { parse: [] },
    // With message intents every message in every server lands in the cache; keep only a few per channel (enough for a link preview
    // that Discord adds a moment after the message to still find the message it belongs to).
    ...(TRANSFER_ENABLED ? { makeCache: Options.cacheWithLimits({ MessageManager: 30 }) } : {}),
});

module.exports = { client };
