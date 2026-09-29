// Single-post fetch dispatcher (only Twitter goes through it; other platforms use their bulk fetchers).
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { fetchLatestTwitter } = require('./twitter.js');

async function fetchLatestPost(platform, handle) {
    switch (platform) {
        case 'youtube': return null;   // handled separately in pollAll (fetchLatestYouTubeEntries)
        case 'twitter': return fetchLatestTwitter(handle);
        case 'twitch': return null;    // handled separately in pollAll (fetchLatestTwitchAll)
        case 'kick': return null;      // handled separately in pollAll (fetchLatestKickAll)
        case 'instagram': return null; // handled separately in pollAll (fetchLatestInstagramAll)
        case 'tiktok': return null;    // handled separately in pollAll (fetchLatestTikTokAll)
        default: return null;
    }
}

module.exports = { fetchLatestPost };
