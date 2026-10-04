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

function fixTranslationFallbacks(code) {
    return code.replace(T_OR_FALLBACK, (m, q, key, fallback) => `window.t(${q}${key}${q}, ${fallback})`);
}

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
    if (base === 'pay.html') {
        return noticePage('ReKindle+', 'ReKindle+ features are included for every account on this server. If you enjoy ReKindle, consider supporting its creator at <a href="https://rekindle.ink">rekindle.ink</a>.');
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

    if (base === 'index.html' || base === 'index_old.html') {
        html = html.replace(/<\/head>/i, '<style>#live-games-section{display:none !important}</style>\n</head>');
    }
    if (base === 'manga.html') {
        // Upstream switched the Manga app off with an immediate redirect; turn it back
        // on and add the Manhuagui source (selfhost/site/js/rk-manga-sources.js).
        html = html.replace(/<script>\s*window\.location\.replace\(['"]index['"]\);?\s*<\/script>/, '');
        html = html.replace(/<\/body>/i, '<script src="js/rk-manga-sources.js"></script>\n</body>');
    }
    return html;
}

const ICONS_FILTER = `

// --- Self-hosted ReKindle: hide apps that need the central chat/multiplayer services,
// bring back the Manga app (upstream commented it out) and add Hacker News ---
(function () {
    var off = ${JSON.stringify(DISABLED_APPS)};
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
    return code;
}
