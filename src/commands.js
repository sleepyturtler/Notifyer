// Clickable slash commands. Discord turns </name:id> into a link that runs the command, and the id only exists once the bot
// has registered its commands, so the ids are filled in at startup (setCommandIds). Until then, or if registration failed,
// every function here returns the text unchanged and commands stay as plain text.
//
// mentionCommands() recognizes the commands this bot really registered (/setup, /help, /invite, /social add, ...) in
// ordinary text, with or without backticks around them, and leaves everything else alone (a bare "/social", the "/was" in
// {is/was}, a command inside a longer code span).

const ids = new Map();      // root command name -> id
const names = new Set();    // mentionable full names: 'setup', 'social add', ...
let bareRe = null;

const SUBCOMMAND = 1, GROUP = 2; // Discord's option types

// `list` is whatever commands.set()/fetch() returned: a collection or array of commands with { id, name, options }.
function setCommandIds(list) {
    ids.clear(); names.clear();
    for (const cmd of (list && typeof list.values === 'function' ? [...list.values()] : list) || []) {
        if (!cmd?.id || !cmd.name) continue;
        ids.set(cmd.name, cmd.id);
        const subs = (cmd.options || []).filter(o => o.type === SUBCOMMAND || o.type === GROUP);
        if (!subs.length) { names.add(cmd.name); continue; }
        for (const o of subs) {
            if (o.type === SUBCOMMAND) names.add(`${cmd.name} ${o.name}`);
            else for (const s of (o.options || [])) if (s.type === SUBCOMMAND) names.add(`${cmd.name} ${o.name} ${s.name}`);
        }
    }
    const alt = [...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    bareRe = alt ? new RegExp(`(?<![\\w<:/.\`])/(${alt})(?![\\w-])`, 'g') : null;
}

const idOf = name => ids.get(String(name).split(' ')[0]);
const mention = name => `</${name}:${idOf(name)}>`;

// A single command as text: the clickable mention when its id is known, otherwise "/name".
function cmd(name) { return names.has(name) && idOf(name) ? mention(name) : `/${name}`; }

function mentionCommands(text) {
    if (!bareRe || typeof text !== 'string' || !text.includes('/')) return text;
    // `/social add`  (exactly one command in a code span): the backticks go, the mention stays
    const spans = new RegExp('`/(' + [...names].sort((a, b) => b.length - a.length).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')`', 'g');
    return text.replace(spans, (_, n) => mention(n)).replace(bareRe, (_, n) => mention(n));
}

// For the bot's own embeds (notices sent into channels and DMs): rewrites the description and field values in place.
function commandsIn(embed) {
    const d = embed?.data;
    if (!d || !bareRe) return embed;
    if (d.description) d.description = mentionCommands(d.description);
    for (const f of d.fields || []) f.value = mentionCommands(f.value);
    return embed;
}

module.exports = { cmd, commandsIn, mentionCommands, setCommandIds };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
