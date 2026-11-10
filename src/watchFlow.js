// Shared watch-creation flow used by /social add and /setup.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { normalizeHandle, watchName } = require('./helpers.js');
const { addWatch, getSocialLinkByUsername, getWatches, markWatchSeeded, setWatchSocialLink, updateLastPost } = require('./db.js');
const { fetchLatestInstagramAll, fetchLatestTikTokAll } = require('./platforms/social.js');
const { BULK_FETCHERS } = require('./platforms/index.js');
const { fetchLatestYouTubeEntries } = require('./platforms/youtube.js');
const { PLACEHOLDER_HELP } = require('./notify.js');
const { GREEN, RED, box } = require('./v2.js');
const { checkLinkAccess, requestLinkApproval } = require('./linkRequests.js');

// ── Shared watch-creation flow ──────────────────────────────────────────────
// Used by both /social add and the /setup wizard so there's exactly one place
// that validates a platform+handle+channel and creates the watch — no risk of
// the two entry points drifting apart. Returns { ok: true, watch, post } or
// { ok: false, message } (message is already a user-facing ❌ reply string).
async function createWatchFlow(guildId, platform, rawHandle, channelId, addedByTag, bypassUnavailable = false, userId = null) {
    if (!PLATFORMS[platform]) {
        return { ok: false, message: `❌ Unrecognized platform \`${platform}\`. Please pick one of the options Discord suggests as you type.` };
    }
    if (PLATFORMS[platform]?.unavailable && !bypassUnavailable) {
        return { ok: false, message: `❌ ${PLATFORMS[platform].label} is temporarily unavailable and can't be added right now (see \`/help\` → Info for details).` };
    }
    const handle = normalizeHandle(platform, rawHandle);
    if (!handle) return { ok: false, message: '❌ Could not parse that handle/URL.' };

    const watches = await getWatches(guildId);
    if (watches.some(w => w.platform === platform && w.handle.toLowerCase() === handle.toLowerCase() && w.channel_id === channelId)) {
        return { ok: false, message: '❌ That account is already being tracked in this channel.' };
    }
    if (watches.length >= 50) return { ok: false, message: '❌ This server has reached the maximum of 50 tracked accounts.' };

    let post = null;
    let displayName = null; // RSS: the feed's own title, used instead of the URL
    let baselineSeenIds = [];
    let fetchedOk = false; // a fetch really succeeded (even if it found nothing yet)
    let socialLinkId = null;
    if (PLATFORMS[platform].oauth) {
        // Instagram/TikTok can only be watched for accounts that have gone through
        // /social link — there's no way to poll an arbitrary public account via
        // their official APIs without that account's consent.
        const link = await getSocialLinkByUsername(platform, handle);
        if (link && link.needs_relink_at) {
            return { ok: false, message: `❌ The linked **${handle}** account needs to be re-linked first: its owner has to run \`/social link\` again.` };
        }
        if (!link) {
            return { ok: false, message: `❌ **${handle}** hasn't been linked yet. That account needs to run \`/social link\` and authorize with ${PLATFORMS[platform].label} first — this bot can't watch ${PLATFORMS[platform].label} accounts that haven't consented.\nUse \`/social links\` to see what's already linked in this server.` };
        }
        // Someone else's linked account can only be added by them, the bot owner, or a server that already uses it or
        // was approved; anyone else triggers an approval request to the person who linked it.
        if (!(await checkLinkAccess(link, guildId, userId)).allowed) {
            return { ok: false, message: (await requestLinkApproval(link, guildId, userId, addedByTag)).message };
        }
        socialLinkId = link.id;
        try {
            const posts = platform === 'instagram' ? await fetchLatestInstagramAll(link) : await fetchLatestTikTokAll(link);
            post = posts[0] || null;
            // Seed seen_post_ids with EVERY post returned by this check, not just the
            // newest — otherwise the next poll (or /social check) treats the older
            // ones as "unseen" and fires notifications for pre-existing content.
            baselineSeenIds = posts.map(p => p.id);
            fetchedOk = true;
        } catch (e) {
            return { ok: false, message: `❌ Couldn't fetch that account: ${e.message}` };
        }
    } else {
        try {
            if (BULK_FETCHERS[platform]) {
                const posts = await BULK_FETCHERS[platform](handle);
                post = posts[0] || null;
                if (platform === 'rss') displayName = posts[0]?.author || null;
                baselineSeenIds = posts.map(p => p.id);
            } else if (platform === 'youtube') {
                // YouTube is handled separately via
                // the Data API + playlist-ID cache (fetchLatestYouTubeEntries), which
                // needs a real watch.id to cache the resolved channel/playlist IDs
                // against. Deferred until after addWatch() below, once we have one.
            }
            fetchedOk = platform !== 'youtube'; // YouTube's fetch happens after addWatch(), below
        } catch (e) {
            if (/HTTP 429/.test(e.message)) {
                // Rate-limited on verify — account likely exists, proceed anyway
                post = null;
            } else {
                return { ok: false, message: `❌ Couldn't fetch that account: ${e.message}\nDouble-check the handle/URL and try again.` };
            }
        }
    }

    const watch = await addWatch({ guildId, platform, handle, channelId, addedBy: addedByTag, displayName });
    if (!watch) return { ok: false, message: '❌ That account is already being tracked in this channel.' }; // lost a race with another add
    if (socialLinkId) await setWatchSocialLink(guildId, watch.id, socialLinkId);

    if (platform === 'youtube') {
        try {
            const posts = await fetchLatestYouTubeEntries(watch);
            post = posts[0] || null;
            baselineSeenIds = posts.map(p => p.id);
            fetchedOk = true;
        } catch (e) {
            // Same "proceed anyway" leniency as the 429 case above for other
            // platforms — don't fail watch creation over this. Baseline will
            // just seed itself on the first routine poll instead, same as it
            // always has for a watch with no baseline yet.
            console.error(`YouTube baseline fetch for new watch (${watch.id}):`, e.message);
        }
    }

    // Seed last_post_id AND seen_post_ids so the first poll doesn't fire
    // notifications for content that already existed before tracking started.
    // If the fetch worked but found nothing (e.g. a streamer who is offline and has no VODs), store a
    // sentinel instead of null: null means "no baseline yet", which makes the poller treat the FIRST
    // thing it ever sees as baseline, so the first stream after adding the watch would never notify.
    await updateLastPost(watch.id, post?.id || (fetchedOk ? 'baseline' : null), baselineSeenIds);
    if (platform === 'twitter' && baselineSeenIds.length) await markWatchSeeded(watch.id); // its current feed is already recorded as seen
    return { ok: true, watch, post, handle };
}

// Builds the same "Now Tracking" + next-step (type picker or message-set button)
// response used right after a watch is created, regardless of whether it came
// from /social add or the /setup wizard.
function buildAddWatchSuccessResponse(watch, post, handle, channel) {
    const p = PLATFORMS[watch.platform];
    const types = PLATFORM_NOTIFY_TYPES[watch.platform];
    const info = [
        `**Platform:** ${p.emojiTag} ${p.label}`,
        `**Account:** ${watchName(watch) !== watch.handle ? watchName(watch) : handle}`,
        `**Channel:** ${channel}`,
    ].join('\n');
    const baseline = post?.title
        ? `**Latest post (baseline)**\n[${post.title.slice(0, 100)}](${post.url})`
        : '**Baseline**\nNo posts found yet \u2014 will track from first post.';
    const success = box(GREEN, ['## Now Tracking', info, baseline]);

    // Single-type platforms (TikTok, Twitter) skip the type-choice step entirely \u2014
    // there's only one kind of post, so go straight to a "set your message" button.
    if (types.length <= 1) {
        const next = box(GREEN, ['One more step \u2014 set the notification message below.', `**Placeholders**\n${PLACEHOLDER_HELP}`]);
        const msgRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`socialpertype_open_${watch.id}_new`).setLabel('Set Message').setStyle(ButtonStyle.Primary)
        );
        return { components: [success, next, msgRow] };
    }

    // Multi-type platforms: choose notification types first \u2014 selecting (or skipping)
    // chains straight into the per-type message form, so this is a single guided path
    // instead of separate optional buttons.
    const choose = box(RED, [
        `## ${p.emojiTag} Choose Notification Types`,
        `Which types of **${p.label}** content do you want notifications for?\nSelect one or more below \u2014 you'll set the message for each right after.`,
        `**Placeholders (for the message you set next)**\n${PLACEHOLDER_HELP}`,
    ]);
    const typeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`socialtypeadd_select_${watch.id}`)
            .setPlaceholder('Select notification types\u2026')
            .setMinValues(1).setMaxValues(types.length)
            .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description })))
    );
    const skipRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialtypeadd_skip_${watch.id}`).setLabel(`${types.some(t => t.defaultOff) ? 'Default types' : 'All types'} (skip)`).setStyle(ButtonStyle.Secondary)
    );
    return { components: [success, choose, typeRow, skipRow] };
}

module.exports = { buildAddWatchSuccessResponse, createWatchFlow };
