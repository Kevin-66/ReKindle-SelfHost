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
- Dark mode is OFF, exactly as upstream has it (`theme.js` forces light, Settings greys
  out Theme); `theme.js`, `index.html`, `index_old.html` are upstream's files again, and
  `settings.html` differs only by the Canada line. The fork re-enabled dark mode
  (2d411d7: whole-page `invert(1) hue-rotate(180deg)`, an early `DARK_HEAD` snippet
  against the white flash) and fixed what a patrol of every app found (1f31ec6: canvases
  going dark, true-colour chess/checkers/Connect 4 boards, map tiles, notice pages, dark
  dialog backdrops via `darkBackdrops()`), then the owner switched it off again
  (2026-10-06, "too troublesome... revert to the author's way") and all of that was
  removed. Both commits are the place to start if dark mode comes back.

## E-ink refresh on the Kindle (measured 2026-10-06)

Filmed on the owner's Kindle Scribe Colorsoft (Silk 80.4 = Chromium 80, 993x1216 CSS
px, pixel ratio 2, light mode) with a page of 24 timed changes; the test tools are kept
out of this repo. Dip = how much darker the changed area got than both before and after
(0-255, from the video's brightness):
- No whole-screen flash for anything: text of any size or colour, a seconds counter,
  black-and-white shapes and canvas drawing (also at 10 Hz), a small anti-aliased dot
  (Snake), scrolling a box or the page, dialogs and page reloads are quiet (dip < 2.5).
- Only the changed area blinks, for: a picture swapped (17-18), a grey square appearing
  (9), a large anti-aliased canvas drawing (9), a colour square appearing (3-5), a CSS
  fade (8-9), half the screen turning black (15-17). A grey or colour area disappearing
  doesn't blink, it lightens slowly.
- Timing: the first animation frame comes a median 235 ms after a change (90% within
  420 ms), the next ~470 ms later; the screen starts changing 230-430 ms after the
  change and has settled by 1-1.5 s.
- The whole-screen flashes seen before this were most likely dark mode's root
  `filter: invert` (removed since).

## Download jobs and the browser service

`file-jobs.js` runs jobs that end in a file for the Kindle (Z-Library books in
`zlibrary-account.js`, Manga chapters as AZW3 in `manga-azw3.js`): `jobStore().start()`
gives each job a temp folder, keeps a finished file 30 min, and `sendJobFile` sends it as an
attachment (UTF-8 `filename*`). `browser-service.js` is the one place that calls the
Z-Library browser service (`ZLIBRARY_BROWSER_ENDPOINT`, private hosts only, bearer token,
`rawFetch`); `zlibrary-browser.js` imports it on demand because that file is also copied
into the browser service's image, where it doesn't exist.

## Logging: locally only

The owner wants logging only when running locally, never on the deployed server
(2026-10-06). The Docker images set `NODE_ENV=production`; local runs (Deno, `npm start`)
don't. So the request log (`LOG_REQUESTS`, default on locally and off in production)
and debugging output such as `[zlibrary download]` steps are tied to
`NODE_ENV !== 'production'`. When adding diagnostics, follow that, and for device
measurements use a local server: e.g. a page can report timings as
`GET /__rk/health?<values>`, which the local request log prints.

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
  (25 places in 2026-10: Manga, Comics, ...). The other common form,
  `window.t ? window.t('key') : 'Text'` (388 places in 53 apps, e.g. Breathing's
  "BREATHING.STEP.INHALE"), has the same problem and is rewritten to
  `window.t ? window.t('key', 'Text') : 'Text'`. Only a lone string literal that ends the
  expression is moved. Write new code as `window.t('key', 'Text')`.
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

Two ideas for the buttons appearing were tried and rejected on 2026-10-06; keep the
original: shown as soon as the page loads, re-checked on DOM changes, hidden where
nothing scrolls. Rejected: waiting for the page to settle before showing them (no DOM
changes for 700 ms, 0.8-2.5 s), and keeping them shown with grey arrows once they had
appeared.

Page Down on the Kindle (2026-10-05, owner's videos of a Substack article): a jump of
almost a screen shows the top part at once and the rest 0.5-1 s later, because the
Kindle's Chromium shows a screen before it has finished drawing it and draws only about
half a screen ahead of the view. Dense Substack screens (pictures, Chinese text) make it
visible; lighter apps draw fast enough. The owner asked to revert all attempts, and later
(2026-10-06) asked for two moves done together: `page()` moves half the step, then the
rest on the next animation frame (~235 ms on the Kindle); a tap before that is ignored.
A 700 ms gap between the halves was rejected ("do the two moves together"). Not yet
checked on the Kindle. Tried on 2026-10-05 and removed, none fixed it on the device:
`overflow-y: hidden` during the jump (and restoring it 400 ms later caused a second,
longer redraw), keeping the box non-scrollable until a swipe, `img.decode()` of
the next screen's pictures before moving, a white cover (own composited layer) for
700 ms, double buffering with a copy of the box behind it, and loading Substack
images eagerly with `decoding="sync"`. Half-screen steps (the half already drawn ahead
appears at once) are what `page()` does now, see above.

## Chinese text on the Kindle (`selfhost/site/js/rk-cjk.js`)

The Kindle browser draws Chinese with its Japanese font (角 in 确 gets the Japanese
stroke), and `lang="zh-Hans"` alone changes nothing there (tried 2026-10-05). The device
does have Chinese fonts, STSong and STHeiti, but only uses them when named: a test
page (`selfhost/site/fonttest.html`, removed afterwards; it is in git history) drew
characters in candidate fonts and found them; Noto Sans SC as a web font also worked
but would cost storage.

`transform.js` adds `rk-cjk.js` to every page (`hackernews.html` includes it). It wraps
runs of Chinese characters, with the CJK punctuation between them, in
`<span class="rk-zh-serif|rk-zh-sans">` (no `lang`: it had no effect): STSong when the surrounding
font list starts with a serif (Georgia, serif, ...), STHeiti otherwise; other devices
fall back to their own Chinese fonts (Songti/Heiti/PingFang/Noto). English keeps its
font. Text with kana (Japanese), elements marked `lang="zh..."`/`"ja..."` or
`data-rk-cjk="off"`, form fields and editable areas are left alone; a MutationObserver
(250 ms batches) handles text added later. Check changes on the Kindle itself: desktop
browsers usually pick a Chinese font anyway. The local dev server listens on all
interfaces, so the Kindle can open it on the home network (http://<Mac's IP>:8787).

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

## Z-Library (`selfhost/site/zlibrary.html`)

- Launcher entry is injected by `transform.js`; `/__rk/zlibrary` serves a bounded,
  five-minute cached public catalogue through `server/src/zlibrary.js`.
- Current search markup uses `z-bookcard` with `slot="title"`/`slot="author"`
  children and metadata attributes. Popular books use `a > z-cover`. Ignore hidden
  cards on any ancestor: live search includes hidden synthetic records. Missing
  catalogue markup is an upstream failure, not a zero-result search.
- Plain HTTP via Netcup's `PROXY_URL` gets a 307 cookie redirect then DiamWall
  verification (513). Headless Chromium is explicitly denied (517). A normal
  headed Chromium under Xvfb, with its sandbox enabled and the same proxy, passes
  the site's own JavaScript verification: verified popular + two search pages.
  No CAPTCHA-solving service or imported account cookies are involved.
- Direct headed-browser access from Netcup also works (2026-10-05): popular books
  loaded in 3 seconds and search in 1.7 seconds with no proxy. The browser now uses
  direct access by default, with optional `ZLIBRARY_PROXY_URL`; never implicitly
  reuse archive.today's `PROXY_URL`. The sidecar only receives the optional
  Z-Library-specific variable. Keep archive.today's proxy configuration intact.
- `zlibrary-browser.js` defaults to headed Chromium and reuses a public context.
  One tab at a time, a bounded queue, 60-second deadlines, and a five-minute idle
  shutdown limit CPU/memory. Only HTTPS z-lib.sk, cdn-zlib.sk and diamwall.com
  subresources are allowed; downloads, service workers and WebSockets are blocked.
  Never log Playwright launch errors (proxy credentials can appear in them).
- Chromium runs in its own service (2026-10-05, owner's request), not in the main
  image: `Dockerfile.zlibrary-browser` (repository root, so it can copy
  `selfhost/server/src/zlibrary-browser.js` as `zlibrary-browser.mjs`) runs
  `selfhost/browser/service.mjs` (POST `/catalogue` {url} -> HTML, GET `/health`).
  The server uses it when `ZLIBRARY_BROWSER_ENDPOINT` is set (only private hosts:
  loopback, `*.zeabur.internal`, or a single-label Compose name), sending
  `Authorization: Bearer $ZLIBRARY_BROWSER_TOKEN` through `rawFetch` (the public-address
  guard would refuse the private address). Docker Compose starts it as
  `zlibrary-browser`; on Zeabur it is a second service from the same repository.
- Zeabur starts containers as root even with `USER node`, and Chromium refuses its
  sandbox as root ("Chromium sandboxing failed!"): every request failed at once with
  `zlibrary/browser-unavailable` after the image first shipped Chromium. As `node`
  under `xvfb-run` it launches in ~0.5 s. `selfhost/browser/start.sh` therefore drops
  to `node` with `setpriv` before `xvfb-run`. Never fix this by disabling the sandbox
  or going headless (Z-Library refuses headless Chromium with 517). `tini` is PID 1:
  `xvfb-run` must not be (it stalls waiting for Xvfb's startup signal).
- The earlier hand-applied Kubernetes overlay (`selfhost/browser/deploy-netcup.py`,
  a loopback sidecar in the ReKindle pod) was removed when the separate service
  replaced it; it is in git history.
- Downloads use the reader's own Z-Library cookie (2026-10-05, owner's choice over a
  remote-browser view): pasted under Account in zlibrary.html (`remix_userid`,
  `remix_userkey`; any name=value pairs are kept), stored per ReKindle account in the
  `zlib_accounts` table (`zlibrary-account.js`, GET/PUT/DELETE `/__rk/zlibrary/account`,
  removed with the account). A finished download job (below) hands out a
  10-minute HMAC-signed `/__rk/zlibrary/download?t=` link (a plain link cannot carry
  the ReKindle sign-in). The browser service's POST `/download` (`downloadBook`): a
  fresh context with the cookie on `.z-lib.sk` opens the book page in headed Chromium,
  saves the download (300 MB cap, one at a time) and streams it back with `X-File-Name`.
  Subresources stay limited to Z-Library; page navigations may go to any https host
  (download links redirect to hosts we can't list in advance).
- Formats (owner, 2026-10-06): the Kindle browser downloads only MOBI, AZW, PRC and TXT,
  and AZW3 is kept too (an earlier rule converted only EPUB, believing the Kindle opened
  PDF). A book whose own file (the first `/dl/` link, text like "epub, 649 KB") is one of
  those downloads as it is; any other becomes MOBI, in this order (book-details.min.js,
  read on a signed-out book page 2026-10-05):
  1. A MOBI file of the same book: clicking `#btnCheckOtherFormats` makes the page
     fetch `/papi/book/<id>/formats` and add the book's other files to the menu; take
     a `/dl/` link whose own text says MOBI (DOM click, the menu is hidden).
  2. Z-Library's converter (owner's suggestion): the menu's "Convert to" list has
     `a.converterLink[data-convert_to="mobi"]` (button `data-convertation-available="1"`).
     Clicking it signed in makes the page POST `/papi/book/<id>/file-conversion/mobi`
     (answer `{error}` | `{jobId}` | `{response: {statusOkContent, downloadUrl}}`), poll
     `/papi/book/<id>/file-conversion/jobs` every 10 s and open the job's `downloadUrl`
     when it is "ok"; we catch that download (5 min limit). `answer.error` (e.g. daily
     limit) is reported as is; a failed job (`#converterCurrentStatusesBox
     .status-error`) or a timeout falls through to 3. Signed out it only shows a login
     popup (and the link's `data-book-id` is empty, which is logged). Not yet seen
     working: needs the owner's account.
  Timing: Z-Library's script (jQuery 2.2.4) attaches its handlers only as the page
  finishes loading, and a DOM click before that does nothing (the first version
  clicked as soon as the `/dl/` link appeared). The code waits for the `load` event,
  then `handlerReady()` polls `jQuery._data(document, 'events').click` for the
  `.converterLink` delegate and `jQuery._data(#btnCheckOtherFormats, 'events')`.
  Each step is logged as `[zlibrary download] ...` (book path only, never the cookie).
  3. The book's own file, converted by the browser service's POST `/convert` (body =
     file, name in
  `X-File-Name`): Calibre's `ebook-convert` (Debian `calibre` package in
  `Dockerfile.zlibrary-browser`) writing `book.azw3` (Calibre's AZW3/KF8 writer; owner,
  2026-10-06: Z-Library's MOBI first, our own conversions give AZW3; it used to be MOBI
  "both") with `--output-profile kindle_pw3`, `QT_QPA_PLATFORM=offscreen`, one at a time, 5 min
  limit; Calibre's input formats only (`CONVERTIBLE`, plus `cbz` for Manga chapters with
  `COMIC_ARGS`), others get 415. Calibre is the fallback for when Z-Library's converter
  fails.
- Download + conversion can take minutes, longer than a page request should hang
  behind Zeabur's proxy, so it is a job (`zlibrary-account.js`): POST
  `/__rk/zlibrary/jobs` {url} -> {id} (same book again returns the running job; another
  book while one runs -> 409), GET `/__rk/zlibrary/jobs/<id>` -> working (step
  `download`/`convert`) | failed (message) | ready (name, size, signed `href`). The
  server keeps the file in a temp dir for 30 minutes (the Kindle may retry) and
  `sendDownload` serves it with Content-Disposition; failures there are an HTML notice
  page. zlibrary.html polls every 3 s and changes its message only when the step
  changes (a ticking counter would redraw the whole e-ink screen each time).
- Tested locally with a stand-in `/download` and a fake `ebook-convert` on PATH (no
  Calibre or Docker on the Mac); check real conversion in the deployed service with
  `ebook-convert` on a small EPUB. The real Z-Library steps were not testable without
  the owner's account: if downloads fail, check the `/dl/` link and converter
  selectors above.
- `rk_zlibrary_saved_v1` stores up to 200 local bookmarks, not downloads. The page
  includes text-size setup and `rk-pager.js`; client timeout allows cold verification.
- Focused checks: `node --test selfhost/server/test/zlibrary.test.js`.

## Settings kept with the account

Settings saves its options to `users/{uid}/settings/general` and bumps
`users/{uid}.settingsLastUpdated`; the home screen (`index.html`/`index_old.html`,
`syncGeneralSettings`) copies that document into localStorage when the signal is newer
than `rekindle_settings_last_sync`, or when that mark is missing (a new device, or a
Kindle that wiped its browser data). It skipped displayMode, opendyslexicFont, scale,
scaleAuto, homeLayout and timezoneOffset, so those stayed at their defaults outside
Settings. `transform.js` adds them (applying display mode, font and scale at once) plus
this server's `rkTextSize` (`rk_text_size`), `rkPageButtons` (`rk_page_buttons`) and
`rkMangaBlank` (`rk_manga_blank`),
which `rk-textsize.js` and `rk-pager.js` now save to the account with the same signal
(`saveToAccount`). New per-user settings should follow this pattern.

Changes made while Settings is still loading the account (2026-10-06, owner: Display Mode
"still not properly saved"): Settings applies the account's `general` document once
sign-in completes, a second or two on the Kindle, and that overwrote any change made in
the meantime (saved only locally while `currentUser` was null, or replaced by the older
copy arriving after the save). `transform.js` puts `SETTINGS_GUARD` in the page's head: a
capturing `change` listener records changes to `.setting-row` controls until the account's
settings have been applied (hooked into `loadCloudSettings`'s `get()`; the page's own
synthetic changes during that apply are ignored via `applying`), then sets each control
again and dispatches `change`, so the page's own save writes it to the account. Guests:
finished when "Guest Mode" is shown. Verified locally by requesting the account copy
(LED) and choosing eInk before it arrived: eInk ended up on screen, on the device and in
the account.

## Notes sync (`selfhost/site/js/rk-notes-sync.js`)

notes.html saved the whole note (debounced 1 s) with a plain `set()` and never updated an
open note from its list listener, so two browsers editing one note overwrote each other.
`transform.js` adds `rk-notes-sync.js` for signed-in readers: while a note is open it has
a document `onSnapshot` and shows remote saves (caret kept by mapping its text offset
through the change); edits merge three-way against `base` (the last version both sides
saw). Each side's unsent change is one stretch (common prefix/suffix); stretches in
different places are both applied, overlapping ones are both kept side by side. Saves
run in `db.runTransaction`, which the server aborts if the note's update time changed
since it was read, so the merge is redone and retried. It wraps `openNote`, `showList`,
`saveNoteData` (only for the open note) and `deleteNoteData`; guest notes are untouched.
Tested with two tabs: live update, simultaneous edits on different lines, caret kept.

## Notes stopwatch (`selfhost/site/js/rk-notes-stopwatch.js`)

`transform.js` adds it to `notes.html` after `rk-notes-sync.js`. A `.sys-btn` inserted after
`#note-title-input` is reset to 0:00, paused (the user asked for paused by default), each
time a note is opened (wraps `openNote`; only when the editor actually shows) and stops in
`showList` (Back, Delete). Tapping starts it, then toggles pause (pause-bars icon) /
resume (stopwatch icon). It listens to `touchstart` and
`mousedown` with `preventDefault`, like the page's B/I/U buttons, so the caret and Kindle
keyboard stay in the note; keyboard activation comes through `click` with `detail === 0`.
Elapsed time is `Date.now()`-based (banked + since resume), redrawn by a `setTimeout`
aligned to the next whole second. Format `m:ss`, then `h:mm:ss`. Not saved anywhere,
works for guests too.

The first version showed the time as text, and the Kindle flashed the WHOLE screen every
second (owner, 2026-10-05): anti-aliased text is grey, and a grey update gets a full
grayscale refresh, as with canvas games (root AGENTS.md, Surfer). The time and the
state icon are now 1-bit glyphs (5x7 digits, `GLYPHS`) drawn with integer `fillRect`
on a canvas one buffer pixel per glyph pixel, shown at 2 CSS px per pixel with
`image-rendering: pixelated`. The canvas keeps the width of "00:00" (text right-aligned),
so ticks don't move the toolbar until hours appear. Any live-updating readout on the
Kindle should be drawn this way, not as changing text.

## Notes Markdown and the agent link

- Notes stay HTML (`users/{uid}/notes/{id}`: `title`, `content` HTML, `updated` ms), so old
  notes, B/I/U and `rk-notes-sync.js` merging are unchanged. `selfhost/site/js/rk-notes-markdown.js`
  (added by `transform.js` after the stopwatch) styles Markdown elements in
  `#note-content`, adds typing rules on `input` events (`inputType` `insertText`, one
  character), replaces `downloadTXT` with a `.md` export (`window.rkNotesToMarkdown`), and
  adds the Agent button and window.
- Typing rules use `document.execCommand` so Undo keeps working: block rules
  (`formatBlock` h1-h6/blockquote, `insertUnorderedList`/`insertOrderedList`) fire on the
  space after a marker at the start of a line (`atLineStart`: no content before the text
  node on its line); `---` inserts `<hr><div><br></div>`; bold/italic/strike type the
  inner text, select it, apply the command and toggle the typing style off again.
  `code` is built with `Range.insertNode` (insertHTML copied the surrounding font size
  onto it) plus a trailing nbsp. Enter on an empty quote line removes it and turns the
  line back into a `div` (Chrome otherwise starts another quote). Rules never fire in
  PRE/CODE, block rules not in LI/headings/table cells.
- Testing gotcha: the browser pane's `type` action inserts a whole string as ONE input
  event, and calling `execCommand('insertText')` per character from page JS nests the
  rules' commands inside another command (garbled results). Test with one `type`
  action per character and `key Return`, like the Kindle keyboard.
- The agent link (`server/src/notes-agent.js`): table `notes_agent(uid, key UNIQUE)`,
  key = 24 random bytes base64url. `GET/POST /__rk/notes/agent-link` (signed in) returns
  or replaces it. Under `/__rk/notes/agent/<key>`: GET (no path) = plain-text
  instructions for agents; `GET /notes[?q=]` list/search (newest first), `POST /notes`
  add (201), `GET /notes/<id>` read as Markdown, `PATCH|PUT|POST /notes/<id>` replace
  the fields given (`title`, `markdown`) or `append`, `DELETE /notes/<id>`. CORS `*`,
  120 requests/min per IP, 256 KB bodies. The owner asked for no verification and,
  after a first add-only version, for full editing: the link alone grants read/write
  access to that account's notes. Writes use `fsStore.commit(..., {internal: true})`,
  so open Notes lists update live and an open note merges the change (rk-notes-sync).
  `append` adds the rendered HTML after the note's own HTML (no Markdown round trip,
  so editor formatting such as underline is kept).
- `server/src/markdown.js` turns the Markdown into HTML. It escapes all text (raw HTML
  shows as text) and keeps only http(s)/mailto links and http(s) images, because the
  link holder must not be able to run script in the owner's session. `htmlToMarkdown`
  (linkedom) turns notes back for reading, with the same rules as the page's `.md`
  download; a Markdown -> HTML -> Markdown round trip is exact (tested). The editor uses
  `white-space: pre-wrap`, so the output has NO whitespace between tags (it shows as
  blank lines); paragraph line breaks become `<br>`. All inline patterns are bounded
  (one line, 500 chars) after a stress test of 50,000 unclosed `[` took 11 s;
  `test/markdown.test.js` keeps worst cases under 3 s.

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
  loaded. A preloaded page is appended in a task queued from the next animation frame,
  i.e. right after the blank has been painted (2026-10-06: two frames cost ~0.4 s per
  turn on the Kindle, where a frame takes ~300 ms; the owner confirmed the blank still
  shows every turn). Measured that day with a local timing log: decoding preloaded pages
  ahead (`img.decode()`) made no difference (~1.6 s from tap to the frame with the page
  either way), so it isn't done; most of the remaining ~1.1 s is the Kindle drawing the
  page. Tried and rejected by the owner on 2026-10-05: swapping straight
  from page to page in one redraw, and keeping the old page until the next was ready
  then blanking and drawing in back-to-back frames. Keep the original.
- `pageSrc()` turns page links into `/__rk/img?url=...&page=1` (MangaDex, was
  `/api/proxy`) or `/__rk/manga/img?...&page=1` (Manhuagui). `server/src/images.js`
  passes the original image through unchanged (server memory cache, `no-store` for the
  browser, MangaDex@Home -> uploads.mangadex.org fallback). Tried and rejected on
  2026-10-05, don't bring back: resizing/re-encoding pages to the screen (mozjpeg made
  page turns ~1 s slower), whitening the background, grayscale conversion, and a
  dithered black-and-white mode. The owner wants the original images, colour included
  (Kindle Scribe Colorsoft). Display size: manga.html's `.reader-page` (`max-width` /
  `max-height: 100%`) only shrinks, and the server-side fitting that used to enlarge
  pages went with the originals, so small pages (Manhuagui 650x924) sat small in the
  middle on the Scribe ("viewer is now zoomed out", 2026-10-06). rk-manga-sources.js
  adds `#reader-content img.reader-page{width:100%;height:100%;object-fit:contain}`: the
  browser draws every page as large as the reader allows (the image stays the original).
- Pages are served with `Cache-Control: no-store` and the preloaded `<img>` elements
  are what gets shown (`takePreloaded`), since no-store images are not reused from
  the browser cache. The last `RECENT_KEEP` (2) pages shown are kept too, so going back
  is instant. The server keeps pages in a 64 MB in-memory LRU (`serveImage`), and Manga
  pages (requests with `page` options) also on disk: `server/src/page-cache.js`,
  `DATA_DIR/manga-cache`, `MANGA_CACHE_MB` (default 1024, owner 2026-10-06), least
  recently read evicted down to 90%, order kept across restarts via file mtimes. Keys
  are made stable (`stableKey`): MangaDex@Home addresses change per node and visit, so a
  page is `md:data/<chapter hash>/<file>` (uploads.mangadex.org gives the same key);
  Manhuagui is `mhg:<encoded address>` without the signature. Checked: after a restart,
  the same page via another MangaDex address came from disk in 4 ms. Zeabur's /data
  volume had 424 GB free.
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
- AZW3 button (`#rk-azw3-btn`, next to `#rk-ch-btn`): the Kindle browser downloads only
  Kindle books and TXT (a PDF version was built first and dropped: the Kindle won't take
  PDF; then MOBI, see below). POST `/__rk/manga/azw3` `{title, pages}` (the chapter's raw
  page list, `/api/proxy?url=<MangaDex page>` or signed `/__rk/manga/img?u=&k=`; MangaDex
  hosts only, public network) starts a job (`server/src/manga-azw3.js`): pages come
  through `serveImage` (same cache as the reader), `comicImage` (below) into a stored
  CBZ (`ZipWriter`, own CRC-32), a failed page is left out
  (`missing`); then the converter service's POST `/convert` (Calibre in the Z-Library
  browser service, `ZLIBRARY_BROWSER_ENDPOINT`) makes an AZW3 (KF8) with `COMIC_ARGS`
  (`--no-process`: no greyscale/resizing, colour Kindle; `--output-profile
  kindle_scribe`), and the server marks it fixed-layout. GET `/__rk/manga/azw3/<id>` ->
  working (step `pages`/`convert`) | failed | ready (`href` =
  `/__rk/manga/azw3/<id>/file`, 30 min, the random id is the permission). The page polls
  every 3 s and only changes its status text when the step changes. Timing on the live
  service, 54-page chapter (before pages were kept as originals): pages 12.6 s (fetch +
  resize), Calibre 7.6 s; the page work alone is now ~3.6 s for 54 pages.
  How the pages came to fill the screen (each step was needed; owner's reports in quotes):
  1. "not zoomed in properly": in a reflowable book the Kindle shows pictures at their
     own size, so 850x1200 originals sat small. Pages were enlarged to the Kindle
     Scribe's 1860x2480 (`SCREEN`) for a while; since the book is fixed-layout (3.) the
     Kindle enlarges them itself, so pages now keep their own size (6.).
  2. "page zoom did not work": Calibre's comic page HTML is `<div><img class="calibre2">`
     with `width/height: auto`; `--extra-css "img { width: 100% !important; height: auto
     !important; }"` (checked in the decompiled KF8 flow; `@page`/body margins are 0).
  3. "still not filled": the book was reflowable, and the Kindle puts a reflowable book's
     pictures inside its margins, title above and progress line below. Comics that fill
     the screen (Amazon's tools, Kindle Comic Converter) are fixed-layout, which Calibre
     6.13 can't write: `server/src/azw3-fixed-layout.js` `setExth()` rewrites record 0 of
     the finished file with EXTH 122 fixed-layout=true, 123 book-type=comic, 124
     portrait, 126 original-resolution (the book's page size, see 8.), 127/128 zero gutter/margin, 132
     region-mag=false, 525 horizontal-lr, 527 ltr (codes from KindleUnpack's
     `mobi_header.py`; only record 0 grows, the PDB record offsets shift, everything else
     refers to records by number). With fixed layout `width: 100%` must not overflow the
     page, so every page has the screen's 3:4 shape: centred, each gap black or white to
     match the picture's edge on that side (`fillPage`/`edgeBrightness`; one averaged
     colour gave white bars beside dark pages).
  4. "it can't be opened": the converter had switched to `--mobi-file-type new` (KF8
     only) but the file was still named .mobi; the Kindle doesn't open that. KF8-only is
     AZW3, so the converter now writes `.azw3` (Calibre's AZW3 writer; same bytes as MOBI
     "new") and the download is `<chapter>.azw3` (owner: "just give me azw3"; checked on
     the Kindle with a fixed-layout test file: opens).
  5. Calibre re-saves every JPEG without a JFIF header at quality 75 (its
     `process_jpegs_for_amazon`: "Amazon's renderer can't show JPEGs without JFIF"), and
     sharp writes none, so pages lost quality (a 1070 KB page came out 365 KB). `withJfif`
     adds the APP0 segment; a JPEG with JFIF and no EXIF is kept byte for byte.
  6. Size ("why so big?"): enlarged 1860x2480 JPEG q92 pages made a 54-page chapter
     ~48 MB (MangaDex's own PNGs: 27-31 MB; screentone barely compresses). Owner: no
     enlarging, originals ("why not just use the original png??", "the original could
     have color!!"). `comicImage` now keeps each page's own size (only a page larger
     than the screen shrinks) and format: PNG stays PNG (padded ones re-saved losslessly,
     grey stays 1-channel: set `toColourspace('b-w')` on the raw output or sharp writes
     RGB), JPEG stays JPEG (re-encoded q92 only when padded), WebP etc. become JPEG; a
     page already 3:4 goes in unchanged. Calibre's AZW3 writer keeps PNG pages byte for
     byte (checked on the live service; the 256-colour GIFs came from the MOBI writer's
     `mobify_image`). That 54-page chapter is now 28.6 MB of pages, colour untouched.
  7. "i get a table of content": Calibre's AZW3 writer adds an inline contents page
     ("Page 1", "Page 2", ... from the comic input); `--no-inline-toc` in `COMIC_ARGS`
     leaves it out (checked on the live service). Z-Library books keep theirs.
  8. "viewer is now zoomed out" (Manhuagui chapter, 650x924 WebP pages): with
     original-resolution 1860x2480 the Kindle drew each picture at its own size inside
     that page (width: 100% does not enlarge it), so small pages sat at ~37%. The
     book's page size is now the chapter's most common page size (`bookPageSize`:
     each page shrunk to the screen if larger, in its 3:4 shape; e.g. 693x924), every
     other page (a double-page spread) is fitted into it, and `setExth` gets that size;
     the Kindle scales the whole page to the screen. `makeBook` fetches all pages first
     (kept as files in the job dir) to find it. CMYK JPEGs pass through: the Kindle
     shows them (owner checked).
  Checking without a Kindle: Kindle Previewer (the only Amazon renderer for Mac) is
  x86_64-only and needs Rosetta, which this Mac doesn't have. Instead the real KF8 pages
  were unpacked (skeleton + fragment, FDST CSS flows, `kindle:embed` base-32 resource ids
  from the MOBI header at 0x5C) and drawn in a 1860x2480 frame. For a file made by the
  live Calibre, Zeabur `executeCommand` on the browser service (upload base64 in ~100 KB
  arguments, 4 per call; larger calls fail) and `cut -c` the base64 result back.
- Titles inside converted MOBIs: the converter saved uploads as `book.<ext>`, and the
  Kindle library showed every Manga chapter (and PDFs etc.) as "book" by "Unknown"
  (checked with `ebook-meta`). service.mjs now saves the upload under its own name
  (minus " (Z-Library)") and passes `--title` (comics: the chapter name) and, for formats
  without built-in details (`NAME_METADATA`: PDF, DJVU, RTF, ...), `--title`/`--authors`
  from Z-Library's "Title (Author)" file name. EPUB/FB2/DOCX keep their own. Download
  file names drop the " (Z-Library)" tag too (`fileName` in zlibrary-account.js).
- Swipes (owner's request 2026-10-06): a mostly horizontal touch move of at least 50 px
  on `#reader-view` turns the page (left = next, right = previous, like the tap zones);
  vertical moves still scroll, the chapter list is ignored, and the click a swipe may end
  in is swallowed (capture phase) so a tap zone doesn't turn a second page.
- Page-only full screen (`#rk-full-btn`, an icon of outward corners): `html.rk-manga-full`
  makes `.window` cover the screen (same `--rekindle-scale` maths as manga.html's own full
  screen) and hides `.title-bar`, `.tabs` and `#status-bar`; a corner `#rk-full-exit` icon
  (inward corners, with a larger invisible tap area) and `closeReader` leave it.
- Title-bar controls share one style (owner: "all the buttons are different style and
  size"): Back, the language dropdown's trigger, the chapter button, the page-only icon,
  AZW3 and manga.html's full-screen `.icon-btn` are all 22 px high with a 2 px border and
  2 px shadow, bold 0.7rem sans-serif; icon buttons are 22 px square. Keep new controls
  on that rule (see `addStyle`).
- White page between pages, optional (owner's request 2026-10-06, "put it in the
  setting"): Settings > Accessibility > "Manga: White Page Between Pages" (added by
  rk-pager.js next to Page Buttons) sets localStorage `rk_manga_blank` ('0' = off) and
  saves `rkMangaBlank` to the account settings document; the home screen copies it back
  (`syncGeneralSettings` edit in transform.js). Off, `updateMangaPage` swaps straight to
  the new page in one redraw (the old page stays until the new one has loaded). A
  version with a Blank button in the reader bar and a Manga-state option was dropped
  before deploying.
