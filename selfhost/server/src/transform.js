// Edits applied to ReKindle's pages for self-hosting. They run on a copy of the
// site while the Docker image is built (selfhost/prepare.js), or on the fly when
// the dev server serves the repository directly, so the repo's own files stay
// exactly as upstream has them.

// Apps that need ReKindle's central chat / multiplayer services.
export const DISABLED_APPS = [
    'kindlechat', 'topics', 'neighbourhood', 'suggestions', 'moderation', 'words',
    'livechess', 'livecheckers', 'liveconnect4', 'livedotsandboxes', 'livepictionary',
    'livetictactoe', 'liveuno', 'liveyahtzee'
];

export const DISABLED_PAGES = DISABLED_APPS.map((id) => `${id}.html`);

// Apps turned off for now, for other reasons (hidden from the launcher too).
// reddit: Reddit no longer serves servers (RSS ~1 request a minute, JSON blocked) and
// old.reddit.com needs a login whose reCAPTCHA only works on reddit.com.
export const PAUSED_APPS = { reddit: 'Reddit is turned off on this server for now: Reddit no longer lets servers read it without signing in.' };

const FIREBASE_TAG = /<script\b[^>]*\bsrc\s*=\s*["']https:\/\/www\.gstatic\.com\/firebasejs\/[^"']+["'][^>]*>\s*<\/script>/gi;
const COUNTER_TAG = /<script\b[^>]*cdn\.counter\.dev[^>]*>\s*<\/script>/gi;

const WORKER_ALIASES = {
    story: 'rekindle-story',
    chords: 'rekindle-chords'
};

function workerName(sub) {
    return WORKER_ALIASES[sub] || sub;
}

// "https://rekindle-x.timjarnott.workers.dev/path" -> same-origin "/__rk/w/rekindle-x/path".
// Upstream's social Workers moved to their own account in 2026-10
// (rekindle-moderate/rekindle-translate.rekindle-social.workers.dev).
// Quoted literals become an absolute URL built at runtime, so `new URL(...)` keeps working.
const WORKER_HOST = '([a-z0-9-]+)\\.(?:timjarnott|rekindle-social)\\.workers\\.dev';
// Upstream's HTTP Cloud Functions that pages call directly (Substack, Standard Ebooks)
// run in this server at /__rk/fn/<name> (functions-host.js).
const FUNCTION_HOST = 'us-central1-rekindle-dd1fa\\.cloudfunctions\\.net\\/([A-Za-z0-9_]+)';

function rewriteWorkerUrls(code) {
    code = code.replace(new RegExp(`(['"\`])https:\\/\\/${WORKER_HOST}([^'"\`\\n]*)\\1`, 'g'),
        (m, q, sub, rest) => `(location.protocol + '//' + location.host + ${q}/__rk/w/${workerName(sub)}${rest}${q})`);
    code = code.replace(new RegExp(`https:\\/\\/${WORKER_HOST}`, 'g'), (m, sub) => `/__rk/w/${workerName(sub)}`);
    return code.replace(new RegExp(`(['"\`])https:\\/\\/${FUNCTION_HOST}([^'"\`\\n]*)\\1`, 'g'),
        (m, q, name, rest) => `(location.protocol + '//' + location.host + ${q}/__rk/fn/${name}${rest}${q})`);
}

// The RSS reader and Newspaper fetch every feed through api.rss2json.com, which
// refuses feeds over about 10 MB and, without an API key, returns only 10 items.
// This server answers the same API at /__rk/rss2json (feeds.js); prepare.js fails
// the build if a page still calls rss2json.
export const RSS2JSON_API = 'https://api.rss2json.com/v1/api.json';

function rewriteRss2json(code) {
    return code.split(RSS2JSON_API).join('/__rk/rss2json');
}

// The RSS reader opens an article by fetching its page through the rekindle-reader
// Worker (Readability), even when the feed carries the whole text: for paywalled sites
// that is the teaser (caixin.com: 229 of the feed's 6,300 characters). Cards keep the
// feed's content (feeds.js cleans it), and the reader shows whichever is longer, or the
// feed's text when the page fails to load.
const RSS_READER_FETCH = `
        // Self-hosting (transform.js): the feed's own text when it is longer than the page's.
        async function rkReaderFetch(article, input, init) {
            var feedHtml = (article && article.rkContent) || '';
            var page = null;
            try {
                var res = await fetch(input, init);
                if (!feedHtml) return res;
                if (res.ok) page = await res.json();
            } catch (e) {
                if (!feedHtml) throw e;
            }
            var pageText = page ? String(page.textContent || page.content || '').replace(/<[^>]*>/g, '') : '';
            var data = feedHtml.replace(/<[^>]*>/g, '').length > pageText.length
                ? { title: article.title, siteName: article.source, content: feedHtml }
                : page;
            return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        async function openArticle(articleOrUrl) {`;

function patchRssReader(html) {
    html = html.replace('snippet: stripHtml(item.description || item.content || ""),',
        'snippet: stripHtml(item.description || item.content || ""),\n                            rkContent: item.content || "",');
    html = html.replace('\n        async function openArticle(articleOrUrl) {', RSS_READER_FETCH);
    return html.replace('const res = await fetch(`${READER_WORKER_URL}/?url=${encodeURIComponent(url)}`, {',
        'const res = await rkReaderFetch(article, `${READER_WORKER_URL}/?url=${encodeURIComponent(url)}`, {');
}

// The old-browser redirect sends Kobo / old Kindles to lite.rekindle.ink and
// legacy.rekindle.ink. Those builds are served from /lite/ and /legacy/ here.
// The hostname stays in the script as a string the page turns into the path when
// it runs: the build strips the redirect from the lite/legacy copies by that name,
// and (since 2026-10) checks the minified main page still routes Kobo -> legacy and
// old Kindles -> lite, so a comment (minified away) no longer does.
function rewriteTrafficCop(code) {
    return code
        .replace(/(['"])https:\/\/legacy\.rekindle\.ink\/?\1/g, (m, q) => `${m}.replace(${m}, ${q}/legacy/${q})`)
        .replace(/(['"])https:\/\/lite\.rekindle\.ink\/?\1/g, (m, q) => `${m}.replace(${m}, ${q}/lite/${q})`);
}

export const TEXT_SIZE_HEAD = '<link rel="stylesheet" href="css/rk-text.css">' +
    '<script>try{var rkT=localStorage.getItem("rk_text_size"),rkD=document.documentElement;if(rkT&&rkT!=="1"){' +
    'rkD.style.setProperty("--rk-text",rkT);rkD.setAttribute("data-rk-text",rkT);' +
    'rkD.setAttribute("data-rk-page",(location.pathname.split("/").pop()||"index").replace(/\\.html$/,""))}}catch(e){}</script>';

export function noticePage(title, message) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
body { background: #e5e5e5; font-family: "Geneva", "Verdana", sans-serif; margin: 0; padding: 40px 16px; }
.box { max-width: 420px; margin: 0 auto; background: #fff; border: 2px solid #000; box-shadow: 4px 4px 0 #000; padding: 20px; }
h1 { font-size: 1.2rem; margin: 0 0 12px; }
a { color: #000; font-weight: bold; }
</style>
</head>
<body>
<div class="box">
<h1>${title}</h1>
<p>${message}</p>
<p><a href="index.html">Back to ReKindle</a></p>
</div>
</body>
</html>
`;
}

// Chinese text in the Kindle's Chinese font (STHeiti) instead of its Japanese one. The
// Kindle browser draws Chinese with the Japanese font unless a page names a Chinese font
// (lang="zh" changes nothing), but it does try every family in a font list before that
// fallback, generic families included. So STHeiti goes at the END of every font list
// that ends with a generic family: Latin text keeps its fonts (they come first), and
// characters none of them has, Chinese, are drawn in STHeiti. Checked on the owner's
// Kindle Scribe 2026-10-10 (selfhost/AGENTS.md, "Chinese text"). The insertion is right
// after the generic keyword, which always sits inside the CSS text (a style block, a
// style attribute or a JS string), so quoting and syntax are unchanged; lists that
// already go on after the generic, inherit and var() values are left alone. Idempotent.
const HEITI_RE = /((?<![-\w.$])(?:font-family|font|--[\w-]*font[\w-]*)\s*:\s*[^;{}\n]*?\b(?:sans-serif|serif|monospace|cursive|fantasy|system-ui))(?![-\w])(?=\s*(?:!important\s*)?(?:[;}"'`\n]|$))/gi;
export function addHeiti(text) {
    return text.replace(HEITI_RE, '$1, STHeiti');
}

// Form controls don't inherit the page's font (the browser gives them its own), so a
// page that doesn't style them gets this; any page rule comes later and wins.
const HEITI_HEAD = '<style>input,textarea,select,button{font-family:sans-serif, STHeiti}</style>';

export function transformHtml(html, fileName) {
    const base = fileName.split('/').pop();
    if (DISABLED_PAGES.includes(base)) {
        return noticePage('Not available', 'Chat and online multiplayer are turned off on this ReKindle server.');
    }
    const paused = PAUSED_APPS[base.replace(/\.html$/, '')];
    if (paused) return noticePage('Not available', paused);
    if (base === 'pay.html') {
        return noticePage('ReKindle+', 'ReKindle+ subscriptions are not sold on this self-hosted server; its owner decides whether ReKindle+ apps are available. If you enjoy ReKindle, consider supporting its creator at <a href="https://rekindle.ink">rekindle.ink</a>.');
    }

    let first = true;
    html = html.replace(FIREBASE_TAG, (tag) => {
        if (!first) return '';
        first = false;
        // Drop the Subresource Integrity hash: it pins Google's file, not ours.
        return tag.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[^"']+/, 'rk-backend.js')
            .replace(/\s+integrity\s*=\s*(["'])[^"']*\1/i, '')
            .replace(/\s+crossorigin(\s*=\s*(["'])[^"']*\2)?/i, '');
    });
    html = html.replace(COUNTER_TAG, '');
    html = addHeiti(html);
    html = html.replace(/<head(\s[^>]*)?>/i, (tag) => tag + HEITI_HEAD);
    html = rewriteWorkerUrls(html);
    html = rewriteRss2json(html);
    html = rewriteTrafficCop(html);

    // No tap highlight: the browser paints a translucent box over whatever was tapped,
    // which e-ink shows as a flash (e.g. the Manga reader's invisible next-page area,
    // the right 70% of the screen). Buttons keep their own :active styles.
    html = html.replace(/<\/head>/i, '<style>html{-webkit-tap-highlight-color:rgba(0,0,0,0)}</style>\n</head>');

    // Text Size (Settings > Accessibility): set --rk-text before the page draws, and
    // css/rk-text.css multiplies it into each app's reading text. Font sizes only, no zoom.
    html = html.replace(/<\/head>/i, `${TEXT_SIZE_HEAD}\n</head>`);

    if (base === 'settings.html') html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-textsize.js"></script>\n</body>');
    if (base === 'settings.html') {
        // Settings loads the account's settings once sign-in completes (a second or two on
        // the Kindle) and applies them over the page. A change made before that was lost:
        // saved only on the device (no account yet), or overwritten by the older account
        // copy arriving afterwards; the owner saw Display Mode "not properly saved". Changes
        // made until the account's settings have been applied are remembered and then made
        // again through the page's own controls, which saves them to the account.
        html = html.replace(/<\/head>/i, SETTINGS_GUARD + '</head>');
        html = html.replace(
            "function loadCloudSettings() {\n            db.collection('users').doc(currentUser.uid).collection('settings').doc('general').get().then(doc => {",
            "function loadCloudSettings() {\n            db.collection('users').doc(currentUser.uid).collection('settings').doc('general').get()" +
            ".then(function (doc) { var g = window.rkSettingsGuard; if (g) { g.applying = true; setTimeout(function () { g.applying = false; g.finish(); }, 0); } return doc; }," +
            " function (e) { var g = window.rkSettingsGuard; if (g) setTimeout(g.finish, 0); throw e; }).then(doc => {");
        html = html.replace(
            `document.getElementById('auth-status').innerText = "Guest Mode";`,
            `document.getElementById('auth-status').innerText = "Guest Mode"; if (window.rkSettingsGuard) window.rkSettingsGuard.finish();`);
    }

    // Page Up / Page Down buttons on every page that scrolls (selfhost/site/js/rk-pager.js).
    html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-pager.js"></script>\n</body>');

    if (base === 'index.html' || base === 'index_old.html') {
        html = html.replace(/<\/head>/i, '<style>#live-games-section{display:none !important}</style>\n</head>');
        // The home screen copies the account's settings (users/{uid}/settings/general)
        // into the browser when Settings signals a change, or when this browser has
        // never synced (e.g. after the Kindle wiped its data), but it skipped several
        // of the fields Settings saves, so those stayed at their defaults (Display Mode
        // "Reduce flashing" among them). It now restores all of them, plus this server's
        // Text Size and Page Buttons.
        html = html.replace("if (serverTimestamp) localStorage.setItem('rekindle_settings_last_sync', serverTimestamp.toString());",
            "if (data.displayMode) { localStorage.setItem('rekindle_display_mode', data.displayMode); if (window.rekindleInjectEInkStyles) window.rekindleInjectEInkStyles(); }\n" +
            "                    if (data.opendyslexicFont !== undefined) { localStorage.setItem('rekindle_font_opendyslexic', data.opendyslexicFont); if (window.rekindleApplyFont) window.rekindleApplyFont(); }\n" +
            "                    if (data.scaleAuto !== undefined) localStorage.setItem('rekindle_scale_auto', data.scaleAuto ? 'true' : 'false');\n" +
            "                    if (data.scale) localStorage.setItem('rekindle_scale', data.scale);\n" +
            "                    if ((data.scaleAuto !== undefined || data.scale) && window.rekindleApplyScale) window.rekindleApplyScale();\n" +
            "                    if (data.homeLayout) localStorage.setItem('rekindle_layout', data.homeLayout);\n" +
            "                    if (data.timezoneOffset !== undefined && data.timezoneOffset !== null) localStorage.setItem('rekindle_timezone_offset', data.timezoneOffset);\n" +
            "                    if (data.rkTextSize) localStorage.setItem('rk_text_size', data.rkTextSize);\n" +
            "                    if (data.rkPageButtons) localStorage.setItem('rk_page_buttons', data.rkPageButtons);\n" +
            "                    if (data.rkMangaBlank) localStorage.setItem('rk_manga_blank', data.rkMangaBlank);\n" +
            "                    if (data.rkSubstackMargin) localStorage.setItem('rk_substack_margin', data.rkSubstackMargin);\n" +
            "                    if (serverTimestamp) localStorage.setItem('rekindle_settings_last_sync', serverTimestamp.toString());");
    }
    if (base === 'notes.html') {
        // Live sync and merging when a note is open in two browsers (selfhost/site/js/rk-notes-sync.js),
        // a stopwatch in the editor toolbar (selfhost/site/js/rk-notes-stopwatch.js), and Markdown
        // plus the agent upload link (selfhost/site/js/rk-notes-markdown.js).
        html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-notes-sync.js"></script>\n<script src="js/rk-notes-stopwatch.js"></script>\n<script src="js/rk-notes-markdown.js"></script>\n</body>');
    }
    if (base === 'minesweeper.html') {
        // Long press to flag (selfhost/site/js/rk-minesweeper.js).
        html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-minesweeper.js"></script>\n</body>');
    }
    if (base === 'rssreader.html') html = patchRssReader(html);
    if (base === 'substack.html') {
        // Font and formatting of the article view (selfhost/site/css/rk-substack.css).
        // CSS is cached for a day (static.js): bump ?v= whenever that file changes.
        html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="css/rk-substack.css?v=5">\n</head>');
        // Side margins of the article (Settings > Accessibility, "Substack: Side Margins",
        // rk-textsize.js): px per side in localStorage rk_substack_margin, set as
        // --rk-substack-margin before the page draws; rk-substack.css uses it.
        html = html.replace(/<\/head>/i, '<script>try{var rkM=localStorage.getItem("rk_substack_margin");' +
            'if(/^\\d+$/.test(rkM||""))document.documentElement.style.setProperty("--rk-substack-margin",rkM+"px")}catch(e){}</script>\n</head>');
        // Publication addresses can be bare domains ("newsletter.example.com"), which
        // made `new URL()` throw and the publication drop out of the feed.
        html = html.replace('async function apiCall(endpoint, options = {}) {',
            'function rkAbsUrl(u) { return /^https?:\\/\\//i.test(u) ? u : \'https://\' + u; }\n' +
            // Older images point at Heroku "bucketeer" S3 buckets that now answer 403 (e.g.
            // Noahpinion's logo); the same files are on substack-post-media.
            '        function rkFixImages(text) { return text.replace(/https:\\/\\/bucketeer-[a-z0-9-]+\\.s3\\.amazonaws\\.com\\//g, \'https://substack-post-media.s3.amazonaws.com/\'); }\n' +
            // rss_icon.png does not exist in ReKindle; a missing icon becomes an outlined square, once.
            '        function rkNoIcon(img) { img.onerror = null; img.src = \'data:image/svg+xml;charset=utf-8,\' + encodeURIComponent(\'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="1" y="1" width="30" height="30" fill="#fff" stroke="#000" stroke-width="2"/></svg>\'); }\n\n' +
            '        async function apiCall(endpoint, options = {}) {');
        html = html.replace('return await res.json();', 'return JSON.parse(rkFixImages(await res.text()));');
        html = html.split('onerror="this.src=\'rss_icon.png\'"').join('onerror="rkNoIcon(this)"');
        html = html.replace(' || pub.cover_photo_url || "rss_icon.png";', ' || pub.cover_photo_url || "";');
        html = html.replace('new URL(resolvedBase)', 'new URL(rkAbsUrl(resolvedBase))');
        html = html.replace('new URL(baseUrl)', 'new URL(rkAbsUrl(baseUrl))');
        // Full articles: a publication's own domain (e.g. sinocism.com) does not know the
        // reader's substack.com login and sends only the free preview of paid posts (the
        // owner saw 1,300 of 16,700 words). substack.com/api/v1/posts/by-id/<id> does.
        html = html.replace(
            "                let data;\n                try {\n                    data = await apiCall(`/posts/${id}`, { headers: { 'X-Substack-Target': targetDomain } });\n                } catch (err1) {",
            "                let data = null;\n" +
            "                try {\n" +
            "                    const full = await apiCall(`/posts/by-id/${id}`);\n" +
            "                    data = full && (full.post || full);\n" +
            "                    if (!data || !data.body_html) data = null;\n" +
            "                } catch (err0) { data = null; }\n" +
            "                if (!data) try {\n" +
            "                    data = await apiCall(`/posts/${id}`, { headers: { 'X-Substack-Target': targetDomain } });\n" +
            "                } catch (err1) {");
    }
    if (base === 'manga.html') {
        // Upstream switched the Manga app off with an immediate redirect; turn it back
        // on and add the Manhuagui source (selfhost/site/js/rk-manga-sources.js).
        html = html.replace(/<script>\s*window\.location\.replace\(['"]index['"]\);?\s*<\/script>/, '');
        html = html.replace(/<\/body>/i, '<script src="js/rk-manga-sources.js"></script>\n</body>');
        // Its title key (manga.title) now says "Comics" for upstream's separate Comics
        // app, so both apps looked the same; keep this one's title "Manga".
        html = html.replace(/(<span[^>]*id="app-title")\s+data-i18n="manga\.title"/, '$1');
        // Store cards open the reader when tapped (only + Add did anything); the add-on
        // does the same for Manhuagui's cards.
        html = html.replace(/(const isAdded = library\.some\(libItem => libItem\.id === manga\.id\);\s*const card = document\.createElement\('div'\);\s*card\.className = 'card';)/,
            "$1\n                    card.onclick = () => openReader({ id: manga.id, title: title, cover: coverUrl, type: 'manga', author: manga.attributes.status });");
    }
    return html;
}

// Settings page (see transformHtml): remembers setting changes made before the account's
// settings have been applied, then makes them again through the page's own controls.
const SETTINGS_GUARD = `<script>
(function () {
    var g = window.rkSettingsGuard = { done: false, applying: false, replaying: false, pending: {} };
    document.addEventListener('change', function (e) {
        var el = e.target;
        if (g.done || g.applying || g.replaying || !el || !el.id || !/^(SELECT|INPUT)$/.test(el.tagName)) return;
        if (!el.closest || !el.closest('.setting-row')) return;
        g.pending[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }, true);
    g.finish = function () {
        if (g.done) return;
        g.done = true;
        Object.keys(g.pending).forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            if (el.type === 'checkbox') el.checked = g.pending[id]; else el.value = g.pending[id];
            g.replaying = true;
            try { el.dispatchEvent(new Event('change', { bubbles: true })); } finally { g.replaying = false; }
        });
        g.pending = {};
    };
})();
</script>
`;

const ICONS_FILTER = `

// --- Self-hosted ReKindle: hide apps that need the central chat/multiplayer services,
// bring back the Manga app (upstream commented it out) and add Hacker News ---
(function () {
    var off = ${JSON.stringify(DISABLED_APPS.concat(Object.keys(PAUSED_APPS)))};
    var lists = [];
    if (typeof APPS !== 'undefined') lists.push(APPS);
    if (typeof APPS_BETA !== 'undefined') lists.push(APPS_BETA);
    for (var l = 0; l < lists.length; l++) {
        for (var i = lists[l].length - 1; i >= 0; i--) {
            var a = lists[l][i];
            if (off.indexOf(a.id) !== -1 || a.live || a.cat === 'live_game') lists[l].splice(i, 1);
        }
    }
    if (typeof APPS !== 'undefined' && !APPS.some(function (a) { return a.id === 'manga'; })) {
        APPS.push({
            id: 'manga',
            name: 'Manga',
            cat: 'lifestyle',
            desc: 'Read manga from MangaDex and Manhuagui.',
            icon: '<path d="M6 4 h12 v24 h-12 z M18 4 l8 4 v20 l-8 -4 M18 4 v24" fill="none" stroke="black" stroke-width="2"/><line x1="8" y1="8" x2="16" y2="8" stroke="black" stroke-width="1.5"/><line x1="8" y1="12" x2="16" y2="12" stroke="black" stroke-width="1.5"/><line x1="8" y1="16" x2="14" y2="16" stroke="black" stroke-width="1.5"/>'
        });
    }
    if (typeof APPS !== 'undefined' && !APPS.some(function (a) { return a.id === 'zlibrary'; })) {
        APPS.push({
            id: 'zlibrary', name: 'Z-Library', cat: 'lifestyle',
            desc: 'Explore popular books, search Z-Library and save books for later.',
            icon: '<path d="M4 5 H14 L16 7 L18 5 H28 V26 H18 L16 28 L14 26 H4 Z M16 7 V28 M7 10 H12 M7 15 H12 M20 10 H25 M20 15 H25" fill="none" stroke="black" stroke-width="2"/>'
        });
    }
    // Hacker News reader added by this server (selfhost/site/hackernews.html).
    if (typeof APPS !== 'undefined' && !APPS.some(function (a) { return a.id === 'hackernews'; })) {
        APPS.push({
            id: 'hackernews',
            name: 'Hacker News',
            cat: 'lifestyle',
            desc: 'Top stories and discussions from Hacker News.',
            icon: '<rect x="5" y="5" width="22" height="22" fill="none" stroke="black" stroke-width="2"/><path d="M11 10 L16 17 L21 10 M16 17 V23" fill="none" stroke="black" stroke-width="2.5"/>'
        });
    }
})();
`;

export function transformJs(code, fileName) {
    const base = fileName.split('/').pop();
    code = rewriteWorkerUrls(code);
    code = rewriteRss2json(code);
    code = addHeiti(code);
    if (base === 'icons.js' || base === 'icons-beta.js') code += ICONS_FILTER;
    if (base === 'emoji-render.js') {
        // renderEmojis() scans any text with a character above U+2600 (Chinese text
        // counts), then swapped every character in the OpenMoji map for a picture,
        // including plain "-" (002D), ©, ™ and arrows: "re-lending" next to Chinese
        // showed a black bar. A single character is swapped only if it is above U+2600
        // itself (the renderer's own emoji test); sequences (keycaps, ZWJ, FE0F) still are.
        code = code.replace('if (EMOJI_SVG_MAP[substr]) {',
            'if (EMOJI_SVG_MAP[substr] && (len > 1 || substr.codePointAt(0) >= 0x2600)) {');
    }
    return code;
}
