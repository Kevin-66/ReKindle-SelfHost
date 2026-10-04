// Keeps the upstream proxy-style services (/api/proxy, the article reader, ...)
// from being used to reach this server's own network: while they run, every
// fetch() - including each redirect hop - must go to a public address.

import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns/promises';
import net from 'node:net';

export const rawFetch = globalThis.fetch.bind(globalThis);
const guardScope = new AsyncLocalStorage();

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

async function guardedFetch(input, init) {
    let request = new Request(input, init);
    for (let hop = 0; hop < 6; hop++) {
        await assertPublic(request.url);
        const res = await rawFetch(request.clone(), { redirect: 'manual' });
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
