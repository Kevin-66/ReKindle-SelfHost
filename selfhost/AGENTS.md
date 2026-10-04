# Self-hosting notes for agents

Read the root `AGENTS.md` for the Kindle/e-ink rules; this file covers the
self-hosted Docker version that lives in `selfhost/` (see `selfhost/README.md`).
It is kept separate on purpose: the owner wants as few edits to upstream files
as possible so `git merge upstream/main` stays clean.

## Ground rules

- Put new behaviour in `selfhost/` (server code, add-on scripts in `selfhost/site/`,
  build-time page edits in `selfhost/server/src/transform.js`). Only edit upstream
  files when there is no other way, and list the edit in `selfhost/README.md`.
- Page edits run on a copy during the Docker build (`selfhost/prepare.js`) and on the
  fly in local dev mode (`selfhost/server/src/static.js`). Both use `transform.js`.
- `selfhost/site/*` is copied over the site at build time (new pages such as
  `hackernews.html`, add-on scripts such as `js/rk-manga-sources.js`). New apps are
  added to the launcher by the `ICONS_FILTER` snippet in `transform.js`.
- Commit with explicit paths, never `git add -A`: the repo once lived in iCloud Drive,
  which created "name 2.ext" conflict copies that got committed. The folder is now
  `ReKindle.nosync` (iCloud skips it) and `.git/info/exclude` ignores `* 2*`.

## Upstream files that are changed (keep this list in sync with the README)

- `time.js` – automatic time-zone detection before the city prompt.
- `js/i18n.js`, `settings.html` – Canada (CA) no longer maps to French.
- `theme.js`, `settings.html`, `index.html`, `index_old.html` – dark mode re-enabled and
  fixed. The root AGENTS.md still says dark mode is disabled; that is out of date here.
  The fix: dark mode is ONLY the root `invert(1) hue-rotate(180deg)` filter. Do not also
  set dark colour variables or `color-scheme: dark` (both double-invert to invisible
  text); the root uses `min-height: 100%` and repeats the desktop pattern
  (`--rk-wallpaper`) so tall pages have no seam.

## Server gotchas

- `rk-backend.js` replaces the Firebase SDK. When swapping the `<script>` tag, the
  `integrity`/`crossorigin` attributes must be dropped or the browser refuses the file
  (this locked AirType, Docs, ePub, Chess, ... until fixed).
- The first `onAuthStateChanged` callback must wait for the session check AND for
  `js/i18n.js` to load real strings (`rekindleTranslations` starts as `{}`), or i18n
  overwrites "Guest Mode"/username labels after the callback.
- Static ETags are hashes of the served (transformed) content, not file mtimes.
- Raw i18n keys on screen ("MANGA.BTN.CONTINUE"): upstream often writes
  `window.t('key') || 'Text'`, but `window.t` returns the key itself until the language
  file has loaded, so the fallback never shows. `fixTranslationFallbacks()` in
  `transform.js` rewrites these to `window.t('key', 'Text')` in every page and script
  (25 places in 2026-10: Manga, Comics, ...). Write new code the same way.
- `netguard.js`: upstream proxies (`/api/proxy`, reader worker, ...) may only reach public
  addresses, redirects included. 198.18.0.0/15 is allowed on purpose (fake-IP DNS from
  sing-box/Clash). Our own modules use `rawFetch`.
- archive.today (archive.ph/.is/.today/...) silently drops connections from the Netcup
  server AND from Cloudflare WARP (tested 2026-10; Cloudflare's DNS also gets a dead
  address for it on purpose), so the article reader could not open archive links.
  `netguard.js` sends `PROXY_DOMAINS` (default: archive.today's domains) through
  `PROXY_URL`, an HTTP proxy on another machine (`http://user:pass@host:port`; keep it
  in the deployment's secret variables, never in the repo). Proxied
  requests get a current Chrome User-Agent: archive.today answers the reader's
  Chrome/120 string with a CAPTCHA (HTTP 429). The owner wants the archive link
  itself, not a Wayback/original-site substitute.
- `cache.js` provides `caches.default` for upstream functions (Reddit got HTTP 429 without
  it), keeps the last good `/api` response, and serves it for 2 minutes after a 429.
- Deno (used for local testing) has its own `caches` and `localStorage` globals and does
  not treat `.js` as CommonJS by default; Node in Docker behaves normally. Babel errors
  in a Deno build come from Deno's package layout; run the build after `npm ci`.

## Reddit

`/api/reddit` is `selfhost/server/src/reddit.js`; upstream `functions/api/reddit.js` is
skipped (`SKIPPED_FUNCTIONS` in `workers-host.js`). Why, found 2026-10:

- old.reddit.com redirects logged-out requests to `/login/?reason=lor2` (upstream tried it
  first for every feed: ~1 s and a 320 KB login page wasted per request).
- i.redd.it / preview.redd.it answer page-load headers (`Accept: text/html`,
  `Sec-Fetch-Dest: document`, which upstream sends) with a 307 to an HTML viewer, so every
  proxied image was broken. Fetch images with an image `Accept` header. A missing
  i.redd.it file is a 404 whose body is a placeholder PNG: check the status, not the type.
- `preview.redd.it/<id>.<ext>?width=...&s=...` is signed (changing params gives 403), but
  `i.redd.it/<id>.<ext>` serves the original for the same id (also for gallery
  thumbnails); video thumbnails have no original, so fall back to the preview URL.
- Reddit RSS for logged-out clients: `x-ratelimit-remaining: 0.0` after ONE request,
  `x-ratelimit-reset` ~60 s. `fetchFeed()` serialises requests, waits up to 15 s for the
  window, otherwise returns 429 + `Retry-After`; `reddit.html` honours Retry-After (max 60 s,
  3 attempts) and shows its own "rate limiting" banner. Don't turn 429s into 200 notices
  (`redditNotice` is only for 5xx), or the app stops retrying.
- `www.reddit.com/*.json` answered "blocked by network security" (403 HTML) from a
  datacenter address while RSS worked. The `/svc/shreddit/...` HTML partials that the
  current website uses (`community-more-posts/hot/?name=<sub>`,
  `comments/r/<sub>/t3_<id>`) did answer, if feeds ever have to be scraped.
- In a feed entry with a thumbnail, Reddit puts the thumbnail AND the post text
  (`<!-- SC_OFF --><div class="md">`) inside a `<table>`, and `reddit.html` deletes that
  table in thread view, so picture and text vanished. `showPostMedia()` moves them (plus
  a full-size picture link, which the app turns into an `<img>`) before the table.
- When RSS stops (2026-11-13), a failed `.rss` request (not 429/5xx) returns an empty Atom
  feed with `Cache-Control: no-store`, which makes the app fall back to `.json`.
  `workers-host.js` doesn't keep `no-store` responses as the "last good" copy.

Redlib was tried and dropped (too slow, and it got 429s from Reddit too).

## Page buttons (`selfhost/site/js/rk-pager.js`)

`transform.js` adds the script before the last `</body>` of every upstream page. Pages in
`selfhost/site/` are copied after the transforms (prepare.js) and served untransformed in
dev, so they include `<script src="js/rk-pager.js"></script>` themselves (hackernews.html). It finds the
largest visible element with `overflow-y: auto|scroll` that really scrolls (or the
document itself) and puts two 52 px buttons (Page Up / Page Down) in that element's
bottom-right corner, positioned with `offsetTop/Left` (safe under theme.js zoom).
A page step is the visible height minus an overlap larger than the buttons, so nothing
stays hidden under them. It shows nothing when nothing scrolls (games), re-checks
after DOM changes (throttled to 1.5 s) and clicks, and does no work at all when
switched off. The switch is injected into Settings > Accessibility ("Page Buttons",
`localStorage.rk_page_buttons = '0'` means off). Pages should not add page bars of
their own (Hacker News had one; removed in favour of this). Disabled buttons must stay
opaque (grey arrow), or the page shows through them.

## Hacker News (`selfhost/site/hackernews.html`)

- Screens are stacked `.pane` divs inside the one scroller `#content`: going forward
  hides the current pane and stores `scrollTop` in the history entry; Back removes the
  top pane and restores the scroll position without reloading. Each pane has its own
  request counter (`pane.seq`), and lookups inside a screen use `p.querySelector`
  (several panes can contain the same ids, e.g. two threads' `#read-btn`).
- `sanitize(html, base)` parses in `document.implementation.createHTMLDocument` (an
  inert document, so images are not downloaded while cleaning), resolves relative links
  and images against `base` (the article URL), uses `data-src` for lazy images, and
  sends pictures through `/__rk/img?url=` (`server/src/images.js`: 1080 px JPEG, first
  frame of animations, SVG passed through, non-images refused, public addresses only).
- The cleanup walk must follow the LIVE child list: unwrapping an unknown tag moves its
  children up, and a snapshot of the child list skipped them, leaving `onerror=` and
  `javascript:` links from article HTML in place (fixed 2026-10). SVG/MathML/noscript/
  template are dropped with their contents.

## Manga

`manga.html` is upstream's disabled MangaDex app, re-enabled at build time. Manhuagui
(port of the keiyoushi extension) and preloading live in `selfhost/site/js/rk-manga-sources.js`,
which wraps `loadStore`, `openReader`, `loadChapter` and `updateMangaPage`.
