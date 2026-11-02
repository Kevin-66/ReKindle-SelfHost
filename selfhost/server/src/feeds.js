// api.rss2json.com, which upstream's RSS reader and Newspaper fetch every feed
// through, served here at /__rk/rss2json in the same JSON (transform.js points the
// pages at it). rss2json refused feeds over about 10 MB (the owner's 1000-item
// CaiXin feed, 2026-11-02) and, without an API key, the `count` parameter, so the
// reader's "Load more" always failed.

import { DOMParser, parseHTML } from 'linkedom';
import { withPublicNetworkOnly } from './netguard.js';

const MAX_FEED_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
// "Load more" asks again with count + 10, so a parsed feed is kept for a while.
const CACHE_MS = 5 * 60 * 1000;
const CACHE_BYTES = 96 * 1024 * 1024; // by feed size
const cache = new Map(); // url -> { expires, bytes, parsed: Promise<{ feed, items }> }
let cacheBytes = 0;

class FeedError extends Error {}

export async function handleFeed(req, res, url) {
    let body;
    try {
        const feedUrl = feedAddress(url.searchParams.get('rss_url'));
        const count = parseInt(url.searchParams.get('count'), 10);
        const { feed, items } = await cached(feedUrl);
        body = { status: 'ok', feed: { url: feedUrl, ...feed }, items: items.slice(0, count > 0 ? count : 10).map(cleanItem) };
    } catch (e) {
        if (!(e instanceof FeedError)) console.error('[feeds]', e);
        body = { status: 'error', message: e instanceof FeedError ? e.message : 'Cannot download this RSS feed, make sure the Rss URL is correct.' };
    }
    res.writeHead(body.status === 'ok' ? 200 : 422, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
}

function feedAddress(value) {
    let u;
    try { u = new URL(String(value || '').trim()); } catch { u = null; }
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new FeedError('rss_url parameter is required and must be an http(s) address.');
    return u.href;
}

function cached(feedUrl) {
    const now = Date.now();
    for (const [k, e] of cache) if (e.expires <= now) drop(k);
    let entry = cache.get(feedUrl);
    if (!entry) {
        entry = { expires: now + CACHE_MS, bytes: 0, parsed: null };
        entry.parsed = download(feedUrl).then((xml) => {
            if (cache.get(feedUrl) === entry) {
                entry.bytes = xml.length;
                cacheBytes += xml.length;
                for (const k of cache.keys()) {
                    if (cacheBytes <= CACHE_BYTES) break;
                    if (k !== feedUrl) drop(k);
                }
            }
            return parseFeed(xml);
        });
        entry.parsed.catch(() => { if (cache.get(feedUrl) === entry) drop(feedUrl); });
        cache.set(feedUrl, entry);
    }
    return entry.parsed;
}

function drop(key) {
    cacheBytes -= cache.get(key).bytes;
    cache.delete(key);
}

async function download(feedUrl) {
    let res;
    try {
        res = await withPublicNetworkOnly(() => fetch(feedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ReKindle feed reader)',
                Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8'
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        }));
    } catch {
        throw new FeedError('Cannot download this RSS feed, make sure the Rss URL is correct.');
    }
    if (!res.ok) {
        res.body?.cancel().catch(() => {});
        throw new FeedError(`Cannot download this RSS feed: it answered HTTP ${res.status}.`);
    }
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
        size += c.length;
        if (size > MAX_FEED_BYTES) throw new FeedError(`This RSS feed is over ${MAX_FEED_BYTES / 1024 / 1024} MB.`);
        chunks.push(c);
    }
    return decode(Buffer.concat(chunks), res.headers.get('content-type'));
}

// The HTTP charset wins, then the XML declaration's encoding (GBK and Big5 feeds exist).
export function decode(buf, contentType) {
    const label = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1] ||
        /^\s*<\?xml[^>]*\bencoding=["']([\w-]+)/i.exec(buf.subarray(0, 200).toString('latin1'))?.[1];
    try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

// ---------------------------------------------------------------- cleaning

// Feed HTML reaches the pages as HTML: the reader shows an article's own text from the
// feed (transform.js rkReaderFetch) in a same-origin frame, and both pages read
// descriptions through innerHTML for pictures. So scripts, frames, forms, styles and
// event handlers go, and so do javascript: addresses.
const UNSAFE = 'script, style, iframe, frame, frameset, object, embed, applet, form, input, button, textarea, select, link, meta, base, noscript, template';
const scratch = parseHTML('<!doctype html><html><body></body></html>').document;
const cleaned = new WeakMap(); // parsed item -> cleaned copy, while the feed is cached

export function cleanHtml(html) {
    if (!html || !html.includes('<')) return html;
    const box = scratch.createElement('div');
    box.innerHTML = html;
    for (const el of box.querySelectorAll(UNSAFE)) el.remove();
    for (const el of box.querySelectorAll('*')) {
        for (const name of el.getAttributeNames()) {
            const value = el.getAttribute(name).replace(/[\s\0-\x1f]/g, '');
            if (/^on/i.test(name) || /^(javascript|vbscript|data:text\/html)/i.test(value)) el.removeAttribute(name);
        }
    }
    return box.innerHTML;
}

function cleanItem(item) {
    let c = cleaned.get(item);
    if (!c) {
        c = { ...item, description: cleanHtml(item.description), content: cleanHtml(item.content) };
        cleaned.set(item, c);
    }
    return c;
}

// ---------------------------------------------------------------- parsing

const nameOf = (el) => el.nodeName.toLowerCase();
const child = (el, ...names) => (el ? [...el.children].find((c) => names.includes(nameOf(c))) : null) || null;
const children = (el, name) => (el ? [...el.children].filter((c) => nameOf(c) === name) : []);
const text = (el) => (el ? el.textContent.trim() : '');
const attr = (el, name) => (el && el.getAttribute(name)) || '';

// RSS 2.0, RSS 1.0 (RDF) or Atom -> { feed, items } in rss2json's fields, items in feed order.
export function parseFeed(xml) {
    const root = new DOMParser().parseFromString(xml, 'text/xml').documentElement;
    const kind = root ? nameOf(root) : '';
    if (kind === 'feed') return parseAtom(root);
    if (kind === 'rss' || kind === 'rdf:rdf') return parseRss(root);
    throw new FeedError('Feed could not be converted, probably not a valid RSS feed.');
}

function parseRss(root) {
    const channel = child(root, 'channel');
    const feed = {
        title: text(child(channel, 'title')),
        link: text(child(channel, 'link')),
        author: text(child(channel, 'managingeditor', 'dc:creator')),
        description: text(child(channel, 'description')),
        image: text(child(child(channel, 'image'), 'url')) || attr(child(channel, 'itunes:image'), 'href')
    };
    // RSS 1.0 puts its items next to the channel, not in it.
    const items = [...root.getElementsByTagName('item')].map((it) => {
        const description = text(child(it, 'description'));
        const guid = text(child(it, 'guid'));
        const enc = child(it, 'enclosure');
        const enclosure = enc ? { link: attr(enc, 'url'), type: attr(enc, 'type'), length: Number(attr(enc, 'length')) || 0 } : {};
        return {
            title: text(child(it, 'title')),
            pubDate: formatDate(text(child(it, 'pubdate', 'dc:date'))),
            link: text(child(it, 'link')) || (/^https?:\/\//.test(guid) ? guid : ''),
            guid: guid || text(child(it, 'link')),
            author: text(child(it, 'dc:creator', 'author')),
            thumbnail: thumbnail(it, enclosure),
            description,
            content: text(child(it, 'content:encoded')) || description,
            enclosure,
            categories: children(it, 'category').map(text).filter(Boolean)
        };
    });
    return { feed, items };
}

function parseAtom(root) {
    const feed = {
        title: text(child(root, 'title')),
        link: atomLink(root),
        author: text(child(child(root, 'author'), 'name')),
        description: text(child(root, 'subtitle')),
        image: text(child(root, 'logo', 'icon'))
    };
    const items = children(root, 'entry').map((it) => {
        const enc = children(it, 'link').find((l) => attr(l, 'rel') === 'enclosure');
        const enclosure = enc ? { link: attr(enc, 'href'), type: attr(enc, 'type'), length: Number(attr(enc, 'length')) || 0 } : {};
        const summary = atomText(child(it, 'summary'));
        return {
            title: text(child(it, 'title')),
            pubDate: formatDate(text(child(it, 'published', 'updated'))),
            link: atomLink(it),
            guid: text(child(it, 'id')),
            author: text(child(child(it, 'author'), 'name')),
            thumbnail: thumbnail(it, enclosure),
            description: summary,
            content: atomText(child(it, 'content')) || summary,
            enclosure,
            categories: children(it, 'category').map((c) => attr(c, 'term') || text(c)).filter(Boolean)
        };
    });
    return { feed, items };
}

function atomLink(el) {
    const links = children(el, 'link');
    const alt = links.find((l) => !attr(l, 'rel') || attr(l, 'rel') === 'alternate') || links[0];
    return attr(alt, 'href');
}

function atomText(el) {
    if (!el) return '';
    return attr(el, 'type') === 'xhtml' ? (child(el, 'div') || el).innerHTML.trim() : text(el);
}

// media:thumbnail, an image media:content (also inside a media:group, as on YouTube),
// or an image enclosure.
function thumbnail(it, enclosure) {
    const media = (n) => [...it.getElementsByTagName(n)];
    const thumb = media('media:thumbnail').find((m) => attr(m, 'url'));
    if (thumb) return attr(thumb, 'url');
    const image = media('media:content').find((m) => attr(m, 'medium') === 'image' || /^image\//.test(attr(m, 'type')));
    if (image && attr(image, 'url')) return attr(image, 'url');
    return /^image\//.test(enclosure.type || '') ? enclosure.link : '';
}

// rss2json's "YYYY-MM-DD HH:MM:SS" in UTC: the reader turns "-" into "/" and adds
// " UTC" before parsing it, for the Kindle's browser.
export function formatDate(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return value;
    return d.toISOString().replace('T', ' ').slice(0, 19);
}
