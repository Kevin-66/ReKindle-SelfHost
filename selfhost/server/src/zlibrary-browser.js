// Runs the site's own JavaScript in a sandboxed Chromium session. Only the public
// catalogue is exposed; the browser never receives ReKindle account credentials.

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
