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
- Dark mode white flash (fixed 2026-10-05): theme.js only darkens a page once it has
  downloaded and run (the server makes browsers revalidate it on every page, and
  settings.html loads it at the end of the body), and the Kindle's Chromium 75 has no
  "paint holding", so every page turn showed a white page first, which e-ink redraws
  in full. `transform.js` puts `DARK_HEAD` first in every `<head>`: an inline script
  that reads `rekindle_theme_mode` (and the auto rule) and adds the same
  `#rekindle-dark-theme` style theme.js would. Keep `DARK_CSS` in sync with
  `injectDarkStyles()` in theme.js. `selfhost/site` pages (not transformed) carry a
  copy of the snippet. Modern desktop browsers hold the old page during loads, so
  the flash only reproduces on the device.
- Dark mode white flash (fixed 2026-10-05): theme.js only darkens a page once it has
  downloaded and run (the server makes browsers revalidate it on every page, and
  settings.html loads it at the end of the body), and the Kindle's Chromium 75 has no
  "paint holding", so every page turn showed a white page first, which e-ink redraws
  in full. `transform.js` puts `DARK_HEAD` first in every `<head>`: an inline script
  that reads `rekindle_theme_mode` (and the auto rule) and adds the same
  `#rekindle-dark-theme` style theme.js would. Keep `DARK_CSS` in sync with
  `injectDarkStyles()` in theme.js. `selfhost/site` pages (not transformed) carry a
  copy of the snippet. Modern desktop browsers hold the old page during loads, so
  the flash only reproduces on the device.

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

Lower half white after Page Down (owner, 2026-10-05, Substack and other apps): on the
Kindle's high-density screen Chromium scrolls an `overflow: auto` box as its own
composited layer and draws only about half a screen ahead, so a jump of almost a screen
showed the top half at once and the lower half a moment later (white until then, a
second e-ink refresh). `jump()` sets `overflow-y: hidden` on the box for the jump (not
composited, so the jump is an ordinary repaint shown only when complete; `scrollTop`
still works) and keeps a classic scrollbar's width as extra `padding-right` so nothing
reflows. The box STAYS non-scrollable after the jump: the first version restored it
400 ms later, and the owner's video (frames every 0.25 s) showed that restore re-create
the layer and redraw the whole box, leaving the lower part white for another ~1.25 s,
a second flash after the jump's own (0.25-0.5 s) one. Scrolling is given back on a
`touchmove` or `wheel` inside the box, or when the pager moves to another box
(`release()`; `findScroller` still counts the held box). Document-level scrolling is
unchanged (the root scroller is always composited). On this Kindle the compositor shows
frames before every tile is drawn, so a slow-to-draw screen (images, CJK glyphs in STSong)
can still appear top first; desktop Chrome draws too fast to ever show it.

Tried and removed (2026-10-05): decoding the new screen's pictures with `img.decode()`
before moving (pictures and the text below them came last in the second video). The
third video showed the same top-first drawing (~0.5 s for a dense Substack screen with
pictures and CJK text), so decoding was not the cause; it only added a pause per tap.
With the box held non-scrollable there is no drawn-ahead area: every jump redraws the
whole visible box, top down. Only hiding the box while it draws (then showing it whole)
or smaller steps could avoid the split.

The owner first chose hiding the box while it draws (a white cover for 700 ms), then
disliked the delay. Now, on Substack only (`BUFFER_PAGES`, box `#reader-content`; other
apps draw fast enough), Page Down is double-buffered: `setupBuffer()` (from `refresh()`)
puts a `cloneNode` copy right after the real box, absolutely positioned on it (its
offsetTop/Left/Width/Height, `box-sizing: border-box`, `max-width: none`, so the lines
wrap the same), and pre-scrolls it one step ahead. Both boxes get `will-change:
transform` (own composited layers) and `rgba(255,255,255,0.996)`: a fully opaque front
would let cc skip drawing the box behind, and 1/255 bleed is invisible on e-ink. Page Down
swaps their z-index (front 2, back 1; `scroller` follows the front), which needs no
drawing, then `syncBack()` moves the new back box one step past the front, 50 ms later,
so it is drawn while the reader reads. Page Up and swipes scroll the front box directly
(the back follows 300 ms after the scroll settles). The copy keeps the id so the
`#reader-content` styles apply, but comes second in the DOM, so the app's getElementById
gets the real box; `data-rk-cjk="off"` stops rk-cjk.js re-wrapping it. A
MutationObserver on the real box (new article, rk-cjk wrapping) brings the real box to
the front and re-copies its innerHTML after 600 ms; until then Page Down scrolls directly.
Holds a second copy of the article in memory; if the Kindle can't keep both layers drawn,
Page Down just shows the old top-first drawing.

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
- Only EPUB is handled (owner, 2026-10-05: the Kindle opens MOBI, PDF, TXT and more,
  but not EPUB; do NOT convert or refuse other formats, they download as they are). For
  a book whose own file (the first `/dl/` link, text like "epub, 649 KB") is EPUB, in
  this order (book-details.min.js, read on a signed-out book page 2026-10-05):
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
  3. The EPUB itself, converted by the browser service's POST `/convert` (body = file,
     name in
  `X-File-Name`): Calibre's `ebook-convert` (Debian `calibre` package in
  `Dockerfile.zlibrary-browser`) with `--output-profile kindle_pw3 --mobi-file-type
  both` (old MOBI + KF8 in one file), `QT_QPA_PLATFORM=offscreen`, one at a time, 5 min
  limit; EPUB only (anything else gets 415). Calibre is the fallback for when
  Z-Library's converter fails.
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
this server's `rkTextSize` (`rk_text_size`) and `rkPageButtons` (`rk_page_buttons`),
which `rk-textsize.js` and `rk-pager.js` now save to the account with the same signal
(`saveToAccount`). New per-user settings should follow this pattern.

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
- Page Down flashed the lower part of the screen only in Substack (owner, 2026-10-05):
  `body_html` images are `loading="lazy"` (12 of 14 in a sample post), so they were
  fetched only when scrolled near, and Chromium 75 reserves no space for an image
  before it arrives (width/height attributes give no aspect ratio until Chrome 88): the
  image loaded after the jump, pushed the text below it down, and the lower part
  redrew. `rkFixImages` (which edits every API answer's JSON text) now drops
  `loading="lazy"` and adds `decoding="sync"` to every `<img`, so images load with the
  article and each picture is drawn in the same frame as its surroundings.
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
