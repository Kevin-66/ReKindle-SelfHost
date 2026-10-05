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
- Tap highlight: Chromium paints a translucent box over any tapped clickable element,
  which e-ink shows as a flash (the Manga reader's invisible next-page area is the right
  70% of the screen, so that whole area flashed on every page turn). `transform.js`
  adds `html{-webkit-tap-highlight-color:rgba(0,0,0,0)}` to every page; pages in
  `selfhost/site/` set it themselves.
- Raw i18n keys on screen ("MANGA.BTN.CONTINUE"): upstream often writes
  `window.t('key') || 'Text'`, but `window.t` returns the key itself until the language
  file has loaded, so the fallback never shows. `fixTranslationFallbacks()` in
  `transform.js` rewrites these to `window.t('key', 'Text')` in every page and script
  (25 places in 2026-10: Manga, Comics, ...). Write new code the same way.
- `js/emoji-render.js` (`renderEmojis`, used by Substack and others) scans any text node
  with a character above U+2600, and Chinese text counts. It then swapped EVERY
  character found in `EMOJI_SVG_MAP` for an OpenMoji picture, and the map has about 60
  ordinary characters below U+2600 (`-` 002D, ©, ®, ™, arrows, ▶, □...). So "re-lending"
  in a paragraph that also had Chinese showed a black bar. `transformJs` now swaps a
  single character only if it is itself above U+2600; multi-character sequences
  (keycaps, ZWJ, FE0F) are unchanged.
- `netguard.js` drops `cf-*` headers (CF-Connecting-IP, ...) from requests that workers
  and `/api` functions send out, as Cloudflare's runtime does. `workers-host.js` adds
  `cf-connecting-ip` to each incoming worker request, and the Substack worker forwards
  all its headers; Substack's Cloudflare answered every such request with a 403 block
  page (2026-10-05), so the Substack app showed "Access Denied" with a valid cookie.
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

## Reddit (turned off)

The Reddit app is off (`PAUSED_APPS` in `transform.js`: hidden from the launcher,
`reddit.html` shows a notice) and `/api/reddit` is not served (`SKIPPED_FUNCTIONS`). An
RSS-based `server/src/reddit.js` existed until 2026-10-05; it is in git history. What
was found, in case it is revisited:

- Logged-out RSS: `x-ratelimit-remaining: 0.0` after ONE request (reset ~60 s) per
  address. RSS ends 2026-11-13; the public API in 2027-03; new API apps need approval
  (Responsible Builder Policy); Devvit cannot send data to outside servers.
- `www.reddit.com/*.json`: 403 "blocked by network security" from datacenter addresses
  (the Zeabur server, the owner's UK proxy) while RSS still answered.
- old.reddit.com redirects every logged-out request to `/login/?reason=lor2` from
  datacenter AND home addresses. The login page is the modern one with Google reCAPTCHA,
  which only works on reddit.com, so signing in through a ReKindle proxy cannot work; a
  proxy would need the owner's `reddit_session` cookie as a secret (account risk). The
  owner chose to turn Reddit off instead (and does not want Redlib: too slow).
- Image hosts (i.redd.it, preview.redd.it) answer browser page-load headers with a 307
  to an HTML viewer; fetch them with an image `Accept` header. `preview.redd.it/<id>`
  is signed, `i.redd.it/<id>` serves the original.
- The website's `/svc/shreddit/...` HTML partials answered from servers (200 requests per
  10 min): `community-more-posts/hot/?name=<sub>&after=base64(t3_id)` lists posts;
  `comments/r/<sub>/t3_<id>` has comments but not the post; full pages sit behind a JS
  challenge (don't solve it).

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

## Chinese text on the Kindle

The owner finds Chinese on the Kindle Scribe Colorsoft looks Japanese. Tried and
reverted (2026-10-05): wrapping Chinese runs in `<span lang="zh-Hans">` on every page
(`rk-cjk.js`) made no visible difference on the device. Don't retry `lang` labelling;
a fix would need a font the Kindle browser really has (or a web font), checked on the
device.

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

## Text Size (`selfhost/site/js/rk-textsize.js`, `selfhost/site/css/rk-text.css`)

Settings > Accessibility > Text Size (Small 0.9 / Normal 1 / Large 1.2 / Larger 1.45 /
Largest 1.75, `localStorage.rk_text_size`). It changes FONT SIZES only. Do not use CSS
`zoom` for this: the Kindle browser mishandles zoom (taps land in the wrong place, page
buttons and other controls break), which is why the user asked for text size instead of
the display scale.

- `transform.js` adds `TEXT_SIZE_HEAD` to every page's `<head>`: the stylesheet, plus a
  snippet that (only when the size is not Normal) sets `--rk-text`, `data-rk-text` and
  `data-rk-page` (the file name) on `<html>` before the page draws.
- `rk-text.css` multiplies each reading app's own size, e.g.
  `html[data-rk-text][data-rk-page="reddit"] .thread-body { font-size: calc(1.1rem * var(--rk-text)) }`.
  Scoping by page keeps generic class names (`.text`, `.post-content`) from leaking
  between apps, and Normal leaves the author's pages untouched. When adding an app, use
  its own base size and its narrowest reading container (children sized in `rem` do not
  follow a container's font-size).
- Not covered: RSS Reader and Newspaper articles (own A-/A+, key `rss_reader_font_size`),
  Bible (own size menu, `rekindle_scriptures_state.fz`), the book reader (epub.js iframe).
- `hackernews.html` uses `calc(<size> * var(--rk-text, 1))` in its own CSS and sets the
  variable itself (pages in `selfhost/site` are not transformed).

## Minesweeper long press (`selfhost/site/js/rk-minesweeper.js`)

`transform.js` adds the script to `minesweeper.html`. Holding a covered cell for 450 ms
flags or unflags it in either mode (the FLAG/DIG button is left alone); the click that
ends the hold is swallowed in the capture phase so it doesn't also dig. Pointer Events
on `#grid-container` (delegated, so re-rendered grids keep working); a move over 12 px
cancels. `contextmenu` is prevented: right-click flags on a computer, and a browser
long-press menu that fires before the timer flags once (the timer is cancelled). It
calls the page's own `toggleFlag()`, `saveGame()` and `startTimer()`.

## Substack (`substack.html`)

`transform.js` edits the page at build time (upstream file untouched):

- Substack's subscriptions API changed (2026-10): a signed-in
  `GET /api/v1/subscriptions` without `?tvOnly=` answers 400 `{"param":"tvOnly","msg":"Invalid
  value"}` (signed out it answers 401 first, so a fake cookie never shows this). With
  `?tvOnly=false` the owner's account got `subscriptions: []` and 7 `publications`, so the
  feed is now built from both lists (publications without a subscription entry become
  `{ publication_id, publication }`). The app only uses `sub.publication.*` fields.
- Publication addresses may be bare domains (`custom_domain_optional`), and `new URL()`
  threw on them, silently dropping that publication from the feed; `rkAbsUrl()` adds
  `https://`.
- Full articles: `fetchFullPost` asked the publication's own domain (e.g. sinocism.com),
  which does not know the reader's substack.com login and returns only the free preview
  of paid posts (1,300 of 16,700 words). It now tries `substack.com/api/v1/posts/by-id/<id>`
  first (answer `{ post: {...} }`), then the old domain-based requests.
- Images: old publications point at Heroku "bucketeer" S3 buckets that answer 403 (e.g.
  Noahpinion's logo); the same paths exist on `substack-post-media.s3.amazonaws.com`.
  `apiCall` rewrites them in the JSON text (`rkFixImages`). The page's fallback
  `rss_icon.png` does not exist in ReKindle; `rkNoIcon()` swaps in an outlined square
  once (clearing `onerror`, so a failing fallback can't loop).
- "Following" is the author's aggregation (15 newest posts from each publication, merged
  by date) and stays that way: the owner rejected a reworked timeline. Only its bug is
  fixed: the next batch started at post 50 (`subOffset += 50`), skipping posts 16-50.
- `workers-host.js` caches the Substack relay's successful JSON answers for 1 hour
  (`WORKER_CACHE_MS`), keyed by path, query, `X-Substack-Target` and a hash of the cookie,
  because the app re-requests every publication each time a view opens. The Refresh
  button therefore shows answers up to an hour old (owner's choice).
- The cookie is sent exactly as pasted. The owner asked NOT to add parsing of a whole
  Cookie line; the settings text says to copy only the `substack.sid` value.
- Article view font and formatting: `selfhost/site/css/rk-substack.css` (Georgia, heading
  sizes, quotes/callouts/captions, Substack's expand/restack buttons and subscribe
  widgets hidden). Everything is in `em`, so Text Size still applies.
- Debugging: the page hides failed requests behind "No posts found." Temporary logging
  of each worker request's path, status and error message in `handleWorker` found the
  `tvOnly` 400 (removed afterwards at the owner's request; add it back locally when
  needed). Don't use the owner's Substack cookie yourself; ask them to run requests
  (they did, with a Terminal one-liner that hid the cookie).

## Manga

`manga.html` is upstream's disabled MangaDex app, re-enabled at build time. Its title uses the
i18n key `manga.title`, which upstream now translates as "Comics" (for its separate
Internet Archive app, `comics.html`); `transform.js` drops that `data-i18n` so the title
stays "Manga" and the two apps can be told apart. Manhuagui
(port of the keiyoushi extension) and preloading live in `selfhost/site/js/rk-manga-sources.js`,
which wraps `loadStore`, `openReader`, `loadChapter` and `updateMangaPage`.

- Chapter picker: the chapter drop-down (site-wide custom select, 200 px max-height) is
  hidden by CSS and replaced by `#rk-ch-btn`, which opens `#rk-ch-panel` over
  `#reader-view` down to the bottom of the window. It reads its entries from the hidden
  `<select id="chapter-select">`, which stays the source of truth for manga.html.
  Manhuagui titles with both 回/话 and 卷 (单行本) get two columns (`VOLUME_RE`).
- Manhuagui's genre and sort drop-downs use the same `CustomSelect` widget as the
  MangaDex row (created in `buildControls`; the widget's MutationObserver shows the
  options `loadFilters()` adds later). They were plain native selects before.
- Source switch: two 48 px buttons (`.rk-source-btn`) drive a hidden
  `#rk-source-select`. Async store loads must check `currentSource()` before writing
  results, or a slow reply from the other source overwrites the list.
- Variables such as `currentChapterList`, `currentReading` and `isReaderOpen` are
  top-level `let` in manga.html: they are visible to this script by name, but NOT as
  `window.*` properties.
- Page display (`updateMangaPage` is replaced, not wrapped, so pages can come from
  `pageSrc()` and preloaded `<img>` elements): page turns work as in manga.html. The
  reader goes blank (white) at once with "Loading N / M...", and the page appears when
  loaded. A preloaded page is appended two animation frames later so the blank still
  reaches the screen. Tried and rejected by the owner on 2026-10-05: swapping straight
  from page to page in one redraw, and keeping the old page until the next was ready
  then blanking and drawing in back-to-back frames. Keep the original.
- `pageSrc()` turns page links into `/__rk/img?url=...&page=1` (MangaDex, was
  `/api/proxy`) or `/__rk/manga/img?...&page=1` (Manhuagui). `server/src/images.js`
  passes the original image through unchanged (server memory cache, `no-store` for the
  browser, MangaDex@Home -> uploads.mangadex.org fallback). Tried and rejected on
  2026-10-05, don't bring back: resizing/re-encoding pages to the screen (mozjpeg made
  page turns ~1 s slower), whitening the background, grayscale conversion, and a
  dithered black-and-white mode. The owner wants the original images, colour included
  (Kindle Scribe Colorsoft).
- Pages are served with `Cache-Control: no-store` and the preloaded `<img>` elements
  are what gets shown (`takePreloaded`), since no-store images are not reused from
  the browser cache. The last `RECENT_KEEP` (2) pages shown are kept too, so going back
  is instant. The server keeps pages in a 64 MB in-memory LRU (`serveImage`).
  Reason for no-store: the Kindle erases the browser's whole data folder
  (localStorage sign-in, IndexedDB Manga library/progress) at launch once it passes
  64 MB, and cached pages (MangaDex@Home sent 14-day caching, up to 2.4 MB a page) did
  that; the owner saw it as "logged out and library gone after a deploy" (they reopened
  the browser after deploys). Server data on Zeabur was intact (`/data` is a mounted volume).
- Library and reading progress live in the database per account (`manga_state` table,
  `server/src/manga-state.js`, `GET/PUT /__rk/manga/state`). manga.html still reads its
  localforage copy (`manga_library`, `manga_progress`); the add-on wraps `loadLibrary`
  to replace that copy with the account's before the library is drawn (5 s timeout,
  then the device copy), wraps `saveLibrary` and replaces `saveProgress` (same entry plus
  `t`, a time in ms) to send each change. Library PUTs replace the list; progress is
  merged per manga, newest `t` wins. Unsent changes wait in `localStorage.rk_manga_pending`
  tagged with the account's uid and are sent first on the next open. Signed out, the
  app is local only. Libraries that existed only in a browser before this were not
  uploaded: the owner asked for no backward compatibility. `auth.deleteUser` removes
  the row.
- A page that fails to load is retried once after 1.5 s (MangaDex@Home nodes sometimes
  404 a page once).
