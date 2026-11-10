// In-memory health numbers for /social status: how each platform's polling is going and how each Nitter mirror is behaving.
// Nothing here is stored: a restart starts the picture again, which is fine for "is it working right now".

const platforms = new Map(); // platform -> { at, checked, failed, lastError, lastErrorAt }
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
function reset() { platforms.clear(); mirrors.clear(); }

module.exports = { mirrorStats, noteCheck, noteMirror, platformStats, reset };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
