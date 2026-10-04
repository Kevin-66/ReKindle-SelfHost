// In-memory stand-in for the Cloudflare Cache API (`caches.default`), which the
// upstream /api functions (reddit.js, nrl-scores.js) use to avoid refetching.
// Without it every page view went straight to Reddit and got rate-limited.

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

function maxAgeSeconds(cacheControl) {
    const cc = String(cacheControl || '').toLowerCase();
    if (/no-store|private/.test(cc)) return 0;
    const m = cc.match(/s-maxage=(\d+)/) || cc.match(/max-age=(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

class MemoryCache {
    constructor() {
        this.entries = new Map(); // key -> { status, headers, body, expires }
        this.bytes = 0;
    }

    key(request) {
        return typeof request === 'string' ? request : request.url;
    }

    remove(key) {
        const e = this.entries.get(key);
        if (!e) return false;
        this.bytes -= e.body.byteLength;
        this.entries.delete(key);
        return true;
    }

    async match(request) {
        const key = this.key(request);
        const e = this.entries.get(key);
        if (!e) return undefined;
        if (e.expires <= Date.now()) {
            this.remove(key);
            return undefined;
        }
        // Most recently used goes to the end.
        this.entries.delete(key);
        this.entries.set(key, e);
        return new Response(e.body, { status: e.status, headers: e.headers });
    }

    async put(request, response) {
        const ttl = maxAgeSeconds(response.headers.get('cache-control'));
        const body = new Uint8Array(await response.arrayBuffer());
        if (!ttl || response.status !== 200 || body.byteLength > MAX_ENTRY_BYTES) return;
        const key = this.key(request);
        this.remove(key);
        const headers = [];
        response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers.push([k, v]); });
        this.entries.set(key, { status: response.status, headers, body, expires: Date.now() + ttl * 1000 });
        this.bytes += body.byteLength;
        for (const k of this.entries.keys()) {
            if (this.bytes <= MAX_BYTES) break;
            this.remove(k);
        }
    }

    async delete(request) {
        return this.remove(this.key(request));
    }
}

const named = new Map();
export const memoryCaches = {
    default: new MemoryCache(),
    async open(name) {
        if (!named.has(name)) named.set(name, new MemoryCache());
        return named.get(name);
    },
    async has(name) { return named.has(name); },
    async delete(name) { return named.delete(name); },
    async keys() { return [...named.keys()]; },
    async match(request) {
        for (const c of [this.default, ...named.values()]) {
            const r = await c.match(request);
            if (r) return r;
        }
        return undefined;
    }
};

// Some runtimes (Deno) have their own CacheStorage without `default`; always use ours.
Object.defineProperty(globalThis, 'caches', { value: memoryCaches, writable: true, configurable: true });

// Last good GET response per URL, served when the origin rate-limits or fails.
const STALE_MAX_BYTES = 32 * 1024 * 1024;
const STALE_TTL = 6 * 3600 * 1000;
const stale = new Map();
let staleBytes = 0;

export function rememberGood(url, status, headers, body) {
    if (status !== 200 || body.byteLength > MAX_ENTRY_BYTES) return;
    const old = stale.get(url);
    if (old) { staleBytes -= old.body.byteLength; stale.delete(url); }
    stale.set(url, { headers, body, at: Date.now() });
    staleBytes += body.byteLength;
    for (const [k, v] of stale) {
        if (staleBytes <= STALE_MAX_BYTES) break;
        staleBytes -= v.body.byteLength;
        stale.delete(k);
    }
}

export function lastGood(url) {
    const e = stale.get(url);
    if (!e || Date.now() - e.at > STALE_TTL) return null;
    return e;
}
