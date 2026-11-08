// Message templating, notification payloads, native-video embed fallback, sendNotification, stream-offline edits.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { URL } = require('url');
const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextDisplayBuilder } = require('discord.js');
const { PLATFORMS, PLATFORM_NOTIFY_TYPES, activeTypeIds } = require('./config.js');
const { reportDeliveryFailure } = require('./announcements.js');
const { profileUrl, watchName } = require('./helpers.js');
const { fetchJson } = require('./net.js');
const { client } = require('./client.js');
const { getConfig, setWatchLiveMessage, setWatchLiveState } = require('./db.js');
const { buildCard } = require('./card.js');

// ── Message templating ────────────────────────────────────────────────────
const DEFAULT_TEMPLATE = '🔔 **{author}** just posted on {platform}!\n{url}';

// Nicer default specifically for live-stream notifications — uses the {is/was} token
// (see renderTemplate) so the same wording works for both "went live" and "ended".
const LIVE_DEFAULT_TEMPLATE = '🔴 **{author}** {is/was} live on {platform}!\n{url}';

// Shown wherever someone's about to set a custom message, so new users don't have to
// dig through /help to discover these — Discord modals can't show static text inside
// the form itself, so this goes on the embed screen right before the modal opens.
const PLACEHOLDER_HELP = '`{author}` `{handle}` `{platform}` `{title}` `{url}` — for Live, also `{is/was}` (is/was live) and `{category}`';

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
        .replace(/\{url\}/g, () => post.url || '')
        .replace(/\{category\}/g, () => post.category || '');
}

function shouldNotify(w, post) {
    if (!post.postType) return true;
    // No saved selection = every type except those a platform marks defaultOff (Bluesky replies/reposts).
    return activeTypeIds(w).includes(post.postType);
}

// ── Post-type → button label map (used instead of a generic "View post") ───
const POST_TYPE_BUTTON_LABEL = {
    youtube:   { videos: 'Watch Video', shorts: 'Watch Short', live: 'Watch Live' },
    twitter:   { posts: 'View Tweet', replies: 'View Reply', reposts: 'View Repost' },
    rss:       { posts: 'Read More' },
    bluesky:   { posts: 'View Post', replies: 'View Reply', reposts: 'View Repost' },
    twitch:    { live: 'Join Stream', vods: 'Watch VOD' },
    kick:      { live: 'Join Stream', vods: 'Watch VOD' },
    instagram: { posts: 'View Post', reels: 'Watch Reel', stories: 'View Story' },
    tiktok:    { videos: 'Watch TikTok' },
};

// After a stream ends its button stops saying "Join Stream": it becomes the platform's VOD / video label.
function endedButtonLabel(platform) {
    const l = POST_TYPE_BUTTON_LABEL[platform];
    return l?.vods || l?.videos || null;
}

function buttonLabelFor(platform, post) {
    if (post.isLive) return POST_TYPE_BUTTON_LABEL[platform]?.live || 'Join Stream';
    return POST_TYPE_BUTTON_LABEL[platform]?.[post.postType] || 'View Post';
}

// Builds a fake-but-realistic post for /social preview — one per notify type so
// people can check every custom message variant, not just whichever type happens
// to post next in reality.
// Only the customizer shows an image, so that its image-size option has something to resize.
// Shorts, Reels and TikToks are vertical videos, so their preview image is vertical (9:16) too.
const PREVIEW_IMAGE_URL = 'https://placehold.co/640x360/png?text=Post+image';
const PREVIEW_IMAGE_URL_2 = 'https://placehold.co/640x360/png?text=Image+2';
const PREVIEW_VERTICAL_IMAGE_URL = 'https://placehold.co/360x640/png?text=Post+image';
const isShortForm = (platform, postType) => postType === 'shorts' || postType === 'reels' || postType === 'stories' || platform === 'tiktok';
function buildSamplePost(w, postType, { withImage = false } = {}) {
    return {
        id: 'preview',
        url: profileUrl(w.platform, w.handle) || 'https://example.com',
        title: 'Sample post title for preview',
        author: watchName(w),
        thumbnail: withImage ? (isShortForm(w.platform, postType) ? PREVIEW_VERTICAL_IMAGE_URL : PREVIEW_IMAGE_URL) : null,
        // a tweet can carry several images, which a card shows as a gallery
        ...(withImage && w.platform === 'twitter' ? { images: [PREVIEW_IMAGE_URL, PREVIEW_IMAGE_URL_2] } : {}),
        timestamp: new Date().toISOString(),
        postType,
        isLive: postType === 'live',
        category: postType === 'live' && (w.platform === 'twitch' || w.platform === 'kick') ? 'Just Chatting' : null,
    };
}

// The /setup preview: a made-up YouTube channel and video shown as a real embed. It is built from constants only, so
// nothing is fetched (no YouTube call, no database) and nothing links to a real channel or video. A genuine YouTube
// notification is just a link that Discord unfurls itself, which can't be shown in a preview, so this is an embed.
function buildOnboardingPreview() {
    const p = PLATFORMS.youtube;
    const fakeUrl = 'https://www.youtube.com/';
    const embed = new EmbedBuilder()
        .setColor(p.color)
        .setAuthor({ name: `Sample Creator • ${p.label}` })
        .setTitle('I built my own Discord bot (full tutorial)')
        .setURL(fakeUrl)
        .setDescription('This is a made-up channel and video. A real notification looks like this, and arrives in the channel you pick as soon as the creator posts.')
        .addFields(
            { name: 'Channel', value: '@samplecreator', inline: true },
            { name: 'Type', value: 'New video', inline: true },
        )
        .setFooter({ text: 'Preview only. Nothing was fetched or posted.' })
        .setTimestamp(new Date());
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('Watch Video').setStyle(ButtonStyle.Link).setURL(fakeUrl));
    return { content: '**Preview** of a notification in your channel:', embeds: [embed], components: [row] };
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
            .setTimestamp(safeDate(post.timestamp));
        if (oembed?.thumbnail) fallback.setImage(oembed.thumbnail);
        // The backup is a Components V2 card. Turning the plain message into one means moving its text into the card's message line
        // (the link shown there is the real TikTok URL, not the mirror) and clearing the old content; the link button stays. An edit
        // pings nobody, so the role ping already sent with the first message is not repeated.
        const line = (msg.content || '').split(embeddableUrl('tiktok', post.url)).join(post.url);
        const card = buildCard(fallback, { images: oembed?.thumbnail ? [oembed.thumbnail] : [] });
        await msg.edit({
            content: null, embeds: [], flags: [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] },
            components: [new TextDisplayBuilder().setContent(line || '\u200b'), card, ...(msg.components || [])],
        }).catch(e => console.error('embed fallback edit:', e.message));
    } catch (e) {
        console.error('ensureVideoEmbedFallback:', e.message);
    }
}

// Discord refuses a message over 2000 characters, and the post is already marked seen by then, so an over-long custom
// template would silently lose the notification. Keep the start (role ping, text) and, for native-video links, the URL.
const MAX_CONTENT = 2000;
function clampContent(content, url = null) {
    if (content.length <= MAX_CONTENT) return content;
    if (url && content.endsWith(url)) return content.slice(0, MAX_CONTENT - url.length - 1) + '…' + url;
    const cut = content.slice(0, MAX_CONTENT - 1) + '…';
    return url && !cut.includes(url) ? content.slice(0, MAX_CONTENT - url.length - 2) + '…\n' + url : cut;
}

// A feed or poster can send any string as a date (Bluesky's is set by the poster's client), and an unparseable one makes
// the embed builder throw, which would lose the notification. Fall back to "now".
const HEX_RE = /^#[0-9a-f]{6}$/i;

function safeDate(v) {
    const d = v ? new Date(v) : null;
    return d && Number.isFinite(d.getTime()) ? d : new Date();
}

// How a notification is drawn: a Components V2 "card" (see card.js) or a classic embed. A watch can pick either in the
// customizer. Without a choice every platform the bot draws itself is a card: Twitter/X, Bluesky, RSS, Instagram, and the Twitch
// and Kick live and VOD posts. YouTube and TikTok are not drawn by the bot at all: the message is a link that Discord unfurls
// (and plays) by itself, so they stay that way unless a watch chooses "Style: Card" (a thumbnail and a link button, no inline
// player). TikTok's backup embed is a card, see below. CARD_DEFAULT=false makes every default a classic embed again.
function defaultStyle(platform) {
    if (process.env.CARD_DEFAULT === 'false') return 'embed';
    return NATIVE_VIDEO_PLATFORMS.has(platform) ? 'embed' : 'card';
}
const styleOf = (w, post, es) => (es.style === 'card' || es.style === 'embed' ? es.style : defaultStyle(w.platform));
// The watch's own look on top of the server's default look (set in the customizer), field by field.
const lookOf = w => ({ ...(w.default_look || {}), ...(w.embed_settings || {}) });
// The ping role for one post: the role chosen for its type, else the watch's default role.
const roleFor = (w, post) => (post && w.type_roles?.[post.postType]) || w.role_id || null;

// Builds the exact {content, embeds, components} a notification would use, without
// sending anything \u2014 shared by sendNotification and /social customize so they can
// never drift out of sync with each other. A card comes back as { v2: true, components } with no content or embeds.
function buildNotificationPayload(w, post) {
    const p = PLATFORMS[w.platform];
    const typeLabel = post.postType ? ` (${PLATFORM_NOTIFY_TYPES[w.platform]?.find(t => t.id === post.postType)?.label || post.postType})` : '';
    let content = renderTemplate(resolveTemplate(w, post), post, w.platform, watchName(w));
    const es = lookOf(w);
    const style = styleOf(w, post, es);
    // For YouTube/TikTok in the embed style, make sure a URL that Discord will actually unfurl into a
    // playable video is present on its own line (not just inside a custom embed).
    const wantsNativeVideo = NATIVE_VIDEO_PLATFORMS.has(w.platform) && post.url && style === 'embed';
    let embedUrl = null;
    if (wantsNativeVideo) {
        embedUrl = embeddableUrl(w.platform, post.url);
        content = content.includes(post.url) ? content.split(post.url).join(embedUrl) : `${content}\n${embedUrl}`;
    }
    const postText = [post.title, post.summary].filter(Boolean).join('\n\n');
    const textInMessage = es.text === 'message' && !wantsNativeVideo && Boolean(postText);
    if (textInMessage) content = `${content}\n\n${postText}`;
    const role = roleFor(w, post);
    if (role) content = `<@&${role}> ${content}`;
    content = clampContent(content, embedUrl);
    const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(buttonLabelFor(w.platform, post)).setStyle(ButtonStyle.Link).setURL(post.url).setEmoji(p.emojiButton)
    );
    if (wantsNativeVideo) {
        // Discord's native video unfurl (from the raw URL above) already shows the title,
        // thumbnail, and channel/author \u2014 a custom embed on top of that is redundant.
        // Embed turned off in the customizer: the same message, but the link is not unfurled (SuppressEmbeds, see sendNotification).
        if (es.embed === false) return { content, embeds: [], components: [linkRow], wantsNativeVideo: false, suppressEmbeds: true, embedUrl };
        return { content, embeds: [], components: [linkRow], wantsNativeVideo: true, embedUrl };
    }
    if (es.embed === false) return { content, embeds: [], components: [linkRow], wantsNativeVideo: false, suppressEmbeds: NATIVE_VIDEO_PLATFORMS.has(w.platform), embedUrl: null };
    const embed = new EmbedBuilder()
        .setColor(HEX_RE.test(es.color || '') ? es.color : p.color) // live streams use the platform's own color too (Twitch purple, Kick green)
        .setAuthor({ name: `${post.author || watchName(w)} \u2022 ${p.label}${typeLabel}`.slice(0, 256) })
        .setURL(post.url)
        .setDescription(textInMessage ? null : (postText.slice(0, 4000) || null))
        .setTimestamp(safeDate(post.timestamp));
    if (post.isLive) embed.addFields({ name: '🔴 LIVE', value: 'Stream is live now!', inline: true });
    if (post.isLive && post.category) embed.addFields({ name: 'Category', value: String(post.category).slice(0, 1024), inline: true });
    if (style === 'card') {
        const card = buildCard(embed, { images: post.images || (post.thumbnail ? [post.thumbnail] : []), small: es.image === 'small', noImage: es.image === 'none' });
        return { content, embeds: [], components: [new TextDisplayBuilder().setContent(content), card, linkRow], v2: true, wantsNativeVideo: false, embedUrl: null };
    }
    if (post.thumbnail && es.image !== 'none') (es.image === 'small' ? embed.setThumbnail(post.thumbnail) : embed.setImage(post.thumbnail));
    return { content, embeds: [embed], components: [linkRow], wantsNativeVideo: false, embedUrl: null };
}

// Shared by every place that needs to resolve a watch's target channel — sending
// a notification, editing a batch message, or updating a live-status message.
function resolveWatchChannel(w) {
    const guild = client.guilds.cache.get(w.guild_id);
    return { guild, channel: guild?.channels.cache.get(w.channel_id) };
}

// Only the watch's own ping role may notify; see the allowedMentions default in client.js.
const pingRoles = (w, post) => ({ roles: roleFor(w, post) ? [roleFor(w, post)] : [] });

async function sendNotification(w, post) {
    const { guild, channel } = resolveWatchChannel(w);
    if (!channel) { reportDeliveryFailure(w, 'missing_channel'); return null; }
    const look = (await getConfig(w.guild_id).catch(() => null))?.defaultLook; // the server's default look, if it set one
    const payload = buildNotificationPayload(look ? { ...w, default_look: look } : w, post);
    if (payload.v2) {
        return channel.send({ components: payload.components, flags: [MessageFlags.IsComponentsV2], allowedMentions: pingRoles(w, post) })
            .catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); return null; });
    }
    const noUnfurl = payload.suppressEmbeds ? { flags: [MessageFlags.SuppressEmbeds] } : {};
    if (payload.wantsNativeVideo) {
        const sent = await channel.send({ content: payload.content, components: payload.components, allowedMentions: pingRoles(w, post) }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); reportDeliveryFailure(w, e); return null; });
        // Discord's crawler occasionally fails to unfurl TikTok links even via the mirror
        // domain — check back shortly and backfill a manual embed if nothing showed up.
        if (sent && w.platform === 'tiktok') ensureVideoEmbedFallback(channel, sent.id, post);
        return sent;
    }
    return channel.send({ content: payload.content, embeds: payload.embeds, components: payload.components, allowedMentions: pingRoles(w, post), ...noUnfurl }).catch(e => { console.error(`send notification (${guild.name}/#${channel.name}, watch ${w.id}):`, e.message); reportDeliveryFailure(w, e); return null; });
}

// \u2500\u2500 Live streams: edits while live, summary when it ends \u2500\u2500
// A watch's current stream is remembered in watches.live_state: { startedAt, title, category, peak, savedAt, editedAt }.
// While the stream is live, a changed title or category edits the "went live" message in place (an edit never pings), at most once
// per 30 s. The peak viewer count is the highest one seen while polling, so it is approximate; it is kept in memory and saved
// at most every 2 minutes. When the stream ends, the ended message shows the duration and the peak.
const livePeaks = new Map(); // watch id -> highest viewer count seen
const LIVE_EDIT_MIN_MS = 30 * 1000;
const LIVE_SAVE_MIN_MS = 2 * 60 * 1000;

function formatDuration(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'under a minute';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
}

async function startLiveState(w, post) {
    livePeaks.set(w.id, post.viewers || 0);
    const now = Date.now();
    const state = { startedAt: post.timestamp || new Date(now).toISOString(), title: post.title || null, category: post.category || null, peak: post.viewers || 0, savedAt: now, editedAt: now };
    await setWatchLiveState(w.id, state).catch(e => console.error(`startLiveState (${w.id}):`, e.message));
    return state;
}

// Returns true when the message was edited, false when there was nothing to edit (message gone), null when it cannot be edited.
async function editLiveMessage(w, post) {
    const { channel } = resolveWatchChannel(w);
    const msg = channel ? await channel.messages.fetch(w.live_message_id).catch(() => null) : null;
    if (!msg) return false;
    const look = (await getConfig(w.guild_id).catch(() => null))?.defaultLook;
    const payload = buildNotificationPayload(look ? { ...w, default_look: look } : w, post);
    const msgIsV2 = Boolean(msg.flags?.has?.(MessageFlags.IsComponentsV2));
    if (Boolean(payload.v2) !== msgIsV2) return null; // the look changed kind since it was posted; Discord cannot convert a message
    const edit = payload.v2
        ? { components: payload.components, flags: [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] } }
        : { content: payload.content, embeds: payload.embeds, components: payload.components, allowedMentions: { parse: [] } };
    await msg.edit(edit).catch(e => { console.error(`edit live message (${w.id}):`, e.message); throw e; });
    return true;
}

// Called on every poll while the watch is live. Cheap when nothing changed: no Discord or database call.
async function updateLiveMessage(w, post) {
    if (!w.live_message_id || !post?.isLive) return;
    const st = w.live_state || {};
    const peak = Math.max(livePeaks.get(w.id) ?? st.peak ?? 0, post.viewers || 0);
    livePeaks.set(w.id, peak);
    const now = Date.now();
    const title = post.title || null, category = post.category || null;
    const changed = title !== (st.title ?? null) || category !== (st.category ?? null);
    const next = { ...st, startedAt: st.startedAt || post.timestamp || new Date(now).toISOString(), peak };
    try {
        if (changed) {
            if (now - (st.editedAt || 0) < LIVE_EDIT_MIN_MS) return; // too soon after the last edit: try again next poll
            if (await editLiveMessage(w, post) === null) return;
            Object.assign(next, { title, category, editedAt: now, savedAt: now });
        } else if (peak > (st.peak || 0) && now - (st.savedAt || 0) >= LIVE_SAVE_MIN_MS) {
            next.savedAt = now;
        } else {
            return;
        }
        w.live_state = next;
        await setWatchLiveState(w.id, next);
    } catch (e) {
        console.error(`updateLiveMessage (${w.id}):`, e.message);
    }
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
            // Reconstruct a minimal post-like object so the person\'s own custom "live"
            // message (with {is/was}) renders here too, instead of a hardcoded string.
            const syntheticPost = { author: w.handle, url: profileUrl(w.platform, w.handle), title: null, postType: 'live' };
            let content = renderTemplate(resolveTemplate(w, syntheticPost), syntheticPost, w.platform, w.handle, true);
            const endedEmbed = new EmbedBuilder()
                .setColor(p.color) // stays the platform's color (Twitch purple, Kick green); the text and button say it ended
                .setAuthor({ name: `${w.handle} \u2022 ${p.label}` })
                .setDescription('Stream ended.')
                .setTimestamp();
            // How long it lasted and how many people watched at the most (from the polls; approximate).
            const st = w.live_state || {};
            const started = st.startedAt ? new Date(st.startedAt).getTime() : NaN;
            const peak = Math.max(livePeaks.get(w.id) || 0, st.peak || 0);
            if (Number.isFinite(started) && Date.now() > started) endedEmbed.addFields({ name: 'Duration', value: formatDuration(Date.now() - started), inline: true });
            if (peak > 0) endedEmbed.addFields({ name: 'Peak viewers', value: peak.toLocaleString('en-US'), inline: true });
            // Same link, relabelled (the channel page is where past broadcasts live). Left as it was if there is no link button.
            let components = msg.components;
            const label = endedButtonLabel(w.platform);
            const old = label ? (msg.components || []).flatMap(r => r.components || []).find(c => c.url) : null;
            if (old) {
                const btn = new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(old.url);
                if (old.emoji) btn.setEmoji(old.emoji);
                components = [new ActionRowBuilder().addComponents(btn)];
            }
            const msgIsV2 = Boolean(msg.flags?.has?.(MessageFlags.IsComponentsV2));
            const edit = msgIsV2
                ? { components: [new TextDisplayBuilder().setContent(content || '\u200b'), buildCard(endedEmbed), ...(components || [])], flags: [MessageFlags.IsComponentsV2], allowedMentions: { parse: [] } }
                : { content, embeds: [endedEmbed], components, allowedMentions: { parse: [] } };
            await msg.edit(edit).catch(e => console.error(`edit live-ended message (${w.id}):`, e.message));
        }
    } catch (e) {
        console.error(`markStreamOffline (${w.id}):`, e.message);
    } finally {
        livePeaks.delete(w.id);
        await setWatchLiveMessage(w.id, null);
        await setWatchLiveState(w.id, null).catch(() => {});
    }
}

module.exports = { NATIVE_VIDEO_PLATFORMS, PLACEHOLDER_HELP, defaultStyle, embeddableUrl, formatDuration, lookOf, roleFor, styleOf, startLiveState, updateLiveMessage, clampContent, safeDate, buildNotificationPayload, buildOnboardingPreview, buildSamplePost, buttonLabelFor, endedButtonLabel, markStreamOffline, resolveWatchChannel, sendNotification, shouldNotify };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
