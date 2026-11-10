// RSS presets: pick a source and type one value instead of hunting for the feed URL. Every preset only builds a URL, which then goes
// through the same guarded fetch and checks as a URL typed by hand (safeFetch.js), so a preset cannot reach anything a URL could not.
// The picker in the add flow offers these, and the slash-free shorthand reddit:r/node, github:owner/repo, steam:730 ... works anywhere
// an RSS address is accepted (feedDiscovery.js).

const SKIP_GITHUB = new Set(['orgs', 'topics', 'marketplace', 'settings', 'sponsors', 'features', 'pricing', 'about', 'login', 'explore', 'collections', 'trending', 'search']);

// Each build() takes what the person typed and returns the feed URL, or null if it is not a valid value for that source.
const PRESETS = [
    {
        id: 'reddit', label: 'Reddit', ask: 'Subreddit or user, like r/node or u/spez', example: 'r/node',
        build(v) {
            const m = /^\/?(?:https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/)?(?:(r|u|user)\/)?([A-Za-z0-9_-]{2,21})\/?$/i.exec(v);
            if (!m) return null;
            const kind = (m[1] || 'r').toLowerCase(), name = m[2];
            if (kind === 'r') return /^[A-Za-z0-9_]{2,21}$/.test(name) ? `https://www.reddit.com/r/${name}/.rss` : null; // a bare name is a subreddit
            return /^[A-Za-z0-9_-]{3,20}$/.test(name) ? `https://www.reddit.com/user/${name}/.rss` : null;
        },
    },
    { id: 'github', label: 'GitHub releases', ask: 'Repository, like owner/repo', example: 'nodejs/node', build: v => githubRepo(v, 'releases.atom') },
    { id: 'githubcommits', label: 'GitHub commits', ask: 'Repository, like owner/repo', example: 'nodejs/node', build: v => githubRepo(v, 'commits.atom') },
    { id: 'steam', label: 'Steam game news', ask: 'Steam app ID (the number in the store URL)', example: '730', build: v => (/^(\d{1,9})$/.test(v) ? `https://store.steampowered.com/feeds/news/app/${v}/` : null) },
    {
        id: 'mastodon', label: 'Mastodon user', ask: 'Account, like @user@mastodon.social', example: '@Gargron@mastodon.social',
        build(v) { const m = /^@?([\w.-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,})$/i.exec(v); return m ? `https://${m[2].toLowerCase()}/@${m[1]}.rss` : null; },
    },
    { id: 'substack', label: 'Substack', ask: 'Publication name (the part before .substack.com)', example: 'astralcodexten', build: v => (/^([a-z0-9-]{2,63})$/i.test(v) ? `https://${v.toLowerCase()}.substack.com/feed` : null) },
    { id: 'medium', label: 'Medium', ask: 'Writer (@name) or publication name', example: '@username', build: v => (/^@?[\w.-]{2,60}$/.test(v) ? `https://medium.com/feed/${v}` : null) },
    { id: 'hn', label: 'Hacker News', ask: 'Minimum points', example: '100', build: v => (/^\d{1,4}$/.test(v) ? `https://hnrss.org/newest?points=${v}` : null) },
    { id: 'pypi', label: 'PyPI releases', ask: 'Package name', example: 'requests', build: v => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? `https://pypi.org/rss/project/${v}/releases.xml` : null) },
];
// Older shorthands that still work.
const ALIASES = { reddituser: v => ({ preset: 'reddit', value: `u/${v.replace(/^\/?(?:u|user)\//i, '')}` }) }; // reddituser:spez
const BY_ID = new Map(PRESETS.map(p => [p.id, p]));

// owner/repo, github.com/owner/repo, or a full GitHub URL
function githubRepo(v, file) {
    const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(v);
    if (!m || SKIP_GITHUB.has(m[1].toLowerCase())) return null;
    return `https://github.com/${m[1]}/${m[2]}/${file}`;
}

// -> { ok: true, url } or { ok: false, message }
function expandPreset(id, value) {
    let v = String(value || '').trim();
    if (ALIASES[id]) { const a = ALIASES[id](v); if (a) { id = a.preset; v = a.value; } }
    const p = BY_ID.get(id);
    if (!p) return { ok: false, message: '\u274c Unknown RSS preset.' };
    const url = v.includes('..') ? null : p.build(v); // no ".." anywhere: nothing can climb out of the built path
    if (!url) return { ok: false, message: `\u274c That is not a valid value for ${p.label}. Example: \`${p.example}\`` };
    return { ok: true, url };
}

// "reddit:r/node" -> expandPreset('reddit', 'r/node'); anything that is not preset:value (a URL, a plain name) -> null
function parseShorthand(input) {
    const m = /^([a-z]+):(.+)$/i.exec(String(input || '').trim());
    const key = m && m[1].toLowerCase();
    if (!m || !(BY_ID.has(key) || ALIASES[key])) return null;
    return expandPreset(key, m[2]);
}

module.exports = { PRESETS, expandPreset, parseShorthand };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
