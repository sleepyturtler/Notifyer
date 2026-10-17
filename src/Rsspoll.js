// Adaptive poll interval for RSS watches. Pure functions: the poller supplies the data and does the I/O.
//
//   interval = clamp( max( typical gap between items / 6,  time since newest item / 6 ),  MIN, MAX )
//
// - A feed that posts every 30 minutes is checked about every 5. One that posts daily hits the max.
// - A feed that has gone quiet slows down as the silence grows (6+ hours of silence = the max) and snaps back to its
//   normal pace as soon as it posts again, because the gap term only looks at recent history.
// - With fewer than 3 dated items there is no gap to measure, so the default is used (silence can still slow it).

const { RSS_POLL_DEFAULT_MS, RSS_POLL_MIN_MS, RSS_POLL_MAX_MS } = require('./config.js');

const SLACK_MS = 10 * 1000; // the slow loop ticks every ~2 min with jitter; don't wait a whole extra tick for 119.9s

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// timestamps: ms numbers or date strings; invalid ones are ignored, future ones count as "now".
function computeRssInterval(timestamps, now = Date.now()) {
    const ts = [...new Set((timestamps || [])
        .map(t => (typeof t === 'number' ? t : Date.parse(t)))
        .filter(Number.isFinite)
        .map(t => Math.min(t, now)))]
        .sort((a, b) => b - a)
        .slice(0, 10);
    if (!ts.length) return RSS_POLL_DEFAULT_MS;

    let base = RSS_POLL_DEFAULT_MS;
    if (ts.length >= 3) {
        const gaps = ts.slice(1).map((t, i) => ts[i] - t).sort((a, b) => a - b);
        base = gaps[Math.floor(gaps.length / 2)] / 6;
    }
    return Math.round(clamp(Math.max(base, (now - ts[0]) / 6), RSS_POLL_MIN_MS, RSS_POLL_MAX_MS));
}

// After a failed check: double the current interval (starting from the default) up to the max; a success resets it.
function nextRssBackoff(prevMs) {
    return Math.round(clamp(Math.max(Number(prevMs) || 0, RSS_POLL_DEFAULT_MS) * 2, RSS_POLL_MIN_MS, RSS_POLL_MAX_MS));
}

// last_checked is bumped on every outcome (success or error), so last_checked + interval is when the next check is due.
function rssPollDue(w, now = Date.now()) {
    if (!w.last_checked) return true;
    return now - Number(w.last_checked) >= (Number(w.poll_interval_ms) || RSS_POLL_DEFAULT_MS) - SLACK_MS;
}

module.exports = { computeRssInterval, nextRssBackoff, rssPollDue };
