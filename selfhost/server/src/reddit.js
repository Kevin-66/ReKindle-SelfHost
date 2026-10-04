// /api/reddit for this server, in place of upstream functions/api/reddit.js
// (which stays in the repo for the Cloudflare site, but is not loaded here).
//
// Upstream's function no longer works as-is:
// - it asks old.reddit.com first, which now sends logged-out visitors to a login page;
// - it requests images with a browser's page-load headers, and Reddit's image servers
//   answer those with a redirect to an HTML viewer, so every image came back broken.
// This version reads feeds (.rss, and the .json the app falls back to) from
// www.reddit.com, fetches images as images and scales them down for e-readers, and
// moves a post's picture (and text) out of the table the app throws away in thread
// view. Reddit ends RSS on 2026-11-13: from then on a failed .rss request answers
// with an empty feed, which makes the app switch to .json (public until 2027-03).

import sharp from 'sharp';

const REDDIT = 'https://www.reddit.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FEED_TTL = 10 * 60 * 1000;
// Images are scaled down to this width (e-reader screens are ~1072-1448 px wide).
const IMAGE_MAX_WIDTH = Math.max(320, parseInt(process.env.REDDIT_IMAGE_MAX_WIDTH || '1080', 10) || 1080);
const IMAGE_MAX_BYTES = 40 * 1024 * 1024;

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'np.reddit.com', 'new.reddit.com', 'api.reddit.com']);
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)$/i;

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function escapeXml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(s) {
    return s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k === 'lt') return '<';
        if (k === 'gt') return '>';
        if (k === 'quot') return '"';
        if (k === 'apos') return "'";
        if (k === 'amp') return '&';
        const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

// ------------------------------------------------------------ images

// Where to fetch an image from (best first), or null if the URL is not one.
function imageSources(url) {
    const host = url.hostname;
    const file = url.pathname.match(/^\/([A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp|avif))$/i);
    if (host === 'i.redd.it') return [url.href];
    // Previews are resized copies of an i.redd.it original with the same name.
    if (host === 'preview.redd.it') return file ? [`https://i.redd.it/${file[1]}`, url.href] : [url.href];
    if (host === 'external-preview.redd.it' || host.endsWith('.redditmedia.com')) return [url.href];
    if (host === 'i.imgur.com') return [url.href];
    if (host === 'imgur.com' || host === 'www.imgur.com') return file ? [`https://i.imgur.com/${file[1]}`] : null;
    return null;
}

const imageCache = new Map(); // requested url -> { body, type }
let imageCacheBytes = 0;
const IMAGE_CACHE_MAX = 64 * 1024 * 1024;

// Scale to IMAGE_MAX_WIDTH and re-encode as JPEG (first frame for GIFs; e-ink
// can't animate). Keeps the original when it is already smaller.
async function shrinkImage(buf, type) {
    try {
        const out = await sharp(buf, { failOn: 'none', pages: 1, limitInputPixels: 2e8 })
            .rotate()
            .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 72, mozjpeg: true })
            .toBuffer();
        return out.length < buf.length ? { body: out, type: 'image/jpeg' } : { body: buf, type };
    } catch {
        return { body: buf, type };
    }
}

async function fetchImage(sources) {
    let status = 404;
    for (const src of sources) {
        let res;
        try {
            res = await fetch(src, {
                headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                signal: AbortSignal.timeout(30000)
            });
        } catch {
            status = 502;
            continue;
        }
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        // i.redd.it answers a missing file with a 404 placeholder PNG; status matters, not type.
        if (!res.ok || !type.startsWith('image/') || Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) {
            if (res.body) res.body.cancel().catch(() => { });
            status = res.status === 429 ? 429 : (res.ok ? 502 : res.status);
            continue;
        }
        return shrinkImage(Buffer.from(await res.arrayBuffer()), type);
    }
    throw httpError(status === 404 || status === 403 || status === 410 ? 404 : status, `Image not available (HTTP ${status})`);
}

async function serveImage(url, sources) {
    let hit = imageCache.get(url.href);
    if (hit) {
        imageCache.delete(url.href);
        imageCache.set(url.href, hit);
    } else {
        hit = await fetchImage(sources);
        imageCache.set(url.href, hit);
        imageCacheBytes += hit.body.length;
        for (const [k, v] of imageCache) {
            if (imageCacheBytes <= IMAGE_CACHE_MAX) break;
            imageCacheBytes -= v.body.length;
            imageCache.delete(k);
        }
    }
    return new Response(hit.body, {
        status: 200,
        headers: { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }
    });
}

// ------------------------------------------------------------ feeds

const feedCache = new Map(); // url -> { text, type, expires }

// Reddit allows logged-out visitors very few feed requests (in 2026-10, one a
// minute per address) and says when the next is allowed in x-ratelimit-* headers.
// Waiting for that beats a 429, which only pushes the window out.
let feedWaitUntil = 0;
const MAX_FEED_WAIT = 15 * 1000;

function noteRateLimit(res) {
    const remaining = parseFloat(res.headers.get('x-ratelimit-remaining'));
    const reset = parseFloat(res.headers.get('x-ratelimit-reset') || res.headers.get('retry-after'));
    if (res.status === 429 || remaining < 1) {
        feedWaitUntil = Date.now() + (reset > 0 ? Math.min(reset, 600) : 60) * 1000;
    }
}

function rateLimited() {
    const e = httpError(429, 'Reddit only allows a few requests a minute from this server');
    e.retryAfter = Math.max(1, Math.ceil((feedWaitUntil - Date.now()) / 1000));
    return e;
}

// One feed request at a time, so requests that waited don't all fire together.
let feedLock = Promise.resolve();

function fetchFeed(url) {
    const hit = feedCache.get(url);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit);
    const run = feedLock.then(() => fetchFeedNow(url));
    feedLock = run.catch(() => { });
    return run;
}

async function fetchFeedNow(url) {
    const hit = feedCache.get(url);
    if (hit && hit.expires > Date.now()) return hit;
    const wait = feedWaitUntil - Date.now();
    if (wait > MAX_FEED_WAIT) throw rateLimited();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 1500));
        try {
            res = await fetch(url, {
                headers: {
                    'User-Agent': UA,
                    Accept: 'application/atom+xml,application/rss+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(20000)
            });
        } catch (e) {
            res = null;
            if (attempt) throw httpError(502, `Reddit could not be reached (${e.message})`);
            continue;
        }
        if (res.status < 500) break;
    }
    noteRateLimit(res);
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    if (res.status === 429) throw rateLimited();
    if (!res.ok || /text\/html/i.test(type)) {
        throw httpError(res.ok ? 403 : res.status, `Reddit returned HTTP ${res.status}${res.ok ? ' (a web page instead of a feed)' : ''}`);
    }
    const entry = { text, type, expires: Date.now() + FEED_TTL };
    feedCache.set(url, entry);
    if (feedCache.size > 300) feedCache.delete(feedCache.keys().next().value);
    return entry;
}

// The thread view removes the first table in the post, and Reddit puts the
// post's thumbnail - and, for posts with a thumbnail, the post text - in it.
// Put the full-size picture, the text and the outside link before the table.
function showPostMedia(xml) {
    return xml.replace(/<entry>[\s\S]*?<\/entry>/, (entry) => {
        if (!/<id>t3_/.test(entry)) return entry;
        return entry.replace(/(<content type="html">)([\s\S]*?)(<\/content>)/, (all, open, raw, close) => {
            const html = unescapeXml(raw);
            const table = html.match(/<table>[\s\S]*<\/table>/);
            if (!table) return all;
            const attr = (re) => {
                const m = table[0].match(re);
                return m ? unescapeXml(m[1]) : '';
            };
            const thumb = attr(/<img src="([^"]+)"/);
            const link = attr(/<a href="([^"]+)">\[link\]<\/a>/);
            const comments = attr(/<a href="([^"]+)">\[comments\]<\/a>/);
            let linkUrl = null;
            try { linkUrl = new URL(link); } catch { }
            const linkIsImage = !!(linkUrl && imageSources(linkUrl) && (linkUrl.hostname !== 'imgur.com' || IMAGE_EXT.test(linkUrl.pathname)));
            const image = linkIsImage ? link : thumb;
            const md = table[0].match(/<!-- SC_OFF -->[\s\S]*?<!-- SC_ON -->/);
            const anchor = (href) => `<p><a href="${escapeXml(href)}">${escapeXml(href)}</a></p>`;
            let before = '';
            if (image) before += anchor(image);
            if (md) before += md[0];
            if (link && !linkIsImage && link !== comments && !/^https?:\/\/(www\.)?reddit\.com\/gallery\//.test(link)) before += anchor(link);
            if (!before) return all;
            const rest = html.replace(table[0], () => (md ? table[0].replace(md[0], '') : table[0]));
            return open + escapeXml(before + rest) + close;
        });
    });
}

const EMPTY_FEED = '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Reddit</title></feed>';

// ------------------------------------------------------------ notices

// A one-post feed the app shows like any other post, used when Reddit can't be
// reached and nothing is cached, so the app explains why instead of retrying.
export function redditNotice(targetUrl, message) {
    let url;
    try { url = new URL(targetUrl || ''); } catch { return null; }
    if (!REDDIT_HOSTS.has(url.hostname)) return null;
    const title = 'Reddit is unavailable right now';
    const updated = new Date().toISOString();
    const headers = { 'Cache-Control': 'no-store' };
    if (/\.json$/.test(url.pathname)) {
        const post = { title, author: 'ReKindle', subreddit: 'rekindle', permalink: '/r/rekindle/comments/rekindlenotice/', name: 't3_rekindlenotice', selftext_html: escapeXml(`<p>${escapeXml(message)}</p>`) };
        const body = /\/comments\//.test(url.pathname)
            ? [{ kind: 'Listing', data: { children: [{ kind: 't3', data: post }] } }, { kind: 'Listing', data: { children: [] } }]
            : { kind: 'Listing', data: { after: null, children: [{ kind: 't3', data: post }] } };
        return new Response(JSON.stringify(body), { status: 200, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
    }
    const entry = `<entry><author><name>/u/ReKindle</name></author><category term="rekindle" label="r/rekindle"/>` +
        `<content type="html">${escapeXml(`<p>${escapeXml(message)}</p>`)}</content><id>t3_rekindlenotice</id>` +
        `<link href="${REDDIT}/r/rekindle/comments/rekindlenotice/"/><updated>${updated}</updated><title>${escapeXml(title)}</title></entry>`;
    return new Response(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>ReKindle</title><updated>${updated}</updated>${entry}</feed>`,
        { status: 200, headers: { ...headers, 'Content-Type': 'application/atom+xml; charset=UTF-8' } });
}

// ------------------------------------------------------------ entry point

// Answers a URL requested through /api/reddit. Throws an Error with .status on
// failure (the caller serves the last good copy or a notice).
export async function handleReddit(targetUrl) {
    let url;
    try { url = new URL(targetUrl || ''); } catch { throw httpError(400, 'Invalid URL'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw httpError(400, 'Invalid URL');

    const sources = imageSources(url);
    if (sources) return serveImage(url, sources);
    if (!REDDIT_HOSTS.has(url.hostname)) throw httpError(403, 'Forbidden: Domain not allowed');

    const isRss = /\.rss$/.test(url.pathname);
    if (!isRss && !/\.json$/.test(url.pathname)) throw httpError(404, 'Only Reddit feeds and images are served');
    const feedUrl = REDDIT + url.pathname + url.search;
    let feed;
    try {
        feed = await fetchFeed(feedUrl);
    } catch (e) {
        // RSS gone (or blocked) but not rate-limited: an empty feed makes the app try .json.
        if (isRss && e.status && e.status !== 429 && e.status < 500) {
            return new Response(EMPTY_FEED, { status: 200, headers: { 'Content-Type': 'application/atom+xml; charset=UTF-8', 'Cache-Control': 'no-store' } });
        }
        throw e;
    }
    const body = isRss && /\/comments\//.test(url.pathname) ? showPostMedia(feed.text) : feed.text;
    return new Response(body, {
        status: 200,
        headers: { 'Content-Type': feed.type || (isRss ? 'application/atom+xml; charset=UTF-8' : 'application/json; charset=utf-8'), 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
    });
}
