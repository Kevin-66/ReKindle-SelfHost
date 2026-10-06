// Runs the site's own JavaScript in a sandboxed Chromium session. The catalogue uses
// a public session; downloadBook() uses a separate, throwaway session carrying the
// reader's own Z-Library cookie (pasted in the app), never ReKindle credentials.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'https://z-lib.sk';
const READY = '#searchResultBox, a[href*="/book/"] z-cover, z-bookcard';
let session;
let launching;
let queue = Promise.resolve();
let queued = 0;
let idleTimer;

export function allowedBrowserUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
        return ['z-lib.sk', 'cdn-zlib.sk', 'diamwall.com'].some((host) => url.hostname === host || url.hostname.endsWith('.' + host));
    } catch { return false; }
}

export function browserProxy(value) {
    if (!value) return undefined;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('An HTTP proxy is required.');
    return {
        server: url.protocol + '//' + url.host,
        ...(url.username ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {})
    };
}

function unavailable() {
    return Object.assign(new Error('The Z-Library browser could not load the catalogue. Try again or open Z-Library directly.'), {
        code: 'zlibrary/browser-unavailable', status: 502
    });
}

async function getSession() {
    if (session && session.browser.isConnected()) return session;
    if (launching) return launching;
    launching = (async () => {
        // Do not pass server API keys or the proxy password to the browser process.
        const env = {};
        for (const key of ['PATH', 'HOME', 'LANG', 'DISPLAY', 'XAUTHORITY', 'TMPDIR']) {
            if (process.env[key]) env[key] = process.env[key];
        }
        const { chromium } = await import('playwright-core');
        const browser = await chromium.launch({
            headless: false, chromiumSandbox: true, timeout: 15000,
            // Direct access works from Netcup; archive.today's proxy is separate.
            proxy: browserProxy(process.env.ZLIBRARY_PROXY_URL), env,
            ...(process.env.ZLIBRARY_CHROMIUM_PATH ? { executablePath: process.env.ZLIBRARY_CHROMIUM_PATH } : {})
        });
        try {
            const context = await browser.newContext({ locale: 'en-US', acceptDownloads: false, serviceWorkers: 'block' });
            await context.route('**/*', (route) => {
                const request = route.request();
                if (!allowedBrowserUrl(request.url())) return route.abort();
                // Covers are displayed as text by ReKindle; avoid downloading them.
                if (['image', 'media', 'font'].includes(request.resourceType()) && !request.url().includes('diamwall')) return route.abort();
                return route.continue();
            });
            await context.routeWebSocket('**/*', (socket) => socket.close());
            context.on('page', (page) => page.on('dialog', (dialog) => dialog.dismiss()));
            session = { browser, context };
            return session;
        } catch (error) { await browser.close(); throw error; }
    })();
    try { return await launching; } finally { launching = null; }
}

export async function closeCatalogueBrowser() {
    clearTimeout(idleTimer);
    const current = session;
    session = null;
    if (current) await current.browser.close().catch(() => {});
}

async function load(url, deadline) {
    clearTimeout(idleTimer);
    let page;
    try {
        if (Date.now() >= deadline) throw unavailable();
        const { context } = await getSession();
        page = await context.newPage();
        // A cold session may encounter a 503/513 JavaScript interstitial. Wait for
        // real catalogue markup instead of treating its first HTTP status as final.
        const remaining = () => Math.max(1, deadline - Date.now());
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(25000, remaining()) });
        await page.locator(READY).first().waitFor({ state: 'attached', timeout: Math.min(25000, remaining()) });
        const finalUrl = new URL(page.url());
        if (finalUrl.origin !== BASE || finalUrl.pathname !== new URL(url).pathname) throw unavailable();
        const html = await page.content();
        if (Buffer.byteLength(html) > 3 * 1024 * 1024) throw unavailable();
        return html;
    } catch {
        // Never echo Playwright errors: launch options can contain proxy credentials.
        throw unavailable();
    } finally {
        if (page) await page.close().catch(() => {});
        idleTimer = setTimeout(() => { if (!queued) closeCatalogueBrowser(); }, 5 * 60 * 1000);
        idleTimer.unref();
    }
}

export function loadBrowserCatalogue(url) {
    const parsed = new URL(url);
    if (parsed.origin !== BASE || parsed.username || parsed.password ||
        !(parsed.pathname === '/' || /^\/s\/[^/]+$/.test(parsed.pathname))) return Promise.reject(unavailable());
    if (process.env.ZLIBRARY_BROWSER_ENDPOINT) return loadFromBrowserService(url);
    // One tab at a time keeps cookie verification consistent and caps memory use.
    if (queued >= 3) return Promise.reject(Object.assign(unavailable(), { status: 429 }));
    queued++;
    const deadline = Date.now() + 60000;
    const task = queue.then(() => load(url, deadline));
    queue = task.catch(() => {});
    return task.finally(() => { queued--; });
}


// ---------------------------------------------------------------- downloads
//
// Downloads one book with the reader's Z-Library cookie: a fresh context (nothing
// shared with the public catalogue session or other readers) opens the book page in
// the same headed Chromium, so Z-Library's verification passes, and saves the file.
//
// The Kindle browser downloads only MOBI, AZW, PRC and TXT (owner, 2026-10-06; an
// earlier note said it opened PDF too, which turned out wrong). A book in one of those,
// or AZW3 (owner: keep it), downloads as it is; any other (EPUB, PDF, FB2, DJVU, ...),
// in order:
// 1. a MOBI file of the same book (a /dl/ link whose own text says MOBI, after the
//    "other formats" button has loaded the book's other files);
// 2. Z-Library's converter: the "Convert to" menu has
//    a.converterLink[data-convert_to="mobi"]; clicking it makes the page's script POST
//    /papi/book/<id>/file-conversion/mobi (answer: {error} | {jobId} | {response:
//    {statusOkContent, downloadUrl}} when already converted), poll
//    /papi/book/<id>/file-conversion/jobs every 10 s and, when the job is "ok", open
//    its downloadUrl, which we catch as the download. A failed job shows
//    #converterCurrentStatusesBox .status-error. (Read from book-details.min.js, 2026-10.)
// 3. when that fails or takes too long, the book's own file, which the browser service
//    converts with Calibre (POST /convert).
// Subresources are limited to Z-Library and its assets; page navigations (download
// links redirect to download hosts we can't list in advance) may go to any https host.
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const CONVERT_WAIT_MS = 5 * 60 * 1000;
let downloads = Promise.resolve();

function downloadAllowed(request) {
    try {
        const url = new URL(request.url());
        if (url.protocol !== 'https:' || url.username || url.password) return false;
        return allowedBrowserUrl(url.href) || (request.isNavigationRequest() && request.resourceType() === 'document');
    } catch { return false; }
}

export function cookiePairs(text) {
    const pairs = [];
    for (const part of String(text || '').split(';')) {
        const m = /^\s*([A-Za-z0-9_-]{1,64})=([^;\s,"\\]{1,1024})\s*$/.exec(part);
        if (m) pairs.push([m[1], m[2]]);
    }
    return pairs;
}

function downloadFailed(status = 502, message) {
    return Object.assign(new Error(message || 'Z-Library did not start the download. Your cookie may have expired (sign in on Z-Library and copy it again), or the daily download limit may be reached.'), {
        code: 'zlibrary/download-failed', status
    });
}

// Each download step is logged when run locally (book page only, never the cookie).
// Never on the deployed server (owner's rule: logging only locally); the Docker images
// set NODE_ENV=production.
const log = process.env.NODE_ENV === 'production' ? () => {} : (...parts) => console.log('[zlibrary download]', ...parts);

// Z-Library's script (jQuery 2.2.4) attaches its click handlers once the page has
// loaded: "Convert to" is delegated on document (selector .converterLink), "other
// formats" sits on #btnCheckOtherFormats. A click before that does nothing, so wait
// until the handler we need is there.
function handlerReady(page, which) {
    return page.waitForFunction((w) => {
        const $ = window.jQuery;
        if (!$ || !$._data) return false;
        if (w === 'convert') {
            const events = $._data(document, 'events');
            return !!(events && events.click && events.click.some((h) => h.selector === '.converterLink'));
        }
        const button = document.getElementById('btnCheckOtherFormats');
        const events = button && $._data(button, 'events');
        return !!(events && events.click && events.click.length);
    }, which, { timeout: 20000 }).then(() => true, () => false);
}

const plain = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 300);

// Clicks a /dl/ link (DOM click: other formats sit in a hidden menu) and returns the download.
async function clickDownload(page, href) {
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 90000 }),
        page.evaluate((h) => {
            const a = Array.prototype.find.call(document.querySelectorAll('a[href*="/dl/"]'), (x) => x.href === h);
            if (a) a.click();
        }, href)
    ]);
    return download;
}

// Z-Library's own conversion to MOBI. Returns the download, or null to fall back to
// the original file; throws when Z-Library refuses (e.g. the daily limit), since the
// original would be refused too.
async function zlibraryConvert(page) {
    if (!await handlerReady(page, 'convert')) { log('Convert to: no click handler on the page, using the EPUB'); return null; }
    // Signed out, the link has an empty data-book-id and the click only opens a login box.
    const bookId = await page.evaluate(() => document.querySelector('a.converterLink[data-convert_to="mobi"]').getAttribute('data-book-id'));
    if (!bookId) log('Convert to: the page does not look signed in (empty data-book-id); trying anyway');
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && /\/file-conversion\/mobi(\?|$)/.test(r.url()), { timeout: 30000 });
    const downloaded = page.waitForEvent('download', { timeout: CONVERT_WAIT_MS });
    downloaded.catch(() => {});
    await page.evaluate(() => { document.querySelector('a.converterLink[data-convert_to="mobi"]').click(); });
    let answer = null;
    try { answer = await (await answered).json(); } catch { log('Convert to: no answer from Z-Library, using the EPUB'); return null; }
    if (answer && answer.error) { log('Convert to: Z-Library refused:', plain(answer.error)); throw downloadFailed(502, 'Z-Library: ' + plain(answer.error)); }
    log('Convert to: started', answer && answer.response ? '(already converted)' : 'job ' + (answer && answer.jobId));
    const failed = page.locator('#converterCurrentStatusesBox .status-error').first()
        .waitFor({ state: 'attached', timeout: CONVERT_WAIT_MS }).then(() => 'failed', () => 'timeout');
    const result = await Promise.race([downloaded.catch(() => 'timeout'), failed]);
    if (typeof result === 'string') { log('Convert to:', result === 'failed' ? 'Z-Library\'s conversion failed' : 'no file after 5 minutes', '- using the EPUB'); return null; }
    log('Convert to: converted file arrived');
    return result;
}

async function runDownload(url, cookie) {
    const parsed = new URL(url);
    if (parsed.origin !== BASE || !/^\/book\/[^/]+\/[^/]+\.html$/.test(parsed.pathname)) throw downloadFailed(400);
    const pairs = cookiePairs(cookie);
    if (!pairs.length) throw downloadFailed(400);
    const { browser } = await getSession();
    const context = await browser.newContext({ locale: 'en-US', acceptDownloads: true, serviceWorkers: 'block' });
    try {
        await context.addCookies(pairs.map(([name, value]) => ({ name, value, domain: '.z-lib.sk', path: '/', secure: true, sameSite: 'Lax' })));
        await context.route('**/*', (route) => {
            const request = route.request();
            if (!downloadAllowed(request)) return route.abort();
            if (['image', 'media', 'font'].includes(request.resourceType()) && !request.url().includes('diamwall')) return route.abort();
            return route.continue();
        });
        context.on('page', (page) => page.on('dialog', (dialog) => dialog.dismiss()));
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.locator('a[href*="/dl/"]').first().waitFor({ state: 'attached', timeout: 25000 });
        await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
        const main = await page.evaluate(() => {
            const a = document.querySelector('a[href*="/dl/"]');   // the book's own file, e.g. "epub, 649 KB"
            if (!a) return null;
            const label = [a.textContent, a.getAttribute('data-extension'), a.title].join(' ');
            return { href: a.href, format: ((/[a-z0-9]+/i.exec(label) || [''])[0] || '').toLowerCase(), kindle: /(^|[^a-z0-9])(mobi|azw3?|prc|txt)([^a-z0-9]|$)/i.test(label) };
        });
        if (!main) throw downloadFailed();
        log(parsed.pathname, main.kindle ? `is ${main.format}: downloading it as it is` : `is ${main.format || 'unknown'}: getting it as MOBI`);
        let download = null;
        if (!main.kindle) {
            // Other files of the same book (perhaps a MOBI) load into the menu on demand:
            // the "other formats" button fetches /papi/book/<id>/formats.
            if (await handlerReady(page, 'formats')) {
                const formats = page.waitForResponse((r) => /\/papi\/book\/\d+\/formats/.test(r.url()), { timeout: 15000 }).catch(() => null);
                await page.evaluate(() => { document.getElementById('btnCheckOtherFormats').click(); });
                if (await formats) await page.waitForTimeout(700);
            } else {
                log('other formats: no click handler on the page');
            }
            const choice = await page.evaluate(() => {
                const label = (a) => [a.textContent, a.title, a.getAttribute('data-extension')].join(' ');
                const mobi = Array.prototype.find.call(document.querySelectorAll('a[href*="/dl/"]'), (a) => /(^|[^a-z])mobi([^a-z]|$)/i.test(label(a)));
                const toggle = document.querySelector('[data-convertation-available]');
                return {
                    mobi: mobi ? mobi.href : null,
                    convert: !!document.querySelector('a.converterLink[data-convert_to="mobi"]') && !(toggle && toggle.getAttribute('data-convertation-available') === '0')
                };
            });
            log(choice.mobi ? 'a MOBI file is listed' : 'no MOBI file', choice.convert ? '- Convert to MOBI offered' : '- no Convert to MOBI');
            if (choice.mobi) download = await clickDownload(page, choice.mobi);
            if (!download && choice.convert) download = await zlibraryConvert(page);
        }
        if (!download) download = await clickDownload(page, main.href);
        log('saving', download.suggestedFilename());
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zlib-')), 'book');
        await download.saveAs(file);
        const size = fs.statSync(file).size;
        if (!size || size > MAX_DOWNLOAD_BYTES) { fs.rmSync(path.dirname(file), { recursive: true, force: true }); throw downloadFailed(); }
        const name = (download.suggestedFilename() || 'book').replace(/[\\/\0\r\n"]/g, '_').slice(0, 200);
        return { file, name, size };
    } catch (error) {
        // Never echo Playwright errors: launch options can contain proxy credentials.
        throw error.code === 'zlibrary/download-failed' ? error : downloadFailed();
    } finally {
        await context.close().catch(() => {});
    }
}

// { file, name, size }; the caller deletes path.dirname(file) when done. One at a time.
export function downloadBook(url, cookie) {
    const task = downloads.then(() => runDownload(url, cookie));
    downloads = task.catch(() => {});
    return task;
}

// The catalogue browser as a separate service (Dockerfile.zlibrary-browser): its own
// Zeabur service (<name>.zeabur.internal), a Docker Compose service (single-label
// name) or a loopback sidecar. The endpoint is administrator-controlled, never
// supplied by a client, and must be on the private network.
function privateEndpoint(endpoint) {
    const host = endpoint.hostname;
    return ['127.0.0.1', '[::1]', 'localhost'].includes(host) || host.endsWith('.zeabur.internal') || /^[a-z0-9-]+$/i.test(host);
}

async function loadFromBrowserService(url) {
    try {
        const endpoint = new URL(process.env.ZLIBRARY_BROWSER_ENDPOINT);
        if (endpoint.protocol !== 'http:' || !privateEndpoint(endpoint)) throw unavailable();
        // rawFetch: the server's public-address guard would refuse this private address.
        const { rawFetch } = await import('./netguard.js');
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.ZLIBRARY_BROWSER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ZLIBRARY_BROWSER_TOKEN;
        const response = await rawFetch(new URL('/catalogue', endpoint), {
            method: 'POST', headers,
            body: JSON.stringify({ url }), signal: AbortSignal.timeout(65000)
        });
        if (!response.ok) throw Object.assign(unavailable(), { status: response.status === 429 ? 429 : 502 });
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 3 * 1024 * 1024) { await reader.cancel(); throw unavailable(); }
            chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks).toString('utf8');
    } catch (error) {
        throw error.code === 'zlibrary/browser-unavailable' ? error : unavailable();
    }
}
