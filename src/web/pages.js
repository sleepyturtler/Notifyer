// Logo, legal pages, and the public status page HTML.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { client } = require('../client.js');

// Notifyer's bell-icon logo, inlined as base64 so the site doesn't depend on
// hosting a separate image file. One single constant used everywhere — the
// favicon, the on-page logo, and (kept in sync manually) TikTok's Basic Info
// app icon all need to be the exact same image, since app-review has flagged
// a mismatch before. Previously the favicon and on-page logo were two
// separately-exported PNGs of the same design at different resolutions
// (64x64 vs 128x128) — visually close but not the same file, which is
// exactly the kind of mismatch a reviewer (or their tooling) can catch.
// Browsers downscale this fine for the <link rel="icon"> use.
// Notifyer's logo, inlined as base64 so the site doesn't depend on hosting a
// separate image file. One single constant used for both the favicon and the
// on-page logo, so they can never drift out of sync (app review flagged a
// mismatch when these were two separate files). Swap this for the final
// exported brand asset when it's ready.
const NOTIFYER_LOGO_URI = 'data:image/png;base64,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';

function legalPage(title, bodyHtml) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Notifyer</title>
<link rel="icon" type="image/png" href="${NOTIFYER_LOGO_URI}">
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1a1a1a;} .brand{display:flex;align-items:center;gap:10px;margin-bottom:20px;} .brand img{width:36px;height:36px;border-radius:8px;} .brand span{font-weight:600;font-size:1.15em;} h1{margin-bottom:4px;} .updated{color:#666;font-size:0.9em;margin-top:0;} h2{margin-top:28px;} a{color:#5865F2;}</style>
</head><body><div class="brand"><img src="${NOTIFYER_LOGO_URI}" alt="Notifyer logo"><span>Notifyer</span></div>${bodyHtml}</body></html>`;
}

const LEGAL_LAST_UPDATED = 'August 29, 2026';

const LEGAL_CONTACT = process.env.LEGAL_CONTACT_EMAIL || process.env.BOT_OWNER_DISCORD_TAG || 'the bot owner via the support server';

const TERMS_HTML = legalPage('Terms of Service', `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>These Terms govern your use of the Notifyer Discord bot ("the Bot"). By adding the Bot to a server or using its commands, you agree to these Terms.</p>

<h2>What the Bot does</h2>
<p>The Bot watches accounts you configure on YouTube, Twitter/X, Twitch, Instagram, and TikTok, and posts a notification in a Discord channel you choose when those accounts publish new content. For Instagram and TikTok, this only works for accounts that have explicitly authorized the Bot via OAuth (<code>/social link</code>) — the Bot cannot and does not access those platforms' accounts without their consent.</p>

<h2>Acceptable use</h2>
<ul>
<li>You must comply with Discord's <a href="https://discord.com/terms">Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a> while using the Bot.</li>
<li>You must have the right to link any Instagram or TikTok account you connect via <code>/social link</code> — only link accounts you own or are authorized to manage.</li>
<li>Don't use the Bot to spam, harass, or send notifications to channels/servers without appropriate permission.</li>
<li>Don't attempt to abuse, overload, or reverse-engineer the Bot's infrastructure.</li>
</ul>

<h2>No warranty</h2>
<p>The Bot is provided "as is," without warranty of any kind. Notifications may be delayed, missed, or occasionally inaccurate, particularly where the Bot relies on unofficial or rate-limited data sources (e.g. Twitter). We don't guarantee uninterrupted availability.</p>

<h2>Limitation of liability</h2>
<p>To the maximum extent permitted by law, the Bot's operator is not liable for any indirect, incidental, or consequential damages arising from your use of, or inability to use, the Bot.</p>

<h2>Termination</h2>
<p>We may suspend or terminate the Bot's access to your server, or discontinue the Bot entirely, at any time. You can remove the Bot from your server at any time via Discord's server settings.</p>

<h2>Changes</h2>
<p>We may update these Terms from time to time. Continued use of the Bot after changes are posted constitutes acceptance of the revised Terms.</p>

<h2>Contact</h2>
<p>Questions about these Terms can be directed to ${LEGAL_CONTACT}.</p>
`);

const PRIVACY_HTML = legalPage('Privacy Policy', `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LEGAL_LAST_UPDATED}</p>
<p>This Privacy Policy explains what data the Notifyer Discord bot ("the Bot") collects and how it's used.</p>

<h2>Data we collect</h2>
<ul>
<li><b>Server configuration:</b> the Discord server (guild) ID, channel IDs, role IDs, and the account handles/URLs you choose to track, along with any custom notification message templates you set.</li>
<li><b>Discord identifiers:</b> the Discord user ID and username of whoever adds a watch or links an account, stored only to show who configured something.</li>
<li><b>OAuth tokens:</b> if you use <code>/social link</code> to connect an Instagram or TikTok account, we store the access token, refresh token, and the linked account's platform user ID/username, so the Bot can check that account for new posts on your behalf.</li>
<li><b>Post metadata:</b> IDs and timestamps of posts already seen, so the Bot doesn't re-notify for the same content.</li>
</ul>
<p>We do not collect message content from your Discord server beyond what's needed to operate slash commands, and we do not read or store the content of DMs.</p>

<h2>How we use data</h2>
<p>Data is used solely to operate the Bot's core function: checking tracked accounts on a schedule and posting notifications to the channel you specify. We do not sell data, use it for advertising, or share it with third parties except the platform APIs (Instagram/TikTok) strictly as needed to fetch posts from accounts you've linked.</p>

<h2>Data retention & deletion</h2>
<p>Watch configurations and linked accounts are retained until you remove them (<code>/social list</code> → Remove, or by revoking a link) or remove the Bot from your server. You can request deletion of any data tied to your server or Discord account by contacting ${LEGAL_CONTACT}.</p>

<h2>Third-party services</h2>
<p>The Bot communicates with Discord's API, and — where you've configured it — YouTube, Twitter/X, Twitch, Meta's Instagram Graph API, and TikTok's API. Each of those platforms has its own privacy policy governing data you share with them directly.</p>

<h2>Security</h2>
<p>OAuth tokens are stored in a private database and are not exposed through any Bot command or public endpoint. No storage method is 100% secure, but we take reasonable steps to protect stored data.</p>

<h2>Children's privacy</h2>
<p>The Bot is not directed at children under 13, consistent with Discord's own age requirements.</p>

<h2>Changes</h2>
<p>We may update this Privacy Policy from time to time. Material changes will be reflected by updating the "Last updated" date above.</p>

<h2>Contact</h2>
<p>Questions about this policy, or requests to access/delete your data, can be directed to ${LEGAL_CONTACT}.</p>
`);

function buildStatusHTML() {
    const isUp = client.isReady();
    const statusLine = isUp
        ? '<p class="updated">Status: <strong style="color:#3ba55d">● Online</strong></p>'
        : '<p class="updated" style="background:#f8d7da;color:#842029;padding:10px 14px;border-radius:6px;display:inline-block;">🔴 <strong>Bot is currently down</strong> — this page is still up, but the Discord connection is not. Check back shortly.</p>';
    return legalPage('Notifyer — Social Media Notifications for Discord', `
<h1>Notifyer</h1>
${statusLine}
<p style="font-size:1.1em;">Notifyer is a Discord bot that watches creators across YouTube, Twitter/X, Twitch, Kick, Instagram, and TikTok, and posts directly in a channel you choose the moment they upload, post, or go live.</p>

<h2>What it does</h2>
<ul>
<li><strong>Multi-platform tracking</strong> — follow accounts on YouTube, Twitter/X, Twitch, Kick, Instagram, and TikTok from one bot, each with its own channel and settings.</li>
<li><strong>Custom notification messages</strong> — write your own message per platform and per post type (video, short, live, VOD, reel, story, etc.), with placeholders like <code>{author}</code>, <code>{title}</code>, and <code>{url}</code> filled in automatically.</li>
<li><strong>Live stream tracking</strong> — a "went live" message updates itself in place once the stream ends, instead of posting a second message.</li>
<li><strong>Smart batching</strong> — if several posts land at once (one prolific account, or several tracked accounts posting in the same channel back to back), they're combined into a single tidy message instead of flooding the channel.</li>
<li><strong>Preview before it fires</strong> — see exactly what a notification will look like, styling and all, without waiting for a real post.</li>
<li><strong>Consent-based linking</strong> — Instagram and TikTok accounts connect through official OAuth (<code>/social link</code>); Notifyer only ever reads accounts that have explicitly authorized it.</li>
</ul>

<h2>How it works</h2>
<p>An admin invites Notifyer to a Discord server, then runs <code>/setup</code> for a guided walkthrough or <code>/social add</code> to track an account directly: pick a platform, paste a handle, choose a channel. Notifyer checks each tracked account on a short interval and posts automatically the moment something new goes up.</p>

<h2>Get started</h2>
<p>
<a href="https://top.gg/bot/1515779889737896006">Add Notifyer to your server</a> &nbsp;·&nbsp;
<a href="https://github.com/DaniBottoni/Notifyer/tree/main">Source on GitHub</a>
</p>

<h2>Legal</h2>
<p>
<a href="/terms">Terms of Service</a> &nbsp;·&nbsp;
<a href="/privacy">Privacy Policy</a>
</p>
`);
}

module.exports = { PRIVACY_HTML, TERMS_HTML, buildStatusHTML };
