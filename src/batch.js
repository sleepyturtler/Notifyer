// Rolling 10-minute batching: retroactively turns single notifications into Components V2 batches.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { TextDisplayBuilder, ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, SectionBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORMS } = require('./config.js');
const { buttonLabelFor, resolveWatchChannel, sendNotification } = require('./notify.js');
const { getConfig } = require('./db.js');

// Per-guild batching preferences, stored on the same JSONB config blob as
// everything else in db.js (getConfig/saveConfig) — no schema change needed.
// batchMinThreshold: how many posts must land in the window before anything
// actually gets combined (default 2 — the original behavior, where even a
// 2nd post triggers a merge). Raising it means the first (threshold - 1)
// posts send as their own normal messages first; only once the threshold is
// reached do they get retroactively merged into one batch message (deleting
// the standalone messages for the interim posts, editing the very first one
// into the batch). Clamped to [2, MAX_BATCH_ENTRIES_PER_MESSAGE] — 1 isn't a
// batch, and anything above the hard component cap could never be honored.
// batchCrossChannel: if true, posts for the same platform batch together
// across every channel in the guild, not just within the same channel. The
// merged message always lives in whichever channel the FIRST post in that
// window was headed to — see getBatchHostWatch below.
function getBatchMinThreshold(cfg) {
    const n = Number(cfg.batchMinThreshold) || 2;
    return Math.min(Math.max(n, 2), MAX_BATCH_ENTRIES_PER_MESSAGE);
}

// ── Batched notifications ───────────────────────────────────────────────────
// Same channel+platform posts batch into one Components V2 message instead of
// pinging separately — but the trigger is now a rolling time window, not a
// per-cycle count. The first post in a window still sends as a normal single
// embed; the moment a SECOND post for that channel+platform lands within
// BATCH_WINDOW_MS of the last one (whether that's the same poll cycle, a
// later cycle, or a WebSub push), that original message is retroactively
// edited into a batch and the new post is appended to it. Each append slides
// the window forward, so a channel posting every few minutes keeps extending
// the same batch indefinitely instead of starting a new one each time.
// Live posts (isLive) never batch — their "went live"/"ended" message-edit
// tracking doesn't fit the batch format — and batches never cross platforms,
// only same channel+platform groups are batchable, even across different
// tracked accounts.
const BATCH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const DEFAULT_BATCH_HEADER = '**{author}** posted {count} times!';

// allHandles: every distinct handle contributing to this batch (just [w.handle]
// for a single-creator batch) — lets {creators} resolve correctly even when the
// template being rendered belongs to one specific watch in a multi-creator batch.
function renderBatchHeader(w, count, allHandles = [w.handle]) {
    const tmpl = w.batch_header_template || DEFAULT_BATCH_HEADER;
    return tmpl
        .replace(/\{author\}/g, w.handle)
        .replace(/\{handle\}/g, w.handle)
        .replace(/\{creators\}/g, formatCreatorList(allHandles))
        .replace(/\{platform\}/g, PLATFORMS[w.platform]?.label || w.platform)
        .replace(/\{count\}/g, String(count));
}

function formatCreatorList(handles) {
    const unique = [...new Set(handles)];
    if (unique.length === 1) return unique[0];
    if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
    return `${unique.slice(0, -1).join(', ')}, and ${unique[unique.length - 1]}`;
}

// entries: [{ w, post }] all sharing one channel+platform (see sendOrExtendBatch).
function renderBatchHeaderForEntries(entries) {
    const handles = entries.map(e => e.w.handle);
    const unique = [...new Set(handles)];
    if (unique.length === 1) {
        // Single creator — honor that watch's own customizable header template.
        return renderBatchHeader(entries[0].w, entries.length, unique);
    }
    // Multiple creators contributed. Prefer whichever contributing watch has
    // actually customized its header — that's how someone opts a template with
    // {creators} in it into the multi-creator case specifically. If nobody in
    // this batch has customized anything, fall back to the generic "A and B
    // posted N times!" form.
    const customized = entries.find(e => e.w.batch_header_template);
    if (customized) return renderBatchHeader(customized.w, entries.length, unique);
    return `${formatCreatorList(unique)} posted ${entries.length} times!`;
}

function hexColorToInt(hex) {
    return parseInt(String(hex).replace('#', ''), 16);
}

function buildBatchPayload(entries) {
    const platform = entries[0].w.platform;
    const p = PLATFORMS[platform];
    // Union every distinct ping role across the contributing watches — a post
    // from any of them is still something someone asked to be pinged for.
    const roleIds = [...new Set(entries.map(e => e.w.role_id).filter(Boolean))];
    const rolePrefix = roleIds.map(id => `<@&${id}> `).join('');
    // The header is its own top-level component — NOT inside the container —
    // so it renders outside the accent-colored box, only the per-post list
    // sits inside it.
    const header = new TextDisplayBuilder().setContent(`${rolePrefix}${renderBatchHeaderForEntries(entries)}`);
    const container = new ContainerBuilder().setAccentColor(hexColorToInt(p.color));
    entries.forEach(({ w, post }, i) => {
        if (i > 0) container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        const title = (post.title || '(untitled)').slice(0, 250);
        // Compute the URL explicitly here rather than trusting post.url was already
        // shorts-corrected upstream — same result when it was, but this guarantees a
        // Short still opens in the Shorts viewer (not the regular watch page) even if
        // something earlier in the pipeline ever passes through an uncorrected entry.
        const url = (w.platform === 'youtube' && post.postType === 'shorts' && post.id)
            ? `https://www.youtube.com/shorts/${post.id}`
            : post.url;
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(title))
                .setButtonAccessory(new ButtonBuilder().setLabel(buttonLabelFor(w.platform, post)).setStyle(ButtonStyle.Link).setURL(url).setEmoji(p.emojiButton))
        );
    });
    return { components: [header, container], flags: MessageFlags.IsComponentsV2 };
}

async function sendBatchNotification(entries) {
    const w0 = entries[0].w;
    const { guild, channel } = resolveWatchChannel(w0);
    if (!channel) return null;
    return channel.send(buildBatchPayload(entries)).catch(e => { console.error(`send batch notification (${guild.name}/#${channel.name}, ${entries.length} posts):`, e.message); return null; });
}

// Rolling per-channel+platform batch window — see the comment block above.
// Not persisted: a process restart just starts fresh windows, which is fine
// since it only affects whether the next post joins an existing message or
// starts a new one, never notification delivery itself.
const recentBatchState = new Map(); // `${channel_id}::${platform}` -> { messageId, entries, lastAt }

// pollAll's YouTube branch and the WebSub push handler can both call this for the
// same channel+platform key around the same time (a push landing mid-poll-cycle).
// Without serializing per key, two concurrent calls could both read the same stale
// state and one write would clobber the other's, silently dropping an entry from
// the visible batch. This chains calls for the same key one after another.
const batchLocks = new Map(); // key -> promise chain tail

function withBatchLock(key, fn) {
    const prev = batchLocks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    batchLocks.set(key, run.catch(() => {}));
    return run;
}

// Same "grows forever, nothing ever removes an entry" shape as pendingOAuthStates
// above — a channel+platform pair that stops posting (watch removed, channel
// deleted, server leaves) would otherwise sit in both maps for the life of the
// process. Anything past the window is no longer "recent" anyway.
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of recentBatchState) if (now - v.lastAt > BATCH_WINDOW_MS) recentBatchState.delete(k);
    for (const k of batchLocks.keys()) if (!recentBatchState.has(k)) batchLocks.delete(k);
}, 5 * 60 * 1000);

// Discord's Components V2 messages have a hard cap on total nested components
// (40) — and nested components DO count individually toward that cap, not
// just top-level ones. Each batch entry costs 4: the Section itself, its
// child TextDisplay (title text), its Button accessory, and a Separator
// before it (skipped for the first entry). Plus 2 more for the header
// TextDisplay and the Container, both top-level. So total cost is
// 4*N + 1 (N separators is N-1, but +2 header/container -1 makes +1 net).
// The previous cap of 15 assumed ~2 components per entry (Section+Separator
// only, missing the Section's own two children) — its real cost was 61
// components, which Discord rejects outright. That silent rejection is what
// caused batches to visibly cap out well before 15 (whatever count first
// crossed 40) and then, worse, wipe their own state entirely once the resend
// fallback below also failed for the same reason — the next post for that
// channel+platform then had no existing batch to join and went out as its
// own lone single notification, looking like cross-creator batching had
// silently stopped working. 8 entries costs 4*8 + 1 = 33 components,
// comfortably under 40 with real headroom this time.
const MAX_BATCH_ENTRIES_PER_MESSAGE = 8;

async function sendOrExtendBatch(w, post) {
    const cfg = await getConfig(w.guild_id);
    // Cross-channel mode keys purely by guild+platform instead of channel+platform,
    // so watches in different channels can share one batch. Same-channel (default)
    // keeps channel_id in the key so unrelated channels never merge.
    const key = cfg.batchCrossChannel ? `${w.guild_id}::${w.platform}` : `${w.channel_id}::${w.platform}`;
    return withBatchLock(key, () => sendOrExtendBatchLocked(w, post, key, cfg));
}

async function sendOrExtendBatchLocked(w, post, key, cfg) {
    const state = recentBatchState.get(key);
    const now = Date.now();
    const minThreshold = getBatchMinThreshold(cfg);

    if (state && (now - state.lastAt) <= BATCH_WINDOW_MS && state.entries.length < MAX_BATCH_ENTRIES_PER_MESSAGE) {
        state.entries.push({ w, post });
        state.lastAt = now;
        // The merged message always lives in the channel of whichever watch started
        // this window — matters once batchCrossChannel lets different channels'
        // watches share one key; without it, entries[0].w.channel_id always equals
        // w.channel_id anyway, so this is a no-op for the default, same-channel case.
        const { channel } = resolveWatchChannel(state.entries[0].w);
        if (!channel) { recentBatchState.delete(key); return null; }

        if (state.isBatch) {
            // Already converted on an earlier post — normal edit-extend.
            try {
                const msg = await channel.messages.fetch(state.messageId);
                // Converting a normal single-embed/content message into Components V2
                // (or re-editing one that already is) requires explicitly nulling out
                // content/embeds/stickers/poll on the edit — passing only
                // flags+components isn't enough for Discord to accept the switch.
                return await msg.edit({ ...buildBatchPayload(state.entries), content: null, embeds: null, stickers: null, poll: null });
            } catch (e) {
                // Original message is gone (deleted, too old to fetch, lost permissions),
                // OR this batch still somehow exceeds Discord's limits despite the cap
                // above — fall back to sending a fresh batch message. If it's the size
                // problem, retrying with the exact same over-sized entries would just
                // fail again identically, so trim to the cap (keeping the most recent
                // entries) before retrying, rather than losing the whole batch.
                console.error(`extend batch (${key}):`, e.message);
                let retryEntries = state.entries;
                let sent = await sendBatchNotification(retryEntries);
                if (!sent && retryEntries.length > MAX_BATCH_ENTRIES_PER_MESSAGE) {
                    console.error(`extend batch (${key}): retrying with the most recent ${MAX_BATCH_ENTRIES_PER_MESSAGE} of ${retryEntries.length} entries`);
                    retryEntries = retryEntries.slice(-MAX_BATCH_ENTRIES_PER_MESSAGE);
                    sent = await sendBatchNotification(retryEntries);
                }
                if (sent) { state.messageId = sent.id; state.entries = retryEntries; }
                else recentBatchState.delete(key);
                return sent;
            }
        }

        if (state.entries.length >= minThreshold) {
            // Just reached the threshold for the first time — merge everything sent
            // so far into one message: edit the very first post's own message into a
            // batch (preserving its message ID/timestamp/link), and delete every
            // OTHER standalone message in between (the brand new post that triggered
            // this never had one sent yet, so it's naturally excluded). With the
            // default threshold of 2 there's nothing to delete — this edits the first
            // message in place exactly like before thresholds existed.
            for (let i = 1; i < state.entries.length - 1; i++) {
                const id = state.entries[i].standaloneMessageId;
                if (id) await channel.messages.delete(id).catch(() => {});
            }
            try {
                const msg = await channel.messages.fetch(state.entries[0].standaloneMessageId);
                const edited = await msg.edit({ ...buildBatchPayload(state.entries), content: null, embeds: null, stickers: null, poll: null });
                state.messageId = state.entries[0].standaloneMessageId;
                state.isBatch = true;
                return edited;
            } catch (e) {
                console.error(`merge batch (${key}):`, e.message);
                const sent = await sendBatchNotification(state.entries);
                if (sent) { state.messageId = sent.id; state.isBatch = true; }
                else recentBatchState.delete(key);
                return sent;
            }
        }

        // Still below the threshold — this post sends as its own normal message
        // too, same as it would with batching off, while still being tracked in
        // case a future post within the window pushes the count over the line.
        const sent = await sendNotification(w, post);
        state.entries[state.entries.length - 1].standaloneMessageId = sent?.id || null;
        return sent;
    }

    // No live window for this channel (+platform, or +guild in cross-channel mode),
    // OR the current batch already hit MAX_BATCH_ENTRIES_PER_MESSAGE — either way,
    // send as a normal single notification and open a fresh window/message. When
    // this is the "batch is full" case, the old message is simply left as-is (still
    // showing its full, valid set of entries) and this starts spillover into a
    // brand new message rather than trying to cram more onto one at the ceiling.
    const sent = await sendNotification(w, post);
    if (sent) recentBatchState.set(key, { messageId: sent.id, entries: [{ w, post, standaloneMessageId: sent.id }], lastAt: now, isBatch: false });
    else recentBatchState.delete(key);
    return sent;
}


module.exports = { DEFAULT_BATCH_HEADER, sendOrExtendBatch, MAX_BATCH_ENTRIES_PER_MESSAGE };
