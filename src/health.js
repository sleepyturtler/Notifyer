// Health check and periodic background reporting for bot status and owner logs.

const { Client } = require('discord.js');
const { sendAnnouncementToOwners } = require('./announcements.js'); // Assuming existing announcement logic

const HEALTH_CHECK_INTERVAL = 60 * 60 * 1000; // Every 1 hour (adjust as needed)

function startHealthChecks(client) {
    setInterval(async () => {
        try {
            const uptime = process.uptime();
            const memoryUsage = process.memoryUsage();
            const heapUsedMB = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
            
            const healthReport = [
                '## 🩺 Periodic Health Check Report',
                `**Status:** Online & Healthy`,
                `**Uptime:** \`${Math.floor(uptime / 60)} minutes\``,
                `**Memory Usage:** \`${heapUsedMB} MB\` heap used`,
                `**Guilds Count:** \`${client.guilds.cache.size}\``
            ].join('\n');

            // Use the existing announcement/owner logging logic
            if (typeof sendAnnouncementToOwners === 'function') {
                await sendAnnouncementToOwners(client, healthReport);
            }
        } catch (err) {
            console.error('❌ Health check periodic report error:', err);
        }
    }, HEALTH_CHECK_INTERVAL);
}

module.exports = { startHealthChecks };

// build-marker: health-v2
