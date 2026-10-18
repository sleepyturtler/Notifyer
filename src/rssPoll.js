// Adaptive poll intervals (RSS and Twitter). Pure functions: the poller supplies the data and does the I/O.
//
//   interval = clamp( max( typical gap between posts / 6,  time since newest post / 6 ),  MIN, MAX )
//
// - An account that posts every 30 minutes is checked about every 5. One that posts daily hits the max.
// - One that has gone quiet slows down as the silence grows (6+ hours of silence = the max for RSS) and snaps back to
//   its normal pace as soon as it posts again, because the gap term only looks at recent history.
// - With fewer than 3 dated posts there is no gap to measure, so the default is used (silence can still slow it).
// Bounds per platform live in config.js (ADAPTIVE_POLL) and can be overridden with env vars.

const { ADAPTIVE_POLL, FAST_POLL_INTERVAL_MS, SLOW_POLL_INTERVAL_MS, YOUTUBE_PUSH_POLL_INTERVAL_MS } = require('./config.js');

const SLACK_MS = 10 * 1000; // the slow loop ticks every ~2 min with jitter; don't wait a whole extra tick for 119.9s

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const hasAdaptivePolling = platform => Boolean(ADAPTIVE_POLL[platform]);

// timestamps: ms numbers or date strings; invalid ones are ignored, future ones count as "now".
function computeInterval(platform, timestamps, now = Date.now()) {
    const { min, max, def } = ADAPTIVE_POLL[platform];
    const ts = [...new Set((timestamps || [])
        .map(t => (typeof t === 'number' ? t : Date.parse(t)))
        .filter(Number.isFinite)
        .map(t => Math.min(t, now)))]
        .sort((a, b) => b - a)
        .slice(0, 10);
    if (!ts.length) return def;

    let base = def;
    if (ts.length >= 3) {
        const gaps = ts.slice(1).map((t, i) => ts[i] - t).sort((a, b) => a - b);
        base = gaps[Math.floor(gaps.length / 2)] / 6;
    }
    return Math.round(clamp(Math.max(base, (now - ts[0]) / 6), min, max));
}

// After a failed check: double the current interval (starting from the default) up to the max; a success resets it.
function nextBackoff(platform, prevMs) {
    const { min, max, def } = ADAPTIVE_POLL[platform];
    return Math.round(clamp(Math.max(Number(prevMs) || 0, def) * 2, min, max));
}

// last_checked is bumped on every outcome (success or error), so last_checked + interval is when the next check is due.
function pollDue(platform, w, now = Date.now()) {
    if (!w.last_checked) return true;
    return now - Number(w.last_checked) >= (Number(w.poll_interval_ms) || ADAPTIVE_POLL[platform].def) - SLACK_MS;
}

// Short human form: 20 seconds, 5 min, 1.5 hours.
function formatInterval(ms) {
    if (ms < 100 * 1000) return `${Math.round(ms / 1000)} seconds`;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins} min`;
    const h = Math.round(ms / 360000) / 10;
    return `${h} hour${h === 1 ? '' : 's'}`;
}

// What /social list shows for a watch. pushCovered: Set of YouTube channel ids with a confirmed push subscription
// (or null when unknown, in which case YouTube is described as polled).
function describePollFrequency(w, pushCovered = null) {
    switch (w.platform) {
        case 'twitch': case 'kick': case 'tiktok': case 'instagram':
            return `about every ${formatInterval(FAST_POLL_INTERVAL_MS)}`;
        case 'youtube':
            return pushCovered && w.youtube_channel_id && pushCovered.has(w.youtube_channel_id)
                ? `instant (push), backup check every ${formatInterval(YOUTUBE_PUSH_POLL_INTERVAL_MS)}`
                : `every ${formatInterval(SLOW_POLL_INTERVAL_MS)}`;
        case 'rss': case 'twitter':
            return `about every ${formatInterval(Number(w.poll_interval_ms) || ADAPTIVE_POLL[w.platform].def)} (adapts to how often it posts)`;
        default:
            return `every ${formatInterval(SLOW_POLL_INTERVAL_MS)}`;
    }
}

// RSS-named aliases kept so existing callers and tests keep working.
const computeRssInterval = (timestamps, now) => computeInterval('rss', timestamps, now);
const nextRssBackoff = prevMs => nextBackoff('rss', prevMs);
const rssPollDue = (w, now) => pollDue('rss', w, now);

module.exports = { computeInterval, nextBackoff, pollDue, hasAdaptivePolling, formatInterval, describePollFrequency, computeRssInterval, nextRssBackoff, rssPollDue };
