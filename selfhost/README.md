# Self-hosted ReKindle

Runs ReKindle on your own server with Docker. A single container serves the site
and replaces everything the public rekindle.ink depends on:

| rekindle.ink uses | This server uses |
|---|---|
| Firebase Auth | Local accounts (username + password) |
| Firestore | SQLite document store with the same rules |
| Realtime Database | In-memory tree saved to SQLite, live updates by long-polling |
| Cloud Storage | Files on disk |
| Cloud Functions | The repo's `firebase-functions/index.js`, run unchanged |
| Cloudflare Workers / Pages Functions | The repo's `workers/` and `functions/api/`, run unchanged |
| Workers AI (handwriting) | Gemini, or any OpenAI-compatible vision model |

ReKindle+ apps (Mail, Quick ToDo, AirType, Files, Photo Frame, ...) are a paid feature
of rekindle.ink and stay locked for ordinary accounts (the admin account has them): this
server cannot sell subscriptions. A server's owner can unlock them for every account with
`PLUS_FOR_ALL=true`.

The **Manga** app, which upstream switched off, is back: MangaDex works as it did, and
Manhuagui (漫画柜) is added as a second source (a port of the
[keiyoushi](https://github.com/keiyoushi/extensions-source) Mihon extension).
Manhuagui needs an account on the server; pages are WebP, which the Kindle
experimental browser shows but very old devices may not. Both sources preload the next
pages and the next chapter. When you are signed in, your Manga library and reading
progress are kept with your account on the server, so they survive the Kindle clearing
its browser data and follow you to other devices. Pages are shown exactly as the
sources serve them, but are not kept in the browser cache: the Kindle erases the
browser's data (sign-in, Manga library) when it grows past 64 MB. The **MOBI** button
next to the chapter name downloads the chapter as a MOBI book for the Kindle's own
reader (made by Calibre in the Chromium service; JPEG and PNG pages unchanged, WebP as
high-quality JPEG). It takes a little while; the status line says when it's ready.

A **Hacker News** app is added (Top, New, Best, Ask, Show, Jobs, search, threads and a
simplified article view), using the public Hacker News search API.

The **Substack** app works again: Substack changed its subscriptions API (the feed was
empty), paid posts now load in full instead of the free preview, old publication
icons load, articles get a readable font and layout, and Substack's answers are kept
on the server for an hour so switching views is quick.

**Minesweeper**: hold a covered cell to flag it, without switching to FLAG mode.

**Notes** stay in sync when the same note is open on two devices: edits appear live
and are merged instead of overwriting each other. Notes show Markdown formatting, and
typing Markdown formats as you go (`# ` heading, `- ` list, `1. `, `> `, `---`,
`**bold**`, `*italic*`, `` `code` ``, `~~strike~~`); the download button saves `.md`.
A stopwatch in the editor (paused until tapped) times a writing session.

**Notes agent link for AI agents**: the **Agent** button in Notes shows a private link
per account. With it, an AI agent or script can list, search, read, add, edit and delete
your notes as Markdown, with no sign-in, so keep it private; **New link** replaces it.
Opening the link in a browser (or `GET` from an agent) shows the full instructions:

```bash
curl 'https://<server>/__rk/notes/agent/<key>/notes'
curl 'https://<server>/__rk/notes/agent/<key>/notes?q=shopping'
curl 'https://<server>/__rk/notes/agent/<key>/notes/<id>'
curl -X POST 'https://<server>/__rk/notes/agent/<key>/notes' -H 'Content-Type: text/markdown' --data-binary @note.md
curl -X PATCH 'https://<server>/__rk/notes/agent/<key>/notes/<id>' -H 'Content-Type: application/json' -d '{"append":"- milk"}'
curl -X DELETE 'https://<server>/__rk/notes/agent/<key>/notes/<id>'
```

Bodies are JSON `{"title", "markdown"}` (edits also take `"append"`) or the Markdown itself.
A new note without a title takes a leading `# Heading`, else its first line. Up to
256 KB per request; raw HTML in the Markdown is shown as text.

Settings such as Display Mode, Text Size and Page Buttons are kept with your account
and come back on any device, or after the Kindle clears its browser data, when you open
the home screen.

A **Z-Library** explorer is added under Lifestyle: popular books, title/author/ISBN
search, result pages, book metadata and up to 200 local saved bookmarks. To download,
paste your Z-Library sign-in cookie under **Account** (copied from a desktop browser
where you are signed in, like the Substack app's cookie). It is kept with your ReKindle
account; **Download** then has the Chromium service fetch the book with it. The
Kindle browser downloads only MOBI, AZW, PRC and TXT, so books in other formats (EPUB,
PDF, FB2, ...; AZW3 is kept as it is) become MOBI: a MOBI file of the same book if
Z-Library has one, otherwise Z-Library's own "Convert to MOBI", and if that fails
Calibre (`ebook-convert`, in the Chromium service's image). This runs in the background while the page shows the step;
when the file is ready the Kindle asks where to save it. Reading and sign-in still open on `https://z-lib.sk/`. Saved books are local to
the browser and are not downloaded files or synced account data. Public catalogue
requests are cached for five minutes. If Z-Library blocks the server or requires
verification, the explorer offers a direct link and a retry instead of empty results.
Z-Library runs a sandboxed Chromium browser with a private virtual display to let
its JavaScript verification complete. It connects directly (verified on Netcup)
and keeps a public browsing session warm for five minutes. The archive.today
`PROXY_URL` is separate; `ZLIBRARY_PROXY_URL` optionally sets a browser proxy.
No account cookies are copied into this session. Chromium runs in its own small
service, built from `Dockerfile.zlibrary-browser`, so the main image stays light:
Docker Compose starts it next to ReKindle, and on Zeabur it is a second service in
the same project (private network only, no domain). The server reaches it at
`ZLIBRARY_BROWSER_ENDPOINT` and both share `ZLIBRARY_BROWSER_TOKEN`. Set
`ZLIBRARY_BROWSER=false` to opt into the older HTTP-only loader (which Z-Library
currently challenges). Browser traffic is restricted to Z-Library and its assets.

**Reddit** is turned off for now and hidden from the launcher. Reddit no longer serves
servers: its feeds allow about one request a minute (and end on 2026-11-13), its JSON
API answers "blocked by network security", new API apps need Reddit's approval, and
old.reddit.com requires signing in through a reCAPTCHA that only works on reddit.com.

**Text size:** Settings > Accessibility > Text Size enlarges reading text (articles,
posts, comments, messages) in Hacker News, Wikipedia, Mail, Substack, Readwise,
Bluesky, Mastodon, Dictionary, Cookbook and more, without changing buttons or layout.
It is safer on Kindles than the display scale, which uses zoom.

**Page buttons:** every page that scrolls gets Page Up / Page Down buttons in the
corner of its scrolling area (most Kindles, including the Scribe, have no page-turn
keys). Turn them off in Settings > Accessibility > Page Buttons.

**Not included:** KindleChat, Topics, Neighbourhood, Suggestions, online multiplayer
games, Words Online, moderation tools and payments. They depend on ReKindle's central
community, so they are hidden from the launcher. Pass-and-play games on one device
still work.

## Credits and license

Based on [ReKindle](https://github.com/ReKindleOS/ReKindle) by Ukiyo
([rekindle.ink](https://rekindle.ink)). Like the original, this version is licensed under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (see `LICENSE.md`):
non-commercial use only, give credit, and share changes under the same license. The
changes are described in this file; new code lives in `selfhost/`, and the few original
files that are edited are listed under "Updating from the original ReKindle".

## Quick start

```bash
git clone https://github.com/Kevin-66/ReKindle-SelfHost.git
cd ReKindle-SelfHost
cp .env.example .env        # optional: edit settings
docker compose up -d --build
```

Open `http://<server>:8080` and create an account. **The first account becomes the
admin** (or set `ADMIN_USERNAME`).

On a Kindle or Kobo, open the same address in the browser and bookmark it. Older
devices are sent to the `/lite/` or `/legacy/` versions automatically.

Data (accounts, app data, uploads) lives in `selfhost/data/`. Back that folder up.

## Settings (`.env`)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8080` | Port on the host |
| `ADMIN_USERNAME` | first account | Admin account |
| `ALLOW_REGISTRATION` | `true` | Let new people sign up (first account always allowed) |
| `PLUS_FOR_ALL` | `false` | Unlock the ReKindle+ apps for every account |
| `TRUST_PROXY` | `true` | Read client IPs from `X-Forwarded-For` (behind a reverse proxy) |
| `MAX_UPLOAD_MB` | `100` | Largest upload |
| `GEMINI_API_KEY` | – | Oracle AI and handwriting recognition |
| `OCR_MODEL` | `gemini-flash-latest` | Model for handwriting recognition |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY` | – | Use an OpenAI-compatible API for handwriting instead |
| `GOOGLE_CLIENT_ID` | – | Your own Google sign-in for Tasks / Calendar / Contacts |
| `IMAGE_MAX_WIDTH` | `1080` | Width Hacker News pictures are scaled down to |
| `PROXY_URL` | – | HTTP proxy (`http://user:pass@host:port`) for sites that block this server |
| `PROXY_DOMAINS` | archive.today domains | Sites fetched through `PROXY_URL` (comma-separated) |
| `ZLIBRARY_BROWSER_ENDPOINT` | – | The Z-Library browser service, e.g. `http://zlibrary-browser:8091` (Compose) or `http://<service>.zeabur.internal:8091` (Zeabur) |
| `ZLIBRARY_BROWSER_TOKEN` | – | Shared secret between the server and the browser service (set the same value on both) |
| `ZLIBRARY_PROXY_URL` | – | Optional HTTP proxy for the Z-Library browser (set on the browser service); direct by default |
| `MANHUAGUI_URL` | `https://www.manhuagui.com` | Manhuagui mirror (`https://tw.manhuagui.com` for Traditional Chinese) |
| `MANHUAGUI_SHOW_R18` | `false` | Show Manhuagui titles marked R18 |
| `TMDB_API_KEY` | – | Watchlist |
| `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET` | – | Pinterest |

After changing `.env`: `docker compose up -d`.

### Google Tasks / Calendar / Contacts

Google only accepts ReKindle's own sign-in on rekindle.ink, so these need your own
OAuth client and an HTTPS address:

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Google Tasks,
   Google Calendar and People APIs.
2. Create an OAuth client ID of type **Web application**.
3. Add your site (e.g. `https://rekindle.example.com`) under *Authorized JavaScript origins*.
4. Under *Authorized redirect URIs* add, for each of `tasks`, `calendar`, `contacts` and
   `quicktodo`: `https://rekindle.example.com/<name>` and `https://rekindle.example.com/<name>.html`.
5. Put the client ID in `GOOGLE_CLIENT_ID`.

## HTTPS

Put a reverse proxy in front for HTTPS, for example Caddy:

```
rekindle.example.com {
    reverse_proxy localhost:8080
}
```

Long-polling requests stay open for up to 25 seconds; make sure the proxy timeout is
longer (nginx: `proxy_read_timeout 60s;`).

## Updating from the original ReKindle

The repo's own files are left alone; the self-hosting changes live in `selfhost/`,
`Dockerfile`, `docker-compose.yml`, `.env.example` and `.dockerignore`. Page edits
(swapping the Firebase SDK for `rk-backend.js`, hiding chat apps, pointing worker URLs
at this server) are applied to a copy while the image builds. To pull in new
upstream work:

```bash
git fetch upstream
git merge upstream/main
docker compose up -d --build
```

The only upstream files changed here are:

- `time.js` – automatic time-zone detection
- `js/i18n.js`, `settings.html` – Canada no longer defaults to French
- `theme.js`, `settings.html`, `index.html`, `index_old.html` – dark mode re-enabled
  and fixed (upstream switched it off as buggy on 2026-07-08)
The Manga app is re-enabled at build time and gets its Manhuagui source from
`site/js/rk-manga-sources.js`; `manga.html` itself is untouched.

## Security notes

- Services that fetch arbitrary web addresses for the pages (`/api/proxy`, the article
  reader, ...) cannot reach private or internal addresses, including through
  redirects, and never receive the browser's cookies.
- Mail, Manhuagui and server functions require a signed-in account.
- With a public address, set `ADMIN_USERNAME` (or create your account first) and
  consider `ALLOW_REGISTRATION=false` once everyone who needs an account has one.

## Development without Docker

Needs Node.js 24 or newer.

```bash
cd selfhost/server
npm install
npm start          # serves the repo directly on http://localhost:8080
```

In this mode the page edits are applied on the fly and the lite/legacy versions are
not built.

## How it fits together

- `client/rk-backend.js` – drop-in replacement for the Firebase compat SDK. Same
  `firebase` global; talks to `/__rk/*` on this server. Plain ES5 for old e-readers.
- `server/src/` – the Node server:
  - `auth.js`, `jwt.js` – accounts, sessions, ID tokens
  - `firestore.js`, `firestore-rules.js`, `fsvalues.js` – document store and its rules
  - `rtdb.js`, `rtdb-rules.js` – realtime database; evaluates `rtdb-rules.json` as-is
  - `storage.js` – file storage
  - `events.js` – change feed behind live listeners (long-polling)
  - `functions-host.js`, `admin-shim.js` – run `firebase-functions/index.js` with a
    local stand-in for `firebase-admin`
  - `workers-host.js`, `ai.js`, `netguard.js` – run the Cloudflare workers and `/api`
    functions, with outgoing requests limited to public addresses (and `PROXY_DOMAINS`
    sent through `PROXY_URL`)
  - `manhuagui.js` – Manhuagui source for the Manga app
  - `images.js` – picture shrinking for e-readers; `/__rk/img?url=` (Hacker News, Manga pages)
  - `cache.js` – Cache API stand-in for the upstream `/api` functions
  - `transform.js` – the page edits; `static.js` – serves the site
- `prepare.js` – applies the page edits to a copy of the repo before the build.
