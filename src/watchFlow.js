// Shared watch-creation flow used by /social add and /setup.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { E, normalizeHandle } = require('./helpers.js');
const { addWatch, getSocialLinkByUsername, getWatches, setWatchSocialLink, updateLastPost } = require('./db.js');
const { fetchLatestInstagramAll, fetchLatestTikTokAll } = require('./platforms/social.js');
const { fetchLatestTwitchAll } = require('./platforms/twitch.js');
const { fetchLatestKickAll } = require('./platforms/kick.js');
const { fetchLatestPost } = require('./platforms/index.js');
const { fetchLatestYouTubeEntries } = require('./platforms/youtube.js');
const { PLACEHOLDER_HELP } = require('./notify.js');

// ── Shared watch-creation flow ──────────────────────────────────────────────
// Used by both /social add and the /setup wizard so there's exactly one place
// that validates a platform+handle+channel and creates the watch — no risk of
// the two entry points drifting apart. Returns { ok: true, watch, post } or
// { ok: false, message } (message is already a user-facing ❌ reply string).
async function createWatchFlow(guildId, platform, rawHandle, channelId, addedByTag, bypassUnavailable = false) {
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
    let baselineSeenIds = [];
    let fetchedOk = false; // a fetch really succeeded (even if it found nothing yet)
    let socialLinkId = null;
    if (PLATFORMS[platform].oauth) {
        // Instagram/TikTok can only be watched for accounts that have gone through
        // /social link — there's no way to poll an arbitrary public account via
        // their official APIs without that account's consent.
        const link = await getSocialLinkByUsername(guildId, platform, handle);
        if (!link) {
            return { ok: false, message: `❌ **${handle}** hasn't been linked yet. That account needs to run \`/social link\` and authorize with ${PLATFORMS[platform].label} first — this bot can't watch ${PLATFORMS[platform].label} accounts that haven't consented.\nUse \`/social links\` to see what's already linked in this server.` };
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
            if (platform === 'twitch') {
                const posts = await fetchLatestTwitchAll(handle);
                post = posts[0] || null;
                baselineSeenIds = posts.map(p => p.id);
            } else if (platform === 'kick') {
                const posts = await fetchLatestKickAll(handle);
                post = posts[0] || null;
                baselineSeenIds = posts.map(p => p.id);
            } else if (platform === 'youtube') {
                // fetchLatestPost() has no YouTube case — it's handled separately via
                // the Data API + playlist-ID cache (fetchLatestYouTubeEntries), which
                // needs a real watch.id to cache the resolved channel/playlist IDs
                // against. Deferred until after addWatch() below, once we have one.
            } else {
                post = await fetchLatestPost(platform, handle);
                baselineSeenIds = post?.id ? [post.id] : [];
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

    const watch = await addWatch({ guildId, platform, handle, channelId, addedBy: addedByTag });
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
    return { ok: true, watch, post, handle };
}

// Builds the same "Now Tracking" + next-step (type picker or message-set button)
// response used right after a watch is created, regardless of whether it came
// from /social add or the /setup wizard.
function buildAddWatchSuccessResponse(watch, post, handle, channel) {
    const p = PLATFORMS[watch.platform];
    const types = PLATFORM_NOTIFY_TYPES[watch.platform];
    const successEmbed = E('#00ff00', 'Now Tracking').addFields(
        { name: 'Platform', value: `${p.emojiTag} ${p.label}`, inline: true },
        { name: 'Account', value: handle, inline: true },
        { name: 'Channel', value: `${channel}`, inline: true },
        post?.title
            ? { name: 'Latest post (baseline)', value: `[${post.title.slice(0, 100)}](${post.url})` }
            : { name: 'Baseline', value: 'No posts found yet — will track from first post.' },
    );

    // Single-type platforms (TikTok, Twitter) skip the type-choice step entirely —
    // there's only one kind of post, so go straight to a "set your message" button.
    if (types.length <= 1) {
        successEmbed.setDescription('One more step — set the notification message below.')
            .addFields({ name: 'Placeholders', value: PLACEHOLDER_HELP });
        const msgRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`socialpertype_open_${watch.id}_new`).setLabel('Set Message').setStyle(ButtonStyle.Primary)
        );
        return { embeds: [successEmbed], components: [msgRow] };
    }

    // Multi-type platforms: choose notification types first — selecting (or skipping)
    // chains straight into the per-type message form, so this is a single guided path
    // instead of separate optional buttons.
    const typeEmbed = new EmbedBuilder().setColor('#5865F2')
        .setTitle(`${p.emojiTag} Choose Notification Types`)
        .setDescription(`Which types of **${p.label}** content do you want notifications for?\nSelect one or more below — you'll set the message for each right after.`)
        .addFields({ name: 'Placeholders (for the message you set next)', value: PLACEHOLDER_HELP });
    const typeRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`socialtypeadd_select_${watch.id}`)
            .setPlaceholder('Select notification types…')
            .setMinValues(1).setMaxValues(types.length)
            .addOptions(types.map(t => ({ label: t.label, value: t.id, description: t.description })))
    );
    const skipRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`socialtypeadd_skip_${watch.id}`).setLabel('All types (skip)').setStyle(ButtonStyle.Secondary)
    );
    return { embeds: [successEmbed, typeEmbed], components: [typeRow, skipRow] };
}

module.exports = { buildAddWatchSuccessResponse, createWatchFlow };
