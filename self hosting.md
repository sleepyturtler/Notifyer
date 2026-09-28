# Self-hosting Notifyer

Notifyer is two separate bots, kept as `index.js` on two different branches of the same GitHub repo:

- `main` branch (release, stable) — YouTube, Twitch, Kick, Twitter/X
- `Beta` branch (beta, experimental) — adds Instagram and TikTok via OAuth, plus in-progress features

Each needs its own Discord bot application, its own Render (or other host) service, and its own Postgres database. They do not share state. If you only want a working bot with the core platforms, clone/checkout `main`. If you want to help test Instagram/TikTok/YouTube-API/batching, checkout `Beta` instead.

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
   (whichever branch you checked out — `main` for release, `Beta` for beta — since both are `index.js` in their own branch, not two differently-named files.)
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
| `BOT_OWNER_ID` | Your Discord user ID. Gates the owner-only debug commands (`/social debug`, `/social oauthdebug` on beta, `/killbot` on beta). Without it, those commands just refuse everyone. |
| `PORT` | The port the built-in HTTP server (health check, OAuth callbacks, legal pages) listens on. Defaults to `3000`, and most hosts (including Render) set this automatically. |

### Platform integrations (each independently optional; a platform with no credentials set just gets skipped when someone tries `/social add` for it)

| Variable | What it's for |
|---|---|
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Twitch API app credentials (dev.twitch.tv/console). Needed for Twitch live/VOD tracking. |
| `KICK_CLIENT_ID` / `KICK_CLIENT_SECRET` | Kick API app credentials. Needed for Kick live tracking. |
| `YOUTUBE_API_KEY` | Google Cloud Console API key with the YouTube Data API v3 enabled (beta build only). Needed for YouTube tracking; without it, YouTube watches can't resolve channel IDs or fetch uploads. |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | Meta app credentials (beta build only). Needed for Instagram OAuth linking. Meta app review is required before this works for anyone besides the app's own test users; see "Known limitations" below. |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok for Developers app credentials (beta build only). Needed for TikTok OAuth linking. TikTok app review is required the same way as Instagram. |
| `NITTER_INSTANCES` | Comma-separated list of Nitter mirror base URLs for Twitter/X tracking, since there's no free official API. Has a built-in default list if unset, but that list can go stale as mirrors disappear. If every configured mirror ever fails at once, the bot DMs `BOT_OWNER_ID` about it (rate-limited to once per 6 hours) rather than only failing silently in the logs. |

### Deployment/ops (all optional; the bot works without any of these)

| Variable | What it's for |
|---|---|
| `KEEP_ALIVE_URL` | If set, the bot pings its own `/health` endpoint on a timer to prevent host platforms (like Render's free tier) from idling it. Falls back to `RENDER_EXTERNAL_URL`. |
| `RENDER_API_KEY` / `RENDER_SERVICE_ID` | Lets the owner-only `/killbot` command (beta) actually suspend the Render service via Render's API, instead of just crashing the process (which most hosts auto-restart anyway). Only relevant if you're on Render. |
| `LEGAL_CONTACT_EMAIL` | Shown on the `/terms` and `/privacy` pages as a contact point. Falls back to `BOT_OWNER_DISCORD_TAG`, then a generic "contact the bot owner" line. |
| `BOT_OWNER_DISCORD_TAG` | Displayed in a couple of places (legal pages, owner-command descriptions) as a human-readable fallback when `LEGAL_CONTACT_EMAIL` isn't set. |
| `TIKTOK_VERIFY_FILENAME` / `TIKTOK_VERIFY_CONTENT` | Only needed if TikTok's domain-verification file (for app review) needs to change; both have working defaults baked in already. |

## Known limitations for self-hosters

- **Instagram and TikTok need your own app review, every time.** These aren't bot-wide credentials; if you self-host, you register your own Meta and TikTok developer apps and go through their review process before OAuth linking works for anyone but your own test accounts. This can take days to weeks and is the single biggest hurdle to a fully working self-hosted beta build.
- **Twitter/X tracking depends on public Nitter mirrors staying alive.** There's no official free API. If the whole `NITTER_INSTANCES` list goes down at once, Twitter tracking silently stops working until you update it with fresh mirrors.
- **The release and beta builds are separate, unsynced bots.** A bug fixed in one doesn't automatically apply to the other; they're maintained as two files by design right now (see "Where the code could be improved" below for a way to change that).
