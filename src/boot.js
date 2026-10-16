// Startup sequence: DB init, config summary, Discord login, global error handlers.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

require('./events.js'); // registers handlers / starts the server on load
require('./interactions.js'); // registers handlers / starts the server on load
require('./web/server.js'); // registers handlers / starts the server on load
const { ensureIPv4Pool, initDB } = require('./db.js');
const { logStartupConfigSummary } = require('./config.js');
const { client } = require('./client.js');

(async () => {
    await ensureIPv4Pool();
    try {
        await initDB();
    } catch (e) {
        console.error('⚠️ initDB failed, starting bot anyway:', e.message);
    }
    logStartupConfigSummary();
    if (!process.env.DISCORD_TOKEN || !process.env.DISCORD_TOKEN.trim()) {
        console.error('❌ DISCORD_TOKEN is missing or empty. Set it in this service\'s environment variables and redeploy.');
        process.exit(1);
    }
    try {
        await client.login(process.env.DISCORD_TOKEN.trim());
    } catch (e) {
        console.error('❌ Discord login failed:', e.message, '\nDouble-check DISCORD_TOKEN on this service — copy it fresh from the Developer Portal with no extra whitespace/quotes.');
        process.exit(1);
    }
})();

process.on('unhandledRejection', e => console.error('⚠️ Unhandled rejection:', e));

client.on('error', e => {
    // 40060 (already acknowledged) / 10062 (unknown interaction) are late or duplicate replies, not crashes.
    // Seeing them often usually means a second copy of the bot is running with the same token.
    if (e && (e.code === 40060 || e.code === 10062)) return console.warn(`⚠️ Ignored a late/duplicate interaction response (Discord ${e.code}). If this repeats a lot, make sure only ONE copy of the bot is running with this token.`);
    console.error('⚠️ Discord client error:', e);
});
