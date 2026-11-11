// In-memory health numbers for /social status: how each platform's polling is going and how each Nitter mirror is behaving.
// Nothing here is stored: a restart starts the picture again, which is fine for "is it working right now".

const platforms = new Map(); // platform -> { at, checked, failed, lastError, lastErrorAt }
const lastReport = new Map(); // platform -> { checked, failed } at the previous hourly report, so each report shows only its own hour
const mirrors = new Map();   // base URL -> { ok, fail, streak, lastOk, lastFail, lastError }

// One watch finished its check (ok), or failed with a reason.
function noteCheck(platform, ok, error = null) {
    const p = platforms.get(platform) || { at: 0, checked: 0, failed: 0, lastError: null, lastErrorAt: 0 };
    p.at = Date.now(); p.checked++;
    if (!ok) { p.failed++; p.lastError = String(error || 'failed').slice(0, 200); p.lastErrorAt = Date.now(); }
    platforms.set(platform, p);
}

// One Nitter mirror answered a request (ok), or did not.
function noteMirror(base, ok, error = null) {
    const m = mirrors.get(base) || { ok: 0, fail: 0, streak: 0, lastOk: 0, lastFail: 0, lastError: null };
    if (ok) { m.ok++; m.streak = 0; m.lastOk = Date.now(); }
    else { m.fail++; m.streak++; m.lastFail = Date.now(); m.lastError = String(error || 'failed').slice(0, 120); }
    mirrors.set(base, m);
}

const platformStats = () => new Map([...platforms].map(([k, v]) => [k, { ...v }]));
const mirrorStats = () => new Map([...mirrors].map(([k, v]) => [k, { ...v }]));
function reset() { platforms.clear(); mirrors.clear(); lastReport.clear(); }

// ── Hourly report in the logs ───────────────────────────────────────────────
// Once an hour (HEALTH_REPORT_INTERVAL_MS to change it) one block goes to the console: uptime, memory, servers, watches, and how each
// platform's polling went during that hour. It only reads what noteCheck/noteMirror collected, so it costs nothing between reports.
const REPORT_INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.HEALTH_REPORT_INTERVAL_MS, 10) || 60 * 60 * 1000);
let started = false;

const fmtDuration = s => {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return `${d ? `${d}d ` : ''}${h || d ? `${h}h ` : ''}${m}m`;
};

async function buildReport(client) {
    const mb = n => (n / 1024 / 1024).toFixed(0);
    const mem = process.memoryUsage();
    const lines = [
        `🩺 Hourly health report (${new Date().toISOString()})`,
        `   uptime ${fmtDuration(process.uptime())} · memory ${mb(mem.rss)} MB rss / ${mb(mem.heapUsed)} MB heap · ${client.guilds.cache.size} servers · gateway ping ${Math.round(client.ws.ping)} ms`,
    ];
    try {
        const { getAllWatches } = require('./db.js');
        const watches = await getAllWatches(null);
        const paused = watches.filter(w => !w.active).length;
        lines.push(`   watches: ${watches.length}${paused ? ` (${paused} paused)` : ''}`);
    } catch (e) {
        lines.push(`   watches: unavailable (${e.message})`);
    }

    const rows = [];
    for (const [platform, now] of platformStats()) {
        const prev = lastReport.get(platform) || { checked: 0, failed: 0 };
        const checked = now.checked - prev.checked, failed = now.failed - prev.failed;
        lastReport.set(platform, { checked: now.checked, failed: now.failed });
        if (!checked) continue;
        rows.push(`   ${platform}: ${checked} checks, ${failed} failed${failed && now.lastError ? ` (last: ${now.lastError})` : ''}`);
    }
    lines.push(rows.length ? `   polling this hour:\n${rows.join('\n')}` : '   polling this hour: no checks recorded');

    const bad = [...mirrorStats()].filter(([, m]) => m.streak > 0);
    if (bad.length) lines.push(`   Nitter mirrors failing: ${bad.map(([b, m]) => `${b} (${m.streak} in a row)`).join(', ')}`);
    return lines.join('\n');
}

function startHealthChecks(client) {
    if (started) return;
    started = true;
    const timer = setInterval(async () => {
        try { console.log(await buildReport(client)); } catch (err) { console.error('❌ Health report error:', err.message); }
    }, REPORT_INTERVAL_MS);
    timer.unref?.(); // never keeps the process alive on its own
}

module.exports = { buildReport, mirrorStats, noteCheck, noteMirror, platformStats, reset, startHealthChecks };

// build-marker: health-v2
