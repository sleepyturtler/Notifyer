// pollAll (fast/slow loops + /social check), per-cycle fetch caching, Nitter outage tracking.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { NITTER_INSTANCES, PLATFORMS, SEEN_HISTORY_SIZE } = require('./config.js');
const { client } = require('./client.js');
const { getAllWatches, getSocialLinkById, setWatchLiveMessage, setWatchYouTubeLiveVideo, touchLastChecked, updateLastPost } = require('./db.js');
const { classifyYouTubeVideos, fetchLatestYouTubeEntries } = require('./platforms/youtube.js');
const { markStreamOffline, sendNotification, shouldNotify } = require('./notify.js');
const { sendOrExtendBatch } = require('./batch.js');
const { fetchLatestTwitchAll } = require('./platforms/twitch.js');
const { fetchLatestKickAll } = require('./platforms/kick.js');
const { fetchLatestInstagramAll, fetchLatestTikTokAll } = require('./platforms/social.js');
const { fetchLatestPost } = require('./platforms/index.js');

// ── Polling loop ───────────────────────────────────────────────────────────
const PLATFORM_MIN_INTERVAL_MS = {};

// pollInProgress is keyed per call-site (fast loop / slow loop / manual /social
// check) so the two cadences never block on each other — they touch disjoint
// platform sets anyway, so there's no risk of double-processing the same watch.
const pollInProgress = {};

// ── Nitter mirror health tracking ───────────────────────────────────────────
// Twitter/X has no official free API, so tracking depends entirely on public
// Nitter mirrors staying up. If the whole configured list goes down at once,
// this used to only ever surface as a console error buried in server logs —
// easy to miss until someone notices Twitter notifications have silently
// stopped arriving. This alerts the owner directly instead (rate-limited so a
// prolonged outage doesn't spam them repeatedly).
const NITTER_DOWN_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert at most every 6 hours

let nitterDownSince = null;

let lastNitterDownAlertAt = 0;

async function handleAllNittersDown(errorMessage) {
    const now = Date.now();
    if (!nitterDownSince) nitterDownSince = now;
    if (now - lastNitterDownAlertAt < NITTER_DOWN_ALERT_COOLDOWN_MS) return;
    lastNitterDownAlertAt = now;
    console.error(`🚨 All ${NITTER_INSTANCES.length} configured Nitter mirror(s) are down — Twitter/X tracking has been failing since ${new Date(nitterDownSince).toISOString()}. Update NITTER_INSTANCES with working mirrors.`);
    if (!process.env.BOT_OWNER_ID) return;
    try {
        const owner = await client.users.fetch(process.env.BOT_OWNER_ID);
        await owner.send(`🚨 **Notifyer: Twitter/X tracking is down.** All ${NITTER_INSTANCES.length} configured Nitter mirror(s) are failing (down since <t:${Math.floor(nitterDownSince / 1000)}:R>). Twitter/X notifications won't go out until \`NITTER_INSTANCES\` is updated with working mirrors, or a mirror recovers on its own.\n\nLatest error: \`${errorMessage.slice(0, 500)}\``);
    } catch (e) {
        console.error('Nitter-down owner DM failed:', e.message);
    }
}

function handleNittersRecovered() {
    if (!nitterDownSince) return;
    console.log(`✅ Nitter mirrors recovered — Twitter/X tracking had been down since ${new Date(nitterDownSince).toISOString()}.`);
    nitterDownSince = null;
}

async function pollAll(platforms = null, onlyGuildId = null) {
    // /social check is a per-guild command, but pollAll(null) with no scoping
    // processes every watch on every server the bot is in — including the full
    // per-watch stagger/jitter delay for all of them. On a bot running in more
    // than a handful of servers that's minutes of work (and every one of those
    // OTHER servers' rate-limit errors) before the calling admin's own server
    // ever gets checked, which is almost certainly why this command reads as
    // "doesn't work" — it eventually finishes, just far too slowly to look like
    // anything happened. onlyGuildId scopes both the lock and the watch list to
    // just the calling guild.
    const lockKey = onlyGuildId ? `guild:${onlyGuildId}` : (platforms ? [...platforms].sort().join(',') : 'all');
    if (pollInProgress[lockKey]) return;
    pollInProgress[lockKey] = true;
    try {
        // platforms filtering (and active=TRUE) now happens in SQL when a
        // platform set is passed — see getAllWatches. The in-memory !w.active
        // check below stays as a safety net for the no-args (/social check)
        // path, which still fetches unfiltered.
        let watches = await getAllWatches(platforms);
        if (onlyGuildId) watches = watches.filter(w => w.guild_id === onlyGuildId);
        // Scoped to this one poll pass only — see the instagram/tiktok branch below.
        const perCyclePostsCache = new Map(); // key -> Promise<posts[] | null>; key is social_link_id (Instagram/TikTok) or `${platform}:${handle}` (Twitch/Kick)
        for (const w of watches) {
            if (!w.active) continue;
            // Platform's credentials were removed after this watch was created (or
            // it's an outage-flagged platform like Twitter during a Nitter mirror
            // failure) — skip cleanly instead of logging a fetch error every cycle
            // for a watch that can never succeed right now. It'll resume on its own
            // once the platform becomes available again, no action needed here.
            if (PLATFORMS[w.platform]?.unavailable) continue;
            const minInterval = PLATFORM_MIN_INTERVAL_MS[w.platform];
            if (minInterval && w.last_checked && (Date.now() - w.last_checked) < minInterval) continue;
            try {
                const seenIds = Array.isArray(w.seen_post_ids) ? w.seen_post_ids : [];

                if (w.platform === 'youtube') {
                    // Walk every unseen entry, not just the newest, so bursty uploads
                    // between polls don't get silently skipped.
                    const entries = await fetchLatestYouTubeEntries(w);
                    if (!entries.length) { await touchLastChecked(w.id); continue; }
                    if (w.last_post_id === null) {
                        // First check — seed baseline, don't notify for the back-catalog
                        await updateLastPost(w.id, entries[0].id, entries.map(e => e.id));
                        continue;
                    }
                    const newEntries = entries.filter(e => !seenIds.includes(e.id));
                    if (!newEntries.length && !w.youtube_live_video_id) { await touchLastChecked(w.id); continue; }

                    // Batch-classify every new entry PLUS whatever's currently tracked as
                    // live (if it's not already among the new entries) in one API call —
                    // videos.list costs 1 unit per call regardless of how many IDs, so
                    // there's no reason to ever call it per-video.
                    const idsToClassify = [...new Set([...newEntries.map(e => e.id), ...(w.youtube_live_video_id ? [w.youtube_live_video_id] : [])])];
                    const classified = idsToClassify.length ? await classifyYouTubeVideos(idsToClassify) : {};

                    // A previously-live video that's no longer live (or fell out of the
                    // classify batch entirely, e.g. deleted) has ended — same "edit the
                    // went-live message" mechanism Twitch/Kick already use.
                    if (w.youtube_live_video_id) {
                        const stillLive = classified[w.youtube_live_video_id]?.isLive;
                        if (!stillLive) {
                            await markStreamOffline(w);
                            await setWatchYouTubeLiveVideo(w.id, null);
                        }
                    }

                    if (newEntries.length) {
                        // Chronological (oldest-first) so a batch reads/sends in upload order
                        const chronological = [...newEntries].reverse();
                        for (const entry of chronological) {
                            const c = classified[entry.id];
                            entry.postType = c?.postType || 'videos';
                            entry.isLive = Boolean(c?.isLive);
                            if (entry.postType === 'shorts') entry.url = `https://www.youtube.com/shorts/${entry.id}`;
                        }
                        const toNotify = chronological.filter(e => shouldNotify(w, e));
                        // Live entries always send individually and immediately, with their
                        // own message-edit tracking — never batched, same rule as every
                        // other platform.
                        for (const entry of toNotify.filter(e => e.isLive)) {
                            const sent = await sendNotification(w, entry);
                            if (sent) { await setWatchLiveMessage(w.id, sent.id); await setWatchYouTubeLiveVideo(w.id, entry.id); }
                        }
                        for (const entry of toNotify.filter(e => !e.isLive)) await sendOrExtendBatch(w, entry);
                        const mergedSeen = [...new Set([...newEntries.map(e => e.id), ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
                        await updateLastPost(w.id, entries[0].id, mergedSeen, true);
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else if (w.platform === 'twitch' || w.platform === 'kick' || w.platform === 'instagram' || w.platform === 'tiktok') {
                    // These platforms return multiple posts/post-types at once per check
                    let posts;
                    if (w.platform === 'twitch' || w.platform === 'kick') {
                        // Same redundant-external-call shape as the Instagram/TikTok shared-link
                        // case below — multiple watches (any servers) can track the same
                        // streamer by handle, and without caching each one independently re-hits
                        // the real Twitch/Kick API for the identical channel, every fast-poll
                        // cycle (20s). Cache by platform+handle for the rest of this pass.
                        const handleCacheKey = `${w.platform}:${w.handle.toLowerCase()}`;
                        if (!perCyclePostsCache.has(handleCacheKey)) {
                            perCyclePostsCache.set(handleCacheKey, w.platform === 'twitch' ? fetchLatestTwitchAll(w.handle) : fetchLatestKickAll(w.handle));
                        }
                        posts = await perCyclePostsCache.get(handleCacheKey);
                    } else {
                        if (!w.social_link_id) { await touchLastChecked(w.id); continue; } // not linked yet — nothing to poll
                        // Multiple watches (even across channels/guilds) can share one linked
                        // account — see /social remove's "does another watch still use this
                        // link" check. Without caching, each one re-hits the actual
                        // Instagram/TikTok API independently for the identical account, every
                        // cycle — a real external call against a real rate limit, not just a
                        // DB read, so it's worth sharing across the whole poll pass.
                        if (!perCyclePostsCache.has(w.social_link_id)) {
                            perCyclePostsCache.set(w.social_link_id, (async () => {
                                const link = await getSocialLinkById(w.social_link_id);
                                if (!link) return null; // link was removed
                                return w.platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
                            })());
                        }
                        posts = await perCyclePostsCache.get(w.social_link_id);
                        if (posts === null) { await touchLastChecked(w.id); continue; } // link was removed
                    }
                    let newSeenIds = [...seenIds];
                    let updated = false;
                    const toNotify = [];
                    for (const post of posts) {
                        if (w.last_post_id === null) continue; // first check — skip all
                        if (newSeenIds.includes(post.id)) continue;
                        newSeenIds = [...new Set([post.id, ...newSeenIds])].slice(0, 20);
                        updated = true;
                        if (shouldNotify(w, post)) toNotify.push(post);
                    }
                    // Live posts keep their own message-edit tracking (see markStreamOffline
                    // below) and always send individually — batching only applies to regular
                    // posts/VODs, never to "went live" events.
                    for (const post of toNotify.filter(p => p.isLive)) {
                        const sent = await sendNotification(w, post);
                        if (sent) await setWatchLiveMessage(w.id, sent.id);
                    }
                    for (const post of toNotify.filter(p => !p.isLive)) await sendOrExtendBatch(w, post);
                    // Stream-ended detection: we were tracking a "went live" message, but this
                    // poll's results no longer include a live entry — edit that message to
                    // show it ended instead of leaving it saying "is live" forever. (No-op for
                    // Instagram/TikTok posts, which never set isLive in the first place.)
                    if (!posts.some(p => p.isLive) && w.live_message_id) await markStreamOffline(w);
                    if (w.last_post_id === null && posts.length) {
                        // Seed baseline from first check
                        await updateLastPost(w.id, posts[0].id, posts.map(p => p.id));
                    } else if (updated) {
                        await updateLastPost(w.id, newSeenIds[0], newSeenIds, true);
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else {
                    const post = await fetchLatestPost(w.platform, w.handle);
                    if (w.platform === 'twitter') handleNittersRecovered();
                    if (!post || !post.id) { await touchLastChecked(w.id); continue; }
                    if (w.last_post_id === null) {
                        await updateLastPost(w.id, post.id, seenIds);
                        continue;
                    }
                    if (seenIds.includes(post.id)) { await touchLastChecked(w.id); continue; }
                    await updateLastPost(w.id, post.id, seenIds, true);
                    if (!shouldNotify(w, post)) continue;
                    await sendOrExtendBatch(w, post);
                }
            } catch (e) {
                if (/HTTP 429/.test(e.message)) {
                    console.warn(`poll ${w.platform}/${w.handle}: rate-limited (429), retrying next cycle`);
                } else {
                    console.error(`poll ${w.platform}/${w.handle}:`, e.message);
                }
                if (w.platform === 'twitter' && /All Nitter instances failed/.test(e.message)) {
                    await handleAllNittersDown(e.message).catch(() => {});
                }
                await touchLastChecked(w.id, e.message).catch(() => {});
            }
            // Stagger with jitter to avoid hammering platforms all at once
            const jitter = 1000 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, jitter));
        }
    } finally {
        pollInProgress[lockKey] = false;
    }
}

module.exports = { pollAll };
