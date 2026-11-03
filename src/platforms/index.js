// Platforms that return a list of recent posts per account, by platform key. The poller and the add flow both go
// through this map instead of repeating which fetcher belongs to which platform.
const { fetchLatestTwitchAll } = require('./twitch.js');
const { fetchLatestKickAll } = require('./kick.js');
const { fetchLatestBlueskyAll } = require('./bluesky.js');
const { fetchLatestRssAll } = require('./rss.js');

const BULK_FETCHERS = { twitch: fetchLatestTwitchAll, kick: fetchLatestKickAll, bluesky: fetchLatestBlueskyAll, rss: fetchLatestRssAll };

module.exports = { BULK_FETCHERS };
