// The Z-Library browser service (Dockerfile.zlibrary-browser, selfhost/browser/service.mjs):
// headed Chromium for Z-Library and Calibre's MOBI conversion. It is its own Zeabur
// service (<name>.zeabur.internal), a Docker Compose service (single-label name) or a
// loopback sidecar, at ZLIBRARY_BROWSER_ENDPOINT, with ZLIBRARY_BROWSER_TOKEN on both
// sides. The endpoint is administrator-controlled, never supplied by a client, and must
// be on the private network.

import { rawFetch } from './netguard.js';

export const browserServiceConfigured = () => !!process.env.ZLIBRARY_BROWSER_ENDPOINT;

function privateEndpoint(endpoint) {
    const host = endpoint.hostname;
    return ['127.0.0.1', '[::1]', 'localhost'].includes(host) || host.endsWith('.zeabur.internal') || /^[a-z0-9-]+$/i.test(host);
}

// fetch() to the service; rawFetch, since the public-address guard would refuse it.
export function browserService(pathname, init = {}) {
    const endpoint = new URL(process.env.ZLIBRARY_BROWSER_ENDPOINT || '');
    if (endpoint.protocol !== 'http:' || !privateEndpoint(endpoint)) throw new Error('ZLIBRARY_BROWSER_ENDPOINT must be a private http:// address');
    const headers = { ...(init.headers || {}) };
    if (process.env.ZLIBRARY_BROWSER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ZLIBRARY_BROWSER_TOKEN;
    return rawFetch(new URL(pathname, endpoint), { ...init, headers });
}

// The service's plain-text error message, if it sent a short one; else `fallback`.
export async function serviceMessage(res, fallback) {
    const text = await res.text().catch(() => '');
    return text && text.length < 400 && !/^\s*</.test(text) ? text : fallback;
}
