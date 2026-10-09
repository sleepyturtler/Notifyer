// Message templating, notification payloads, native-video embed fallback, sendNotification, stream-offline edits.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { URL } = require('url');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES } = require('./config.js');
const { reportDeliveryFailure } = require('./announcements.js');
const { profileUrl } = require('./helpers.js');
const { fetchJson } = require('./net.js');
const { client } = require('./client.js');
const { setWatchLiveMessage } = require('./db.js');

// ── Message templating ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE = '🔔 **{author}** just posted on {platform}!\n{url}';

// Nicer default specifically for live-stream notifications — uses the {is/was} token
// (see renderTemplate) so the same wording works for both "went live" and "ended".
const LIVE_DEFAULT_TEMPLATE = '🔴 **{author}** {is/was} live on {platform}!\n{url}';

// Shown wherever someone's about to set a custom message, so new users don't have to
// dig through /help to discover these — Discord modals can't show static text inside
// the form itself, so this goes on the embed screen right before the modal opens.
const PLACEHOLDER_HELP = '`{author}` `{handle}` `{platform}` `{title}` `{url}` — for Live, also `{is/was}` (is/was live)';

// Resolves the message template for a watch + post, preferring a per-post-type
// override (w.message_templates[post.postType]) over the watch's single
// message_template, over the global default.
function resolveTemplate(w, post) {
    if (post.postType && w.message_templates && w.message_templates[post.postType]) return w.message_templates[post.postType];
    return w.message_template || null;
}

// `ended` flips the {is/was} token — pass true when editing a "went live" notification
// to say the stream ended, false (default) for the original live/normal notification.
function renderTemplate(template, post, platform, handle, ended = false) {
    const tmpl = template || (post.postType === 'live' ? LIVE_DEFAULT_TEMPLATE : DEFAULT_TEMPLATE);
    // Function replacers: a plain replacement string would interpret "$&", "$'" and "$$"
    // inside titles/names (e.g. "Make $$ fast" would lose a dollar sign).
    return tmpl
        .replace(/\{is\/was\}/g, () => (ended ? 'was' : 'is'))
        .replace(/\{author\}/g, () => post.author || handle)
        .replace(/\{handle\}/g, () => handle)
        .replace(/\{platform\}/g, () => PLATFORMS[platform].label)
        .replace(/\{title\}/g, () => post.title || '')
        .replace(/\{url\}/g, () => post.url || '');
}

function shouldNotify(w, post) {
    const types = Array.isArray(w.notify_types) && w.notify_types.length ? w.notify_types : null;
    if (!types) return true; // no filter = all types
    return post.postType ? types.includes(post.postType) : true;
}

// ── Post-type → button label map (used instead of a generic "View post") ───
const POST_TYPE_BUTTON_LABEL = {
    youtube:   { videos: 'Watch Video', shorts: 'Watch Short', live: 'Watch Live' },
    twitter:   { posts: 'View Tweet' },
    twitch:    { live: 'Join Stream', vods: 'Watch VOD' },
    kick:      { live: 'Join Stream' },
    instagram: { posts: 'View Post', reels: 'Watch Reel', stories: 'View Story' },
    tiktok:    { videos: 'Watch TikTok' },
};

function buttonLabelFor(platform, post) {
    if (post.isLive) return POST_TYPE_BUTTON_LABEL[platform]?.live || 'Join Stream';
    return POST_TYPE_BUTTON_LABEL[platform]?.[post.postType] || 'View Post';
}

// Builds a fake-but-realistic post for /social preview — one per notify type so
// people can check every custom message variant, not just whichever type happens
// to post next in reality.
function buildSamplePost(w, postType) {
    return {
        id: 'preview',
        url: profileUrl(w.platform, w.handle) || 'https://example.com',
        title: 'Sample post title for preview',
        author: w.handle,
        thumbnail: null,
        timestamp: new Date().toISOString(),
        postType,
        isLive: postType === 'live',
    };
}

// Platforms where Discord will render a native, playable video preview if the
// raw URL appears in the message content (not just inside a custom embed).
const NATIVE_VIDEO_PLATFORMS = new Set(['youtube', 'tiktok']);

// Discord's own crawler frequently fails to unfurl tiktok.com links — missing
// thumbnails, or sometimes no embed at all — especially with the official API's
// share_url, which has per-request utm_* tracking params attached (so the same
// video's URL is never quite identical twice, defeating Discord's unfurl cache).
// tnktok.com (fxTikTok) is a well-known Discord-embed-fixer mirror that reliably
// produces a playable video card. We only use it for the auto-unfurled URL in the
// message body — the "Watch TikTok" button below still links to the real tiktok.com
// URL, so people always land on TikTok itself when they click through.
function embeddableUrl(platform, url) {
    if (platform !== 'tiktok' || !url) return url;
    try {
        const u = new URL(url);
        u.hostname = u.hostname.replace(/(^|\.)tiktok\.com$/i, '$1tnktok.com');
        u.search = ''; // tracking params vary per fetch and aren't needed for the embed
        return u.toString();
    } catch {
        return url;
    }
}

// TikTok's public oEmbed endpoint — no auth needed, just the canonical video URL.
// Used only as a fallback when Discord's own crawler fails to unfurl the link.
async function fetchTikTokOEmbed(url) {
    const { status, json } = await fetchJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`);
    if (status !== 200 || !json) return null;
    return { title: json.title || null, thumbnail: json.thumbnail_url || null, author: json.author_name || null };
}

// Discord unfurls links asynchronously after the message is sent, and — even with the
// tnktok.com mirror trick above — sometimes just fails to attach an embed at all (crawler
// timeout, mirror hiccup, etc.), leaving a bare link with no visual. This checks back a few
// seconds later and, if nothing got attached, patches the message with a manual embed built
// from TikTok's own oEmbed API so there's always a visual card, playable or not.
async function ensureVideoEmbedFallback(channel, messageId, post) {
    await new Promise(r => setTimeout(r, 7000));
    try {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg) return; // message is gone — nothing to do
        // The message can have been retroactively converted into a Components V2
        // batch in the meantime (see sendOrExtendBatch) — that legitimately clears
        // embeds too (CV2 messages don't carry legacy embeds at all), which this
        // function used to misread as "the native embed never loaded" and would
        // then edit in a stray legacy embed on top of a CV2-flagged message. That's
        // what caused the embed to visibly disappear (the batch conversion, which
        // is correct) and then reappear wrong a few seconds later (this function
        // clobbering it). Bail out here instead — once it's part of a batch, this
        // fallback no longer applies to it.
        if (msg.flags?.has(MessageFlags.IsComponentsV2)) return;
        if (msg.embeds.length > 0) return; // unfurled fine — nothing to do
        const oembed = await fetchTikTokOEmbed(post.url).catch(() => null);
        const fallback = new EmbedBuilder()
            .setColor(PLATFORMS.tiktok.color)
            .setAuthor({ name: `${oembed?.author || post.author || ''} • TikTok`.replace(/^ • /, '') })
            .setURL(post.url)
            .setDescription(oembed?.title || post.title || null)
            .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
        if (oembed?.thumbnail) fallback.setImage(oembed.thumbnail);
        await msg.edit({ embeds: [fallback] }).catch(e => console.error('embed fallback edit:', e.message));
    } catch (e) {
        console.error('ensureVideoEmbedFallback:', e.message);
    }
}

// Builds the exact {content, embeds, components} a notification would use, without
// sending anything — shared by sendNotification and /social preview so they can
// never drift out of sync with each other.
function buildNotificationPayload(w, post) {
    const p = PLATFORMS[w.platform];
    const typeLabel = post.postType ? ` (${PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === post.postType)?.label || post.postType})` : '';
    let content = renderTemplate(resolveTemplate(w, post), post, w.platform, w.handle);
    // For YouTube/TikTok, make sure a URL that Discord will actually unfurl into a
    // playable video is present on its own line (not just inside a custom embed).
    const wantsNativeVideo = NATIVE_VIDEO_PLATFORMS.has(w.platform) && post.url;
    if (wantsNativeVideo) {
        const embedUrl = embeddableUrl(w.platform, post.url);
        content = content.includes(post.url) ? content.split(post.url).join(embedUrl) : `${content}\n${embedUrl}`;
    }
    if (w.role_id) content = `<@&${w.role_id}> ${content}`;
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(buttonLabelFor(w.platform, post)).setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(p.emojiButton)
    );
    if (wantsNativeVideo) {
        // Discord's native video unfurl (from the raw URL above) already shows the title,
        // thumbnail, and channel/author — a custom embed on top of that is redundant.
        return { content, embeds: [], components: [linkRow], wantsNativeVideo: true };
    }
    const embed = new EmbedBuilder()
        .setColor(post.isLive ? '#FF0000' : p.color)
        .setAuthor({ name: `${post.author || w.handle} • ${p.label}${typeLabel}` })
        .setURL(post.url)
        .setDescription(post.title || null)
        .setTimestamp(post.timestamp ? new Date(post.timestamp) : new Date());
    if (post.isLive) embed.addFields({ name: '🔴 LIVE', value: 'Stream is live now!', inline: true });
    if (post.thumbnail) embed.setImage(post.thumbnail);
    return { content, embeds: [embed], components: [linkRow], wantsNativeVideo: false };
}

// Shared by every place that needs to resolve a watch's target channel — sending
// a notification, editing a batch message, or updating a live-status message.
function resolveWatchChannel(w) {
    const guild = client.guilds.cache.get(w.guild_id);
    return { guild, channel: guild?.channels.cache.get(w.channel_id) };
}

// Only the watch's own ping role may notify; see the allowedMentions default in client.js.
const pingRoles = w => ({ roles: w.role_id ? [w.role_id] : [] });

async function sendNotification(w, post) {
    const { guild, channel } = resolveWatchChannel(w);
    if (!channel) { reportDeliveryFailure(w, 'missing_channel'); return null; }
    const payload = buildNotificationPayload(w, post);
    if (payload.wantsNativeVideo) {
        const sent = await channel.send({ content: payload.content, components: payload.components, allowedMentions: pingRoles(w) }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); reportDeliveryFailure(w, e); return null; });
        // Discord's crawler occasionally fails to unfurl TikTok links even via the mirror
        // domain — check back shortly and backfill a manual embed if nothing showed up.
        if (sent && w.platform === 'tiktok') ensureVideoEmbedFallback(channel, sent.id, post);
        return sent;
    }
    return channel.send({ content: payload.content, embeds: payload.embeds, components: payload.components, allowedMentions: pingRoles(w) }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); reportDeliveryFailure(w, e); return null; });
}

// Edits a previously-sent "went live" message to show the stream has ended, once a
// later poll finds the channel no longer live. Falls back to just clearing the tracked
// message ID if the message or channel can no longer be found (deleted, permissions, etc.).
async function markStreamOffline(w) {
    if (!w.live_message_id) return;
    try {
        const { channel } = resolveWatchChannel(w);
        const msg = channel ? await channel.messages.fetch(w.live_message_id).catch(() => null) : null;
        if (msg) {
            const p = PLATFORMS[w.platform];
            // Reconstruct a minimal post-like object so the person's own custom "live"
            // message (with {is/was}) renders here too, instead of a hardcoded string.
            const syntheticPost = { author: w.handle, url: profileUrl(w.platform, w.handle), title: null, postType: 'live' };
            const content = renderTemplate(resolveTemplate(w, syntheticPost), syntheticPost, w.platform, w.handle, true);
            const endedEmbed = new EmbedBuilder()
                .setColor('#808080')
                .setAuthor({ name: `${w.handle} • ${p.label}` })
                .setDescription('Stream ended.')
                .setTimestamp();
            await msg.edit({ content, embeds: [endedEmbed], components: msg.components })
                .catch(e => console.error(`edit live-ended message (${w.id}):`, e.message));
        }
    } catch (e) {
        console.error(`markStreamOffline (${w.id}):`, e.message);
    } finally {
        await setWatchLiveMessage(w.id, null);
    }
}

module.exports = { DEFAULT_TEMPLATE, PLACEHOLDER_HELP, buildNotificationPayload, buildSamplePost, buttonLabelFor, markStreamOffline, resolveWatchChannel, sendNotification, shouldNotify };
