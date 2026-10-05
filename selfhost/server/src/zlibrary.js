// Public catalogue only. Account actions remain on Z-Library itself.
import { parseHTML } from 'linkedom';
import { rawFetch } from './netguard.js';
import { loadBrowserCatalogue } from './zlibrary-browser.js';

export const BASE = 'https://z-lib.sk';
const BLOCKED = 'Z-Library could not be loaded by this server. Open it directly to continue browsing.';
const cache = new Map();
const pending = new Map();
const TTL = 5 * 60 * 1000;

function sourceError(message = BLOCKED, status = 502) {
    return Object.assign(new Error(message), { code: 'zlibrary/unavailable', status });
}

export function catalogueUrl(query = '', page = 1) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 1000) {
        throw sourceError('Use a search of up to 200 characters and a page between 1 and 1000.', 400);
    }
    const url = new URL(query.trim() ? '/s/' + encodeURIComponent(query.trim()) : '/', BASE);
    if (query.trim() && page > 1) url.searchParams.set('page', page);
    return url.href;
}

function bookUrl(value) {
    try {
        const url = new URL(value, BASE);
        if (url.origin === BASE && /^\/book\/[^/]+\/[^/]+\.html$/.test(url.pathname)) {
            return BASE + url.pathname;
        }
    } catch {}
    return '';
}

function text(node) { return node ? node.textContent.replace(/\s+/g, ' ').trim() : ''; }

export function parseCatalogue(html, url) {
    const doc = parseHTML(html).document;
    if (/access denied|just a moment|captcha|unusual traffic/i.test(text(doc.querySelector('title'))) ||
        doc.querySelector('iframe[src*="diamwall"], #challenge-form')) throw sourceError();
    const books = [];
    const seen = new Set();
    function add(node, title, author) {
        if (node.closest('[hidden], [aria-hidden="true"]') || node.getAttribute('deleted') === '1') return;
        const href = bookUrl(node.getAttribute('href'));
        if (!href || !title || seen.has(href)) return;
        seen.add(href);
        const book = { url: href, title: title.slice(0, 500), author: author.slice(0, 500) };
        for (const field of ['year', 'language', 'extension', 'filesize', 'publisher', 'isbn']) {
            book[field] = (node.getAttribute(field) || '').slice(0, 300);
        }
        books.push(book);
    }
    for (const card of doc.querySelectorAll('z-bookcard')) {
        add(card, text(card.querySelector('[slot="title"]')), text(card.querySelector('[slot="author"]')));
    }
    if (new URL(url).pathname === '/') {
        for (const cover of doc.querySelectorAll('a[href] z-cover')) {
            add(cover.closest('a'), cover.getAttribute('title') || '', cover.getAttribute('author') || '');
        }
    }
    // A changed layout, login screen or verification page is not an empty search.
    if (!books.length && !doc.querySelector('#searchResultBox')) throw sourceError();
    const current = new URL(url);
    const page = Number(current.searchParams.get('page') || 1);
    const hasNext = Array.from(doc.querySelectorAll('a[href]')).some((a) => {
        try {
            const next = new URL(a.getAttribute('href'), url);
            return next.origin === BASE && next.pathname === current.pathname && Number(next.searchParams.get('page')) === page + 1;
        } catch { return false; }
    });
    return { books: books.slice(0, 100), page, hasNext, sourceUrl: url, stale: false };
}

async function fetchCatalogue(url, fetcher) {
    let target = url;
    const cookies = new Map();
    const signal = AbortSignal.timeout(20000);
    for (let hop = 0; hop < 4; hop++) {
        const response = await fetcher(target, {
            redirect: 'manual', signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
                'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9',
                ...(cookies.size ? { Cookie: Array.from(cookies, ([k, v]) => k + '=' + v).join('; ') } : {})
            }
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            const next = location && new URL(location, target);
            await response.body?.cancel();
            if (!next || next.origin !== BASE || next.username || next.password) throw sourceError();
            // Ordinary HTTP cookies only; never evaluate a verification script.
            for (const cookie of response.headers.getSetCookie()) {
                const pair = cookie.split(';')[0];
                const split = pair.indexOf('=');
                if (split > 0) cookies.set(pair.slice(0, split), pair.slice(split + 1));
            }
            target = next.href;
            continue;
        }
        if (!response.ok) {
            await response.body?.cancel();
            // DiamWall uses nonstandard 513 for browser verification. Retrying
            // this as a transient 5xx only repeats the challenge.
            if (response.status === 513) {
                throw sourceError('Z-Library requires browser verification on this connection. Open it directly to continue browsing.');
            }
            const retryAfter = response.headers.get('retry-after');
            const delay = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : 1000;
            throw Object.assign(sourceError(undefined, response.status === 429 ? 429 : 502), {
                retryable: response.status === 429 || response.status >= 500,
                retryDelay: Number.isFinite(delay) ? Math.max(1000, delay) : 1000
            });
        }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 3 * 1024 * 1024) { await reader.cancel(); throw sourceError(); }
            chunks.push(Buffer.from(value));
        }
        return parseCatalogue(Buffer.concat(chunks).toString('utf8'), url);
    }
    throw sourceError();
}

export async function listBooks(query, page, fetcher = rawFetch, browserLoader = loadBrowserCatalogue) {
    const url = catalogueUrl(query, page);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.time < TTL) return hit.data;
    if (pending.has(url)) return pending.get(url);
    if (pending.size >= 8) throw sourceError('Z-Library is busy. Please try again shortly.', 429);
    const task = (async () => {
        try {
            let data;
            if (fetcher === rawFetch && process.env.ZLIBRARY_BROWSER !== 'false') {
                data = parseCatalogue(await browserLoader(url), url);
            }
            for (let attempt = 0; attempt < 2 && !data; attempt++) {
                try { data = await fetchCatalogue(url, fetcher); break; }
                catch (error) {
                    // Respect longer Retry-After windows by returning to the user.
                    // Never retry a verification page or redirect loop.
                    if (!error.retryable || error.retryDelay > 2000 || attempt) throw error;
                    await new Promise((resolve) => setTimeout(resolve, error.retryDelay));
                }
            }
            cache.set(url, { data, time: Date.now() });
            if (cache.size > 100) cache.delete(cache.keys().next().value);
            return data;
        } catch (error) {
            if (hit && Date.now() - hit.time < 15 * 60 * 1000) return { ...hit.data, stale: true };
            throw error.code && error.code.startsWith('zlibrary/') ? error : sourceError();
        } finally { pending.delete(url); }
    })();
    pending.set(url, task);
    return task;
}
