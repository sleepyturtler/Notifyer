// RSS presets: pick a source and type one value instead of hunting for the feed URL. Every preset only builds a URL, which then goes
// through the same guarded fetch and checks as a URL typed by hand (safeFetch.js), so a preset cannot reach anything a URL could not.
// The slash command takes the same thing as a shorthand in the handle: reddit:node, github:owner/repo, steam:730 ...

const PRESETS = [
    { id: 'reddit', label: 'Reddit subreddit', ask: 'Subreddit name', example: 'node', pattern: /^(?:r\/)?([A-Za-z0-9_]{2,21})$/, url: m => `https://www.reddit.com/r/${m[1]}/.rss` },
    { id: 'reddituser', label: 'Reddit user', ask: 'Reddit username', example: 'spez', pattern: /^(?:u\/)?([A-Za-z0-9_-]{3,20})$/, url: m => `https://www.reddit.com/user/${m[1]}/.rss` },
    { id: 'github', label: 'GitHub releases', ask: 'Repository, owner/name', example: 'nodejs/node', pattern: /^([\w.-]+\/[\w.-]+)$/, url: m => `https://github.com/${m[1]}/releases.atom` },
    { id: 'githubcommits', label: 'GitHub commits', ask: 'Repository, owner/name', example: 'nodejs/node', pattern: /^([\w.-]+\/[\w.-]+)$/, url: m => `https://github.com/${m[1]}/commits.atom` },
    { id: 'steam', label: 'Steam game news', ask: 'Steam app ID (the number in the store URL)', example: '730', pattern: /^(\d{1,9})$/, url: m => `https://store.steampowered.com/feeds/news/app/${m[1]}/` },
    { id: 'mastodon', label: 'Mastodon user', ask: 'Account, like @user@mastodon.social', example: '@Gargron@mastodon.social', pattern: /^@?([\w.-]+)@((?:[a-z0-9-]+\.)+[a-z]{2,})$/i, url: m => `https://${m[2].toLowerCase()}/@${m[1]}.rss` },
    { id: 'substack', label: 'Substack', ask: 'Publication name (the part before .substack.com)', example: 'astralcodexten', pattern: /^([a-z0-9-]{2,63})$/i, url: m => `https://${m[1].toLowerCase()}.substack.com/feed` },
    { id: 'medium', label: 'Medium', ask: 'Writer (@name) or publication name', example: '@username', pattern: /^(@?[\w.-]{2,60})$/, url: m => `https://medium.com/feed/${m[1]}` },
    { id: 'hn', label: 'Hacker News', ask: 'Minimum points', example: '100', pattern: /^(\d{1,4})$/, url: m => `https://hnrss.org/newest?points=${m[1]}` },
    { id: 'pypi', label: 'PyPI releases', ask: 'Package name', example: 'requests', pattern: /^([A-Za-z0-9][A-Za-z0-9._-]*)$/, url: m => `https://pypi.org/rss/project/${m[1]}/releases.xml` },
];
const BY_ID = new Map(PRESETS.map(p => [p.id, p]));

// -> { ok: true, url } or { ok: false, message }
function expandPreset(id, value) {
    const p = BY_ID.get(id);
    if (!p) return { ok: false, message: '\u274c Unknown RSS preset.' };
    const v = String(value || '').trim();
    const m = v.includes('..') ? null : p.pattern.exec(v); // no ".." anywhere: nothing can climb out of the built path
    if (!m) return { ok: false, message: `\u274c That is not a valid value for ${p.label}. Example: \`${p.example}\`` };
    return { ok: true, url: p.url(m) };
}

// "reddit:node" -> expandPreset('reddit', 'node'); anything that is not preset:value (a URL, a plain name) -> null
function parseShorthand(input) {
    const m = /^([a-z]+):(.+)$/i.exec(String(input || '').trim());
    if (!m || !BY_ID.has(m[1].toLowerCase())) return null;
    return expandPreset(m[1].toLowerCase(), m[2]);
}

module.exports = { PRESETS, expandPreset, parseShorthand };

// build-marker: ui-v3 (check-requires.js reports any file missing this, i.e. an older copy pasted next to newer ones)
