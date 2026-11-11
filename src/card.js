// Notification "cards": a notification drawn as a Components V2 container instead of a classic embed. The card is built from
// the embed the notification would have had (author, text, fields, image, time), so both styles show the same content.
//
//   [ message line ]                   <- top-level text (role ping + the watch's message), outside the container
//   +- container (accent color) ----+
//   |  -# author . platform . type   |
//   |  ----------------------------  |
//   |  post text                     |
//   |  ----------------------------  |
//   |  [ media gallery: 1-4 images ] |   or a small thumbnail beside the text
//   |  ----------------------------  |
//   |  -# image description (or time) |
//   +--------------------------------+
//   [ link button ]

const {
    ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} = require('discord.js');

const MAX_IMAGES = 4;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '\u2026' : String(s));
const text = s => new TextDisplayBuilder().setContent(clip(s, 3800));
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

// embed: a built EmbedBuilder (or its data). opts.images: extra/all image URLs (a tweet's media); opts.alts: the description of
// each image, in the same order; opts.small: show the first image as a thumbnail beside the text instead of a gallery;
// opts.noImage: no image at all. The small text at the bottom is the image's description when there is one (the time otherwise),
// and each image carries its description as alt text too.
function buildCard(embed, { images = [], alts = [], small = false, noImage = false } = {}) {
    const d = embed?.data || embed || {};
    const candidates = images.length ? images : [d.image?.url || d.image, d.thumbnail?.url || d.thumbnail];
    const items = [];
    candidates.forEach((u, i) => { if (typeof u === 'string' && u && !items.some(x => x.url === u) && !noImage && items.length < MAX_IMAGES) items.push({ url: u, alt: String(alts[i] || '').trim().slice(0, 1000) }); });
    const urls = items.map(x => x.url);
    const alt = items.map(x => x.alt).find(Boolean);
    const byline = d.author?.name ? `-# ${d.author.name}` : null; // author and platform: its own block, divided from the post
    const fields = (d.fields || []).map(f => `**${f.name}:** ${f.value}`).join('\n');
    const ts = d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : null;
    const foot = urls.length && alt ? `-# ${alt.replace(/\s+/g, ' ').slice(0, 300)}` : (ts && Number.isFinite(ts) ? `-# <t:${ts}:R>` : null);

    const box = new ContainerBuilder();
    if (typeof d.color === 'number') box.setAccentColor(d.color);
    else if (typeof d.color === 'string') box.setAccentColor(parseInt(d.color.replace('#', ''), 16));
    let first = true;
    const gap = () => { if (!first) box.addSeparatorComponents(divider()); first = false; };

    const body = [d.description, fields].filter(Boolean).join('\n\n') || null;
    if (small && urls.length) {
        // the small image sits beside the post text (or beside the byline when there is no text)
        if (byline && body) { gap(); box.addTextDisplayComponents(text(byline)); }
        gap();
        box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(body || byline || '\u200b')).setThumbnailAccessory((items[0].alt ? new ThumbnailBuilder().setURL(urls[0]).setDescription(items[0].alt) : new ThumbnailBuilder().setURL(urls[0]))));
    } else {
        if (byline) { gap(); box.addTextDisplayComponents(text(byline)); }
        if (body || !byline) { gap(); box.addTextDisplayComponents(text(body || '\u200b')); }
    }
    if (!small && urls.length) {
        gap();
        const gallery = new MediaGalleryBuilder();
        for (const it of items) gallery.addItems(it.alt ? new MediaGalleryItemBuilder().setURL(it.url).setDescription(it.alt) : new MediaGalleryItemBuilder().setURL(it.url));
        box.addMediaGalleryComponents(gallery);
    }
    if (foot) { gap(); box.addTextDisplayComponents(text(foot)); }
    return box;
}

module.exports = { MAX_IMAGES, buildCard };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
