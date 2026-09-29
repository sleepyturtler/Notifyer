// Short-lived in-memory state (OAuth link states, /setup wizard picks) with expiry sweeps.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const crypto = require('crypto');

// In-memory pending OAuth states: state -> { guildId, userId, platform, expires }
// A Discord-side "link" always starts and finishes within a few minutes, so
// memory (rather than the DB) is fine here — if the process restarts mid-flow
// the user just runs /social link again.
const pendingOAuthStates = new Map();

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// /setup wizard: a select menu -> modal -> channel-select can't pass data through
// customId alone (handles may contain characters unsafe for it), so carry state
// between those steps keyed by guild+user, same short-lived pattern as OAuth state.
const pendingSetupPicks = new Map();

const SETUP_PICK_TTL_MS = 10 * 60 * 1000;

function createOAuthState(guildId, userId, platform) {
    const state = crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + OAUTH_STATE_TTL_MS;
    pendingOAuthStates.set(state, { guildId, userId, platform, expires });
    return { state, expires };
}

function consumeOAuthState(state) {
    const entry = pendingOAuthStates.get(state);
    if (!entry) return null;
    pendingOAuthStates.delete(state);
    if (entry.expires < Date.now()) return null;
    return entry;
}

setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingOAuthStates) if (v.expires < now) pendingOAuthStates.delete(k);
}, 5 * 60 * 1000);

// pendingSetupPicks has the same "entries only get cleaned up when read back"
// shape, but /setup flows that get abandoned partway (user closes Discord,
// never finishes the modal/channel-select) never get read back at all — without
// this, those entries would sit in memory forever on a long-running process.
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingSetupPicks) if (v.expires < now) pendingSetupPicks.delete(k);
}, 5 * 60 * 1000);

module.exports = { SETUP_PICK_TTL_MS, consumeOAuthState, createOAuthState, pendingSetupPicks };
