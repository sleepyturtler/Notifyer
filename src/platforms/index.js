// Single-post fetch dispatcher (only Twitter goes through it; other platforms use their bulk fetchers).
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { fetchLatestTwitter } = require('./twitter.js');

// Every other platform is fetched through its own bulk fetcher (see pollAll / createWatchFlow).
async function fetchLatestPost(platform, handle) {
    return platform === 'twitter' ? fetchLatestTwitter(handle) : null;
}

module.exports = { fetchLatestPost };
