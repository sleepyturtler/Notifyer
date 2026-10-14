# Self-hosting Notifyer

Notifyer is one codebase: `index.js` loads everything under `src/`. Every platform (YouTube, Twitter/X, Twitch, Kick, Instagram, TikTok) is built in, and each one switches on only if its credentials are set. A platform with missing credentials is switched off automatically, and the startup log says which and why, so you can start with just the core setup and add platforms later.

`src/debugTools.js` is an optional extra used for testing the bot (the owner-only `/killbot`, `/social debug` and `/social oauthdebug` commands, plus an Admin tab in `/help`). Delete that one file for a normal build; nothing else needs editing.

You need your own Discord bot application, your own Render (or other host) service, and your own Postgres database.

## Prerequisites

- Node.js 18 or newer
- A Postgres database (a free tier on Render, Supabase, Neon, or a local instance all work fine)
- A Discord bot application ([discord.com/developers/applications](https://discord.com/developers/applications)), with:
  - `applications.commands` and `bot` scopes enabled
  - Message Content is not required (the bot only reads slash commands and its own sent messages)
- Optionally, developer accounts with Twitch, Kick, Instagram, TikTok, and/or YouTube if you want those platforms enabled (see below, each is independently optional)

## Quick start

1. Clone the repo and install dependencies:
   ```
   npm install
   ```
2. Either run the interactive setup script (recommended for a first-time boot):
   ```
   node setup.js
   ```
   which walks through the required variables, lets you opt into each platform integration one at a time, and writes a `.env` file for you — or copy `.env.example` to `.env` yourself (or set the same variables in your host's dashboard) and fill in at least `DISCORD_TOKEN` and `DATABASE_URL`; everything else is optional and enables specific platforms or features.
3. Run it:
   ```
   node index.js
   ```
   (`index.js` is the only entry point; it loads the rest from `src/`.)
4. On boot, the bot logs a startup config summary showing which platform integrations are active versus disabled (and why, if a credential's missing) — check this first if something isn't working, before assuming it's a bug.
5. On first boot the bot also creates its own database tables automatically (`CREATE TABLE IF NOT EXISTS`) — there is no separate migration step to run.
6. Slash commands are registered globally on every boot, which can take up to an hour to show up in Discord the very first time. Per-server registration is instant on subsequent boots since Discord caches the command list after that.
7. Invite the bot to a server with the `bot` and `applications.commands` scopes and the permissions it needs (Send Messages, Embed Links, Use External Emojis if you've set custom platform emojis, Manage Roles only if you want it managing an access role for you). `setup.js` prints a ready-made invite link for you if it can decode your bot's client ID from the token.

## Environment variables

### Required

| Variable | What it's for |
|---|---|
| `DISCORD_TOKEN` | Your bot's token from the Discord Developer Portal. |
| `DATABASE_URL` | Postgres connection string. Standard `postgres://user:pass@host:port/dbname` format. |

### Strongly recommended

| Variable | What it's for |
|---|---|
| `PUBLIC_BASE_URL` | The public URL your bot is reachable at (e.g. `https://yourbot.onrender.com`). Needed for Instagram/TikTok OAuth callbacks and YouTube WebSub push subscriptions. Falls back to `RENDER_EXTERNAL_URL` if unset, which Render sets automatically on its own services. Without either, OAuth linking and WebSub push are silently disabled (routine polling still works). |
| `BOT_OWNER_ID` | Your Discord user ID. Gates the owner-only debug commands (`/social debug`, `/social oauthdebug`, `/killbot`), which only exist while `src/debugTools.js` is present. It is also who gets a DM if every Twitter mirror goes down at once. Without it, those commands refuse everyone. |
| `PORT` | The port the built-in HTTP server (health check, OAuth callbacks, legal pages) listens on. Defaults to `3000`, and most hosts (including Render) set this automatically. |

### Platform integrations (each independently optional; a platform with no credentials set just gets skipped when someone tries `/social add` for it)

| Variable | What it's for |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch API app credentials (dev.twitch.tv/console). Needed for Twitch live/VOD tracking. |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Kick API app credentials. Needed for Kick live tracking. |
| `YOUTUBE_API_KEY` | Google Cloud Console API key with the YouTube Data API v3 enabled. Needed for YouTube tracking; without it, YouTube watches can't resolve channel IDs or fetch uploads. |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Meta app credentials. Needed for Instagram OAuth linking. Meta app review is required before this works for anyone besides the app's own test users; see "Known limitations" below. |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok for Developers app credentials. Needed for TikTok OAuth linking. TikTok app review is required the same way as Instagram. |
| `NITTER_INSTANCES` | Comma-separated list of Nitter mirror base URLs for Twitter/X tracking, since there's no free official API. Has a built-in default list if unset, but that list can go stale as mirrors disappear. If every configured mirror ever fails at once, the bot DMs `BOT_OWNER_ID` about it (rate-limited to once per 6 hours) rather than only failing silently in the logs. |
| `DATABASE_SSL_VERIFY` | Set to `true` to make the bot verify the Postgres server's TLS certificate. Off by default because many managed databases use certificates a default CA bundle can't validate. |
| `WEBSUB_SECRET` | Optional. Secret used to sign and verify YouTube push notifications. If unset, a value derived from `DISCORD_TOKEN` is used, which works fine; set this only if you want a dedicated secret. |
| `ALLOW_BULK_ORPHAN_PURGE` | Optional safety override. When the bot starts, it deletes stored data for servers it is no longer in. If that would remove an unusually large share of your servers (more than 25%, and more than 5), it refuses and logs a warning, because that usually means a Discord or connection problem, not real removals. Set this to `true` for one restart if those servers really are gone. |

### Deployment/ops (all optional; the bot works without any of these)

| Variable | What it's for |
|---|---|
| `KEEP_ALIVE_URL` | If set, the bot pings its own `/health` endpoint on a timer to prevent host platforms (like Render's free tier) from idling it. Falls back to `RENDER_EXTERNAL_URL`. |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` | Lets the owner-only `/killbot` command (present only with `src/debugTools.js`) actually suspend the Render service via Render's API, instead of just crashing the process (which most hosts auto-restart anyway). Only relevant if you're on Render. |
| `LEGAL_CONTACT_EMAIL` | Shown on the `/terms` and `/privacy` pages as a contact point. Falls back to `BOT_OWNER_DISCORD_TAG`, then a generic "contact the bot owner" line. |
| `BOT_OWNER_DISCORD_TAG` | Displayed in a couple of places (legal pages, owner-command descriptions) as a human-readable fallback when `LEGAL_CONTACT_EMAIL` isn't set. |
| `TIKTOK_VERIFY_FILENAME` / `TIKTOK_VERIFY_CONTENT` | Only needed if TikTok's domain-verification file (for app review) needs to change; both have working defaults baked in already. |

## Known limitations for self-hosters

- **Instagram and TikTok need your own app review, every time.** These aren't bot-wide credentials; if you self-host, you register your own Meta and TikTok developer apps and go through their review process before OAuth linking works for anyone but your own test accounts. This can take days to weeks and is the single biggest hurdle to a fully working self-hosted setup. Both are optional: leave their credentials unset and the bot runs without them.
- **Twitter/X tracking depends on public Nitter mirrors staying alive.** There's no official free API. If the whole `NITTER_INSTANCES` list goes down at once, Twitter tracking silently stops working until you update it with fresh mirrors.
- **Updating means replacing the files.** Pull or copy in the newer version and restart. Database tables and slash commands update themselves on boot, so there is no migration step.
