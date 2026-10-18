// pollAll (fast/slow loops + /social check), per-cycle fetch caching, Nitter outage tracking.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { NITTER_INSTANCES, PLATFORMS, SEEN_HISTORY_SIZE, YOUTUBE_PUSH_POLL_INTERVAL_MS } = require('./config.js');
const { client } = require('./client.js');
const { getWatch, getAllWatches, getWatchesByLink, getPushCoveredYouTubeChannels, setWatchPollInterval, getSocialLinkById, setWatchLiveMessage, setWatchYouTubeLiveVideo, touchLastChecked, updateLastPost } = require('./db.js');
const { classifyYouTubeVideos, fetchLatestYouTubeEntries } = require('./platforms/youtube.js');
const { markStreamOffline, sendNotification, shouldNotify } = require('./notify.js');
const { sendOrExtendBatch } = require('./batch.js');
const { fetchLatestTwitchAll } = require('./platforms/twitch.js');
const { fetchLatestKickAll } = require('./platforms/kick.js');
const { fetchLatestBlueskyAll } = require('./platforms/bluesky.js');
const { fetchLatestRssAll } = require('./platforms/rss.js');
const { computeInterval, hasAdaptivePolling, nextBackoff, pollDue } = require('./rssPoll.js');
const { fetchLatestInstagramAll, fetchLatestTikTokAll } = require('./platforms/social.js');
const { fetchLatestPost } = require('./platforms/index.js');
const { reportLinkProblem } = require('./announcements.js');

// ── Polling loop ───────────────────────────────────────────────────────────
const PLATFORM_MIN_INTERVAL_MS = {};

// pollInProgress is keyed per call-site (fast loop / slow loop / manual /social
// check) so the two cadences never block on each other. The fast and slow loops touch
// disjoint platform sets, but a manual /social check covers every platform, so it can
// overlap either loop: watchesInFlight makes sure one watch is never processed by two
// passes at once (both would read the same "seen" list and send the same post twice).
const pollInProgress = {};
const watchesInFlight = new Set();

// ── Nitter mirror health tracking ───────────────────────────────────────────
// Twitter/X has no official free API, so tracking depends entirely on public
// Nitter mirrors staying up. If the whole configured list goes down at once,
// this used to only ever surface as a console error buried in server logs —
// easy to miss until someone notices Twitter notifications have silently
// stopped arriving. This alerts the owner directly instead (rate-limited so a
// prolonged outage doesn't spam them repeatedly).
const NITTER_DOWN_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // re-alert at most every 6 hours

let nitterDownSince = null;
let nitterAlerted = false;
// Public mirrors blip constantly. Only treat it as an outage (log + owner DM) once every mirror has been failing
// continuously for this long; any successful poll in between resets the clock.
const NITTER_DOWN_GRACE_MS = 10 * 60 * 1000;

let lastNitterDownAlertAt = 0;

async function handleAllNittersDown(errorMessage) {
    const now = Date.now();
    if (!nitterDownSince) nitterDownSince = now;
    if (now - nitterDownSince < NITTER_DOWN_GRACE_MS) return;
    if (now - lastNitterDownAlertAt < NITTER_DOWN_ALERT_COOLDOWN_MS) return;
    lastNitterDownAlertAt = now;
    nitterAlerted = true;
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
    if (nitterAlerted) console.log(`✅ Nitter mirrors recovered — Twitter/X tracking had been down since ${new Date(nitterDownSince).toISOString()}.`);
    nitterDownSince = null;
    nitterAlerted = false;
}

// A YouTube watch whose channel has a hub-confirmed push subscription only needs a safety-net poll every
// YOUTUBE_PUSH_POLL_INTERVAL_MS. Polls stay at the normal pace when: the last check failed, a live stream is being
// tracked (polling is what notices it ended), or the channel isn't covered by push.
function skipYouTubePoll(w, pushCovered, now = Date.now()) {
    return Boolean(pushCovered && w.platform === 'youtube' && w.youtube_channel_id && pushCovered.has(w.youtube_channel_id)
        && !w.youtube_live_video_id && !w.last_error && w.last_checked && (now - w.last_checked) < YOUTUBE_PUSH_POLL_INTERVAL_MS);
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
        // Manual /social check (onlyGuildId) always polls; the scheduled slow loop skips push-covered YouTube watches.
        const pushCovered = (!onlyGuildId && watches.some(w => w.platform === 'youtube')) ? await getPushCoveredYouTubeChannels().catch(e => { console.error('push-covered lookup:', e.message); return null; }) : null;
        const perCyclePostsCache = new Map(); // key -> Promise<posts[] | null>; key is social_link_id (Instagram/TikTok) or `${platform}:${handle}` (Twitch/Kick)
        let nitterOk = 0, nitterFail = 0, nitterFailMsg = null, nitterLogged = false;
        for (let w of watches) {
            if (!w.active) continue;
            // Platform's credentials were removed after this watch was created (or
            // it's an outage-flagged platform like Twitter during a Nitter mirror
            // failure) — skip cleanly instead of logging a fetch error every cycle
            // for a watch that can never succeed right now. It'll resume on its own
            // once the platform becomes available again, no action needed here.
            if (PLATFORMS[w.platform]?.unavailable) continue;
            const minInterval = PLATFORM_MIN_INTERVAL_MS[w.platform];
            if (minInterval && w.last_checked && (Date.now() - w.last_checked) < minInterval) continue;
            if (skipYouTubePoll(w, pushCovered)) continue;
            if (!onlyGuildId && hasAdaptivePolling(w.platform) && !pollDue(w.platform, w)) continue; // adaptive: each account has its own interval
            if (watchesInFlight.has(w.id)) continue; // another pass is already handling this watch
            watchesInFlight.add(w.id);
            try {
                // The list above was read at the start of the pass and each watch is processed seconds later (jitter
                // between watches), so re-read this row now: a WebSub push may have recorded a video in the meantime,
                // and acting on the stale "seen" list would announce it a second time.
                w = (await getWatch(w.guild_id, w.id)) || w;
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

                    // Scheduled streams/premieres aren't live yet: leave them unseen so they're picked
                    // up again (and notify) once they actually start, instead of announcing a
                    // "new video" now and then never announcing the live start.
                    const ready = newEntries.filter(e => !classified[e.id]?.isUpcoming);
                    if (ready.length) {
                        // Record what's about to be sent BEFORE sending (same order as the WebSub and
                        // Twitter paths): if a send throws mid-loop, already-sent entries are not re-sent
                        // on every following poll.
                        const mergedSeen = [...new Set([...ready.map(e => e.id), ...seenIds])].slice(0, SEEN_HISTORY_SIZE);
                        await updateLastPost(w.id, ready[0].id, mergedSeen, true); // ready[0], NOT entries[0]: updateLastPost also adds this id to the seen list, which must never include a still-upcoming stream
                        // Chronological (oldest-first) so a batch reads/sends in upload order
                        const chronological = [...ready].reverse();
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
                    } else {
                        await touchLastChecked(w.id);
                    }
                } else if (w.platform === 'twitch' || w.platform === 'kick' || w.platform === 'bluesky' || w.platform === 'rss' || w.platform === 'instagram' || w.platform === 'tiktok') {
                    // These platforms return multiple posts/post-types at once per check
                    let posts;
                    if (w.platform === 'twitch' || w.platform === 'kick' || w.platform === 'bluesky' || w.platform === 'rss') {
                        // Same redundant-external-call shape as the Instagram/TikTok shared-link
                        // case below — multiple watches (any servers) can track the same
                        // streamer by handle, and without caching each one independently re-hits
                        // the real Twitch/Kick API for the identical channel, every fast-poll
                        // cycle (20s). Cache by platform+handle for the rest of this pass.
                        const handleCacheKey = `${w.platform}:${w.platform === 'rss' ? w.handle : w.handle.toLowerCase()}`; // feed URLs are case-sensitive
                        if (!perCyclePostsCache.has(handleCacheKey)) {
                            perCyclePostsCache.set(handleCacheKey, (w.platform === 'twitch' ? fetchLatestTwitchAll : w.platform === 'kick' ? fetchLatestKickAll : w.platform === 'rss' ? fetchLatestRssAll : fetchLatestBlueskyAll)(w.handle));
                        }
                        posts = await perCyclePostsCache.get(handleCacheKey);
                        if (w.platform === 'rss') await setWatchPollInterval(w.id, computeInterval('rss', (posts || []).map(p => p.timestamp))).catch(() => {});
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
                                if (link.needs_relink_at) return { dead: true }; // the platform rejected its login; waiting for the owner to re-link
                                try {
                                    return w.platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
                                } catch (e) {
                                    // Once per link per pass (this promise is shared by every watch using it, in every server).
                                    if (e.relinkNeeded) reportLinkProblem(link, 'dead', await getWatchesByLink(link.id).catch(() => []), e.message);
                                    throw e;
                                }
                            })());
                        }
                        posts = await perCyclePostsCache.get(w.social_link_id);
                        if (posts && posts.dead) { await touchLastChecked(w.id, 'The linked account needs to be re-linked (/social link).'); continue; }
                        if (posts === null) { await touchLastChecked(w.id); continue; } // link was removed
                    }
                    let newSeenIds = [...seenIds];
                    let updated = false;
                    const toNotify = [];
                    for (const post of posts) {
                        if (w.last_post_id === null) continue; // first check — skip all
                        if (newSeenIds.includes(post.id)) continue;
                        newSeenIds = [...new Set([post.id, ...newSeenIds])].slice(0, SEEN_HISTORY_SIZE);
                        updated = true;
                        if (shouldNotify(w, post)) toNotify.push(post);
                    }
                    // Record the new IDs before sending, so a throw mid-send can't cause the
                    // already-sent ones to be re-sent every following cycle.
                    if (w.last_post_id !== null && updated) await updateLastPost(w.id, newSeenIds[0], newSeenIds, true);
                    // Live posts keep their own message-edit tracking (see markStreamOffline
                    // below) and always send individually — batching only applies to regular
                    // posts/VODs, never to "went live" events.
                    for (const post of toNotify.filter(p => p.isLive)) {
                        // A new live post while an older live message is still tracked means the previous
                        // stream ended and a new one began between two polls: close the old message out first,
                        // otherwise it would keep saying "is live" forever once live_message_id is overwritten.
                        if (w.live_message_id) { await markStreamOffline(w); w.live_message_id = null; }
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
                    } else if (!updated) {
                        await touchLastChecked(w.id);
                    }
                } else {
                    // Twitter fetches ask every Nitter mirror, so accounts tracked by several servers share one fetch per pass.
                    let postPromise;
                    if (w.platform === 'twitter') {
                        const key = `twitter:${w.handle.toLowerCase()}`;
                        if (!perCyclePostsCache.has(key)) perCyclePostsCache.set(key, fetchLatestPost(w.platform, w.handle));
                        postPromise = perCyclePostsCache.get(key);
                    } else postPromise = fetchLatestPost(w.platform, w.handle);
                    const post = await postPromise;
                    if (w.platform === 'twitter') {
                        nitterOk++;
                        await setWatchPollInterval(w.id, computeInterval('twitter', post ? [post.timestamp, ...(post.recentTimestamps || [])] : [])).catch(() => {});
                    }
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
                } else if (w.platform === 'twitter' && /All Nitter instances failed/.test(e.message)) {
                    // Print the per-mirror errors once per pass; every further account would repeat the same list.
                    console.error(`poll twitter/${w.handle}:`, nitterLogged ? 'every mirror failed (mirror errors listed above)' : e.message);
                    nitterLogged = true; nitterFail++; nitterFailMsg = e.message;
                } else {
                    console.error(`poll ${w.platform}/${w.handle}:`, e.message);
                }
                // Dead feeds back off. A Nitter outage is NOT the account's fault (every account fails together), so
                // Twitter keeps its interval then rather than leaving every account slow once the mirrors recover.
                if (w.platform === 'rss' || (w.platform === 'twitter' && !/All Nitter instances failed/.test(e.message))) {
                    await setWatchPollInterval(w.id, nextBackoff(w.platform, w.poll_interval_ms)).catch(() => {});
                }
                await touchLastChecked(w.id, e.message).catch(() => {});
            } finally {
                watchesInFlight.delete(w.id);
            }
            // Stagger with jitter to avoid hammering platforms all at once
            const jitter = 1000 + Math.random() * 1000;
            await new Promise(r => setTimeout(r, jitter));
        }
        // A Nitter outage means EVERY twitter account failed in this pass. One account failing while others succeed is
        // an account problem (suspended, protected, no tweets), not a dead mirror list; judging per account made the
        // alert and the "recovered" message flip back and forth as accounts alternated.
        if (nitterFail && !nitterOk) await handleAllNittersDown(nitterFailMsg).catch(() => {});
        else if (nitterOk) handleNittersRecovered();
    } finally {
        pollInProgress[lockKey] = false;
    }
}

module.exports = { pollAll, skipYouTubePoll };
