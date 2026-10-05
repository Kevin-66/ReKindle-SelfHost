// Keeps the upstream proxy-style services (/api/proxy, the article reader, ...)
// from being used to reach this server's own network: while they run, every
// fetch() - including each redirect hop - must go to a public address.

import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

const directFetch = globalThis.fetch.bind(globalThis);
const guardScope = new AsyncLocalStorage();

// Sites that refuse this server's address are fetched through PROXY_URL, an HTTP
// proxy on another machine (http://user:pass@host:port). archive.today blocks many
// hosting networks (Netcup and Cloudflare WARP included, 2026-10), so its domains
// are the default list.
const PROXY_DOMAINS = (process.env.PROXY_DOMAINS || 'archive.today,archive.ph,archive.is,archive.li,archive.md,archive.vn,archive.fo')
    .split(',').map((d) => d.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
const proxyAgent = (() => {
    if (!process.env.PROXY_URL) return null;
    try {
        const u = new URL(process.env.PROXY_URL);
        const opts = { uri: `${u.protocol}//${u.host}` };
        if (u.username) {
            opts.token = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
        }
        return new ProxyAgent(opts);
    } catch (e) {
        console.warn(`[proxy] PROXY_URL ignored: ${e.message}`);
        return null;
    }
})();

function useProxy(url) {
    if (!proxyAgent) return false;
    let host;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
    return PROXY_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

// archive.today answers an outdated browser (the article reader says Chrome 120)
// with a CAPTCHA page and HTTP 429, so proxied requests present a current one.
const PROXY_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

async function proxiedFetch(request, redirect) {
    const headers = new Headers(request.headers);
    headers.set('User-Agent', PROXY_USER_AGENT);
    const init = { method: request.method, headers: [...headers], redirect, dispatcher: proxyAgent, signal: request.signal };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
    return undiciFetch(request.url, init);
}

function urlOf(input) {
    return typeof input === 'string' ? input : (input && input.url) || String(input);
}

// fetch() without the private-address check, still honouring PROXY_URL.
export function rawFetch(input, init) {
    if (useProxy(urlOf(input))) {
        const request = new Request(input, init);
        return proxiedFetch(request, request.redirect);
    }
    return directFetch(input, init);
}

export const proxyEnabled = !!proxyAgent;

function v4Private(ip) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127
        || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
        || (p[0] === 169 && p[1] === 254)
        || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
        || (p[0] === 192 && p[1] === 168)
        || (p[0] === 192 && p[1] === 0 && p[2] === 0)
        // 198.18.0.0/15 is deliberately allowed: proxy tools (sing-box, Clash) in
        // "fake-IP" DNS mode answer every hostname with an address from it.
        || p[0] >= 224;
}

export function isPrivateAddress(ip) {
    if (net.isIPv4(ip)) return v4Private(ip);
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return v4Private(mapped[1]);
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

export class BlockedAddressError extends Error {
    constructor(host) {
        super(`Blocked request to a private address (${host})`);
        this.status = 403;
    }
}

async function assertPublic(urlString) {
    const u = new URL(urlString);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedAddressError(u.protocol);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
    if (!addrs.length || addrs.some(isPrivateAddress)) throw new BlockedAddressError(host);
}

// Cloudflare's own request headers (CF-Connecting-IP, ...) are added by Cloudflare,
// and its runtime drops them from a worker's outgoing requests. Workers that forward
// their incoming headers would otherwise pass on the ones workers-host.js adds, and
// sites behind Cloudflare refuse those requests (Substack answered every one with 403).
function withoutCloudflareHeaders(request) {
    const headers = new Headers();
    let found = false;
    request.headers.forEach((v, k) => {
        if (k.startsWith('cf-')) found = true;
        else headers.append(k, v);
    });
    return found ? new Request(request, { headers }) : request;
}

async function guardedFetch(input, init) {
    let request = withoutCloudflareHeaders(new Request(input, init));
    for (let hop = 0; hop < 6; hop++) {
        await assertPublic(request.url);
        const res = useProxy(request.url)
            ? await proxiedFetch(request.clone(), 'manual')
            : await directFetch(request.clone(), { redirect: 'manual' });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location || request.redirect === 'manual') return res;
        const next = new URL(location, request.url);
        const keepBody = res.status === 307 || res.status === 308;
        request = new Request(next, {
            method: keepBody ? request.method : (request.method === 'HEAD' ? 'HEAD' : 'GET'),
            headers: request.headers,
            body: keepBody && request.body ? await request.clone().arrayBuffer() : undefined,
            redirect: request.redirect
        });
    }
    throw new Error('Too many redirects');
}

globalThis.fetch = function (input, init) {
    return guardScope.getStore() ? guardedFetch(input, init) : rawFetch(input, init);
};

// Run fn with outgoing requests restricted to public addresses.
export function withPublicNetworkOnly(fn) {
    return guardScope.run(true, fn);
}
