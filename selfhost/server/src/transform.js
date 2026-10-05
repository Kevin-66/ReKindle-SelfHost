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
// Quoted literals become an absolute URL built at runtime, so `new URL(...)` keeps working.
function rewriteWorkerUrls(code) {
    code = code.replace(/(['"`])https:\/\/([a-z0-9-]+)\.timjarnott\.workers\.dev([^'"`\n]*)\1/g,
        (m, q, sub, rest) => `(location.protocol + '//' + location.host + ${q}/__rk/w/${workerName(sub)}${rest}${q})`);
    return code.replace(/https:\/\/([a-z0-9-]+)\.timjarnott\.workers\.dev/g, (m, sub) => `/__rk/w/${workerName(sub)}`);
}

// The old-browser redirect sends Kobo / old Kindles to lite.rekindle.ink and
// legacy.rekindle.ink. Those builds are served from /lite/ and /legacy/ here.
// The comment keeps the hostname in the script so the build still strips the
// redirect from the lite/legacy copies.
function rewriteTrafficCop(code) {
    return code
        .replace(/(['"])https:\/\/legacy\.rekindle\.ink\/?\1/g, (m, q) => `${q}/legacy/${q} /* legacy.rekindle.ink lite.rekindle.ink */`)
        .replace(/(['"])https:\/\/lite\.rekindle\.ink\/?\1/g, (m, q) => `${q}/lite/${q} /* lite.rekindle.ink */`);
}

// `window.t('key') || 'Text'` never reaches 'Text': before the language file has
// loaded (pages often draw first), window.t returns the key itself, so screens show
// "manga.btn.continue". window.t takes the fallback as its second argument. Only a
// lone fallback literal that ends the expression is moved, so `|| 'a' + b` is left alone.
const T_OR_FALLBACK = /window\.t\((['"])([\w.-]+)\1\)\s*\|\|\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")(?=\s*[),;:}\]\n])/g;
// The other common form, `window.t ? window.t('key') : 'Text'` (388 places in 53 apps,
// e.g. Breathing's "BREATHING.STEP.INHALE"), has the same problem: window.t always
// exists, so the fallback only ever applies when i18n.js is missing.
const T_TERNARY = /window\.t\s*\?\s*window\.t\((['"])([\w.-]+)\1\)\s*:\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")(?=\s*[),;:}\]\n])/g;

function fixTranslationFallbacks(code) {
    return code
        .replace(T_OR_FALLBACK, (m, q, key, fallback) => `window.t(${q}${key}${q}, ${fallback})`)
        .replace(T_TERNARY, (m, q, key, fallback) => `window.t ? window.t(${q}${key}${q}, ${fallback}) : ${fallback}`);
}

// Dark mode before the first paint. theme.js turns dark mode on only once it has
// downloaded and run (the server makes the browser recheck it on every page), and
// Settings loads it at the end of the page, so pages first appeared light: a white
// flash on every page turn, which e-ink shows as a full redraw. This runs first in
// <head>, with no download, and adds the same style element theme.js would
// (id rekindle-dark-theme, same rules: keep in sync with injectDarkStyles in
// theme.js), so theme.js finds it already there and can still remove it for light.
const DARK_CSS =
    ':root[data-theme="dark"]{background-color:#ffffff;background-image:var(--rk-wallpaper,none);' +
    'background-size:var(--rk-wallpaper-size,auto);color:#000000;min-height:100%;filter:invert(1) hue-rotate(180deg);}' +
    ':root[data-theme="dark"] img,:root[data-theme="dark"] video,:root[data-theme="dark"] canvas,' +
    ':root[data-theme="dark"] .no-invert{filter:invert(1) hue-rotate(180deg);}' +
    ':root[data-theme="dark"] img.keep-white{filter:none;}';

export const DARK_HEAD = '<script>(function(){try{var m=localStorage.getItem("rekindle_theme_mode")||"light",d=m==="dark";' +
    'if(m==="auto"){var n=new Date(),h=n.getHours(),o=parseFloat(localStorage.getItem("rekindle_timezone_offset"));' +
    'if(!isNaN(o))h=Math.floor((((n.getUTCHours()+n.getUTCMinutes()/60+o)%24)+24)%24);' +
    'd=h>=18||h<6||!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);}' +
    'if(!d)return;var r=document.documentElement;r.style.colorScheme="light";r.setAttribute("data-theme","dark");' +
    'var s=document.createElement("style");s.id="rekindle-dark-theme";s.appendChild(document.createTextNode(' +
    JSON.stringify(DARK_CSS) + '));(document.head||r).appendChild(s);}catch(e){}})();</script>';

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
    html = rewriteWorkerUrls(html);
    html = rewriteTrafficCop(html);
    html = fixTranslationFallbacks(html);

    // No tap highlight: the browser paints a translucent box over whatever was tapped,
    // which e-ink shows as a flash (e.g. the Manga reader's invisible next-page area,
    // the right 70% of the screen). Buttons keep their own :active styles.
    html = html.replace(/<\/head>/i, '<style>html{-webkit-tap-highlight-color:rgba(0,0,0,0)}</style>\n</head>');

    // Text Size (Settings > Accessibility): set --rk-text before the page draws, and
    // css/rk-text.css multiplies it into each app's reading text. Font sizes only, no zoom.
    html = html.replace(/<\/head>/i, `${TEXT_SIZE_HEAD}\n</head>`);

    // Dark mode from the first paint (no white flash): first thing in <head>.
    html = html.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n${DARK_HEAD}`);
    if (base === 'settings.html') html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-textsize.js"></script>\n</body>');

    // Page Up / Page Down buttons on every page that scrolls (selfhost/site/js/rk-pager.js).
    html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-pager.js"></script>\n</body>');

    // Chinese text in the Kindle's Chinese fonts, not its Japanese one (selfhost/site/js/rk-cjk.js).
    html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-cjk.js"></script>\n</body>');

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
            "                    if (serverTimestamp) localStorage.setItem('rekindle_settings_last_sync', serverTimestamp.toString());");
    }
    if (base === 'notes.html') {
        // Live sync and merging when a note is open in two browsers (selfhost/site/js/rk-notes-sync.js),
        // and a stopwatch in the editor toolbar (selfhost/site/js/rk-notes-stopwatch.js).
        html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-notes-sync.js"></script>\n<script src="js/rk-notes-stopwatch.js"></script>\n</body>');
    }
    if (base === 'minesweeper.html') {
        // Long press to flag (selfhost/site/js/rk-minesweeper.js).
        html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, '<script src="js/rk-minesweeper.js"></script>\n</body>');
    }
    if (base === 'substack.html') {
        // Font and formatting of the article view (selfhost/site/css/rk-substack.css).
        html = html.replace(/<\/head>/i, '<link rel="stylesheet" href="css/rk-substack.css">\n</head>');
        // Substack's subscriptions API changed (2026-10), which left the app's feed empty:
        // - a signed-in request without ?tvOnly= is rejected (HTTP 400 "Invalid value");
        // - publications the reader follows come back in `publications` while
        //   `subscriptions` can be empty, and the app only read `subscriptions`.
        html = html.replace(/apiCall\((['"])\/subscriptions\1\)/, "apiCall('/subscriptions?tvOnly=false')");
        html = html.replace('const rawSubs = subData.subscriptions || [];',
            'const rawSubs = (subData.subscriptions || []).slice();\n' +
            '                    (subData.publications || []).forEach(p => {\n' +
            '                        if (!rawSubs.some(s => (s.publication_id || (s.publication && s.publication.id)) == p.id)) rawSubs.push({ publication_id: p.id, publication: p });\n' +
            '                    });');
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
        // "Following" takes 15 posts from each publication, but the next batch started at
        // post 50, so posts 16-50 of every publication were never shown.
        html = html.replace('state.subOffset += 50;', 'state.subOffset += 15;');
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
    }
    return html;
}

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
    code = fixTranslationFallbacks(code);
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
