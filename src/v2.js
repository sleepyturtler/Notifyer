// Components V2 helpers for the bot's own screens, in the same style as the batch messages: one accent-colored
// container whose sections are divided by separators, with buttons and menus outside it.
//
//   view(color, blocks, rows)   one container (blocks = text sections) + the rows under it
//   wrapInteraction()           makes any reply/update that carries V2 components valid without touching call sites:
//                               it sets the IsComponentsV2 flag (even when a call adds its own `flags`), turns a stray
//                               `content` line into a text line above the container (V2 messages can't hold content),
//                               and turns a content-only edit of a V2 message into a V2 text message.

const {
    ContainerBuilder, MessageFlags, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder,
} = require('discord.js');

const RED = 0xE74C3C, ORANGE = 0xE67E22, GREEN = 0x2ECC71;
const V2_TYPES = new Set([9, 10, 11, 12, 13, 14, 17]); // section, text, thumbnail, gallery, file, separator, container

const toInt = hex => parseInt(String(hex).replace('#', ''), 16);
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '\u2026' : String(s));
const text = s => new TextDisplayBuilder().setContent(clip(String(s), 3900));

function typeOf(c) { try { return (typeof c?.toJSON === 'function' ? c.toJSON() : c)?.type; } catch { return undefined; } }
const isV2Part = c => V2_TYPES.has(typeOf(c));

function box(color, blocks) {
    const c = new ContainerBuilder();
    if (color !== null && color !== undefined) c.setAccentColor(typeof color === 'string' ? toInt(color) : color);
    blocks.filter(Boolean).forEach((b, i) => {
        if (i) c.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
        c.addTextDisplayComponents(text(b));
    });
    return c;
}

const view = (color, blocks, rows = []) => ({ components: [box(color, blocks), ...rows] });

// V2 messages carry no content or embeds, so these two keys are always dropped from a converted payload.
function toV2Payload(payload, { alreadyV2 = false } = {}) {
    if (typeof payload === 'string' && alreadyV2) payload = { content: payload }; // editReply('text') on a V2 message
    if (!payload || typeof payload !== 'object') return payload;
    const parts = Array.isArray(payload.components) ? payload.components : [];
    const hasV2 = parts.some(isV2Part);
    const content = typeof payload.content === 'string' && payload.content ? payload.content : null;
    if (!hasV2 && !(alreadyV2 && !('files' in payload) && (content || 'embeds' in payload || 'content' in payload))) return payload;
    const { content: _c, embeds: _e, components: _p, ...rest } = payload;
    return { ...rest, flags: [].concat(payload.flags || [], MessageFlags.IsComponentsV2), components: [...(content ? [text(content)] : []), ...parts] };
}

function wrapInteraction(interaction) {
    if (!interaction || interaction.__v2wrapped) return interaction;
    interaction.__v2wrapped = true;
    const isV2 = () => Boolean(interaction.__v2 || interaction.message?.flags?.has?.(MessageFlags.IsComponentsV2));
    // A deferred reply that will turn out to be V2 has to be deferred with the V2 flag.
    if (typeof interaction.deferReply === 'function') {
        const origDefer = interaction.deferReply.bind(interaction);
        interaction.deferReply = (opts = {}, ...rest) => {
            if ([].concat(opts?.flags || []).includes(MessageFlags.IsComponentsV2)) interaction.__v2 = true;
            return origDefer(opts, ...rest);
        };
    }
    for (const m of ['reply', 'update', 'editReply', 'followUp']) {
        const orig = typeof interaction[m] === 'function' ? interaction[m].bind(interaction) : null;
        if (!orig) continue;
        interaction[m] = (payload, ...rest) => {
            const out = toV2Payload(payload, { alreadyV2: m === 'update' || m === 'editReply' ? isV2() : false });
            if (out !== payload && [].concat(out.flags || []).includes(MessageFlags.IsComponentsV2)) interaction.__v2 = true;
            return orig(out, ...rest);
        };
    }
    return interaction;
}

module.exports = { GREEN, ORANGE, RED, box, clip, toInt, toV2Payload, view, wrapInteraction, isV2Part };

// build-marker: ui-v3
