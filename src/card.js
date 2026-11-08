// Notification "cards": a notification drawn as a Components V2 container instead of a classic embed. The card is built from
// the embed the notification would have had (author, text, fields, image, time), so both styles show the same content.
//
//   [ message line ]                   <- top-level text (role ping + the watch's message), outside the container
//   +- container (accent color) ----+
//   |  -# author . platform . type   |
//   |  post text                     |
//   |  ----------------------------  |
//   |  [ media gallery: 1-4 images ] |   or a small thumbnail beside the text
//   |  ----------------------------  |
//   |  -# <time>                     |
//   +--------------------------------+
//   [ link button ]

const {
    ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} = require('discord.js');

const MAX_IMAGES = 4;
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '\u2026' : String(s));
const text = s => new TextDisplayBuilder().setContent(clip(s, 3800));
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);

// embed: a built EmbedBuilder (or its data). opts.images: extra/all image URLs (a tweet's media); opts.small: show the first
// image as a thumbnail beside the text instead of a gallery; opts.noImage: no image at all.
function buildCard(embed, { images = [], small = false, noImage = false } = {}) {
    const d = embed?.data || embed || {};
    const urls = noImage ? [] : [...new Set((images.length ? images : [d.image?.url, d.thumbnail?.url]).filter(Boolean))].slice(0, MAX_IMAGES);
    const head = [d.author?.name ? `-# ${d.author.name}` : null, d.description].filter(Boolean).join('\n');
    const fields = (d.fields || []).map(f => `**${f.name}:** ${f.value}`).join('\n');
    const ts = d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : null;
    const foot = ts && Number.isFinite(ts) ? `-# <t:${ts}:R>` : null;

    const box = new ContainerBuilder();
    if (typeof d.color === 'number') box.setAccentColor(d.color);
    else if (typeof d.color === 'string') box.setAccentColor(parseInt(d.color.replace('#', ''), 16));
    let first = true;
    const gap = () => { if (!first) box.addSeparatorComponents(divider()); first = false; };

    const body = [head, fields].filter(Boolean).join('\n\n') || '\u200b';
    gap();
    if (small && urls.length) {
        box.addSectionComponents(new SectionBuilder().addTextDisplayComponents(text(body)).setThumbnailAccessory(new ThumbnailBuilder().setURL(urls[0])));
    } else {
        box.addTextDisplayComponents(text(body));
    }
    if (!small && urls.length) {
        gap();
        const gallery = new MediaGalleryBuilder();
        for (const u of urls) gallery.addItems(new MediaGalleryItemBuilder().setURL(u));
        box.addMediaGalleryComponents(gallery);
    }
    if (foot) { gap(); box.addTextDisplayComponents(text(foot)); }
    return box;
}

module.exports = { MAX_IMAGES, buildCard };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
