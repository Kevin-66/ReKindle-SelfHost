// Runs ReKindle's Cloud Functions (firebase-functions/index.js and the files it
// requires) as-is. `require('firebase-admin')` and `require('firebase-functions/...')`
// get local stand-ins; everything else (imapflow, nodemailer, ...) loads normally.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, SERVER_DIR, UPSTREAM_ADMIN_EMAIL } from './config.js';
import { createAdminModule } from './admin-shim.js';
import { withPublicNetworkOnly } from './netguard.js';
import * as auth from './auth.js';

const STATUS = {
    ok: 200, cancelled: 499, unknown: 500, 'invalid-argument': 400, 'deadline-exceeded': 504,
    'not-found': 404, 'already-exists': 409, 'permission-denied': 403, 'resource-exhausted': 429,
    'failed-precondition': 400, aborted: 409, 'out-of-range': 400, unimplemented: 501,
    internal: 500, unavailable: 503, 'data-loss': 500, unauthenticated: 401
};

export class HttpsError extends Error {
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.httpErrorCode = { canonicalName: String(code).toUpperCase(), status: STATUS[code] || 500 };
    }
    toJSON() { return { status: String(this.code).toUpperCase(), message: this.message, details: this.details }; }
}

function anyProxy() {
    // Permissive object for firebase-functions/v1 builders nobody here calls.
    const fn = function () { return proxy; };
    const proxy = new Proxy(fn, {
        get: (t, k) => (k === 'config' ? () => ({}) : k === Symbol.toPrimitive ? () => '' : proxy),
        apply: () => proxy
    });
    return proxy;
}

const logger = {
    log: (...a) => console.log('[functions]', ...a),
    info: (...a) => console.log('[functions]', ...a),
    debug: (...a) => { if (config.logRequests) console.log('[functions]', ...a); },
    warn: (...a) => {
        // Expected here: the separate social project is not used on this server.
        if (String(a[0]).includes('SOCIAL_SERVICE_ACCOUNT_JSON')) return;
        console.warn('[functions]', ...a);
    },
    error: (...a) => console.error('[functions]', ...a),
    write: (e) => console.log('[functions]', e)
};

function shims() {
    const https = {
        HttpsError,
        onCall(opts, handler) {
            const h = typeof opts === 'function' ? opts : handler;
            return { __rkCallable: h };
        },
        onRequest(opts, handler) {
            const h = typeof opts === 'function' ? opts : handler;
            return { __rkRequest: h };
        }
    };
    const admin = createAdminModule();
    return {
        'firebase-admin': admin,
        'firebase-admin/app': admin,
        'firebase-functions/v2/https': https,
        'firebase-functions/https': https,
        'firebase-functions/logger': logger,
        // Scheduled jobs don't run here (2026-10: cleanupSocial, the social apps'
        // retention cleanup; chat is off on this server).
        'firebase-functions/v2/scheduler': { onSchedule: () => ({ __rkScheduled: true }) },
        'firebase-functions/v1': anyProxy(),
        'firebase-functions': anyProxy(),
        'firebase-functions/params': { defineSecret: () => ({ value: () => '' }), defineString: () => ({ value: () => '' }) }
    };
}

function load() {
    const file = path.join(config.upstreamDir, 'firebase-functions', 'index.js');
    if (!fs.existsSync(file)) {
        console.warn(`[functions] ${file} not found; server functions are unavailable`);
        return {};
    }
    const nodeRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
    const fake = shims();
    const loaded = new Map();
    // Upstream splits its functions over several files (2026-10: require('./substack'),
    // './account-deletion', ...); those load the same way, with the same stand-ins.
    function loadFile(f) {
        if (loaded.has(f)) return loaded.get(f).exports;
        // The upstream files hard-code the original developer's account as admin.
        const src = fs.readFileSync(f, 'utf8')
            .split(`'${UPSTREAM_ADMIN_EMAIL}'`).join('__rkAdminEmail()')
            .split(`"${UPSTREAM_ADMIN_EMAIL}"`).join('__rkAdminEmail()');
        const mod = { exports: {} };
        loaded.set(f, mod);
        const req = (name) => {
            if (Object.prototype.hasOwnProperty.call(fake, name)) return fake[name];
            if (name.startsWith('./') || name.startsWith('../')) {
                const target = path.resolve(path.dirname(f), name);
                return loadFile(fs.existsSync(target) ? target : target + '.js');
            }
            return nodeRequire(name);
        };
        const run = new Function('require', 'module', 'exports', '__filename', '__dirname', '__rkAdminEmail', src);
        run(req, mod, mod.exports, f, path.dirname(f), auth.adminEmail);
        return mod.exports;
    }
    return loadFile(file);
}

const upstream = load();

// Server-specific replacements and guards.
const overrides = {
    // Chat is off on this server; pages that still sign in to the old "social"
    // app (e.g. Life Calendar) get a token for the same account and data.
    async getSocialToken(request) {
        if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');
        return { token: auth.createCustomToken(request.auth.uid) };
    }
};

// Callables that may run without a signed-in user. Everything else (notably
// the mail functions, which upstream leaves open) requires an account here.
const ANONYMOUS_OK = new Set(['registerUser']);

export function hasCallable(name) {
    return Object.prototype.hasOwnProperty.call(overrides, name)
        || !!(upstream[name] && upstream[name].__rkCallable);
}

export async function invokeCallable(name, data, decoded, rawRequest) {
    if (!hasCallable(name)) throw new HttpsError('not-found', `Function ${name} is not available on this server.`);
    if (!decoded && !ANONYMOUS_OK.has(name)) throw new HttpsError('unauthenticated', 'Please sign in first.');
    if (name === 'registerUser' && !auth.canRegister(data && data.username)) {
        throw new HttpsError('permission-denied', auth.registrationClosedMessage());
    }
    const request = {
        data: data === undefined ? null : data,
        auth: decoded ? { uid: decoded.uid, token: decoded } : undefined,
        rawRequest,
        acceptsStreaming: false
    };
    const handler = overrides[name] || upstream[name].__rkCallable;
    return handler(request);
}

export function errorStatus(e) {
    return (e && e.httpErrorCode && e.httpErrorCode.status) || 500;
}

// ---------------------------------------------------------------- HTTP functions
//
// Upstream's onRequest functions that pages call directly (2026-10: `substack`, the
// Substack relay, and `standardebooks` for the Reader) run at /__rk/fn/<name>;
// transform.js points the pages' cloudfunctions.net addresses there. They get the
// part of Express's request/response they use (req.query, res.set/status/json/send/end).

export function hasRequestFunction(name) {
    return !!(upstream[name] && upstream[name].__rkRequest);
}

// Substack: the app asks every publication for its posts again each time "Following"
// or a publication opens, so successful answers are kept for an hour (owner's choice,
// 2026-10, first for the rekindle-substack worker), per account and Substack cookie.
const REQUEST_CACHE_MS = { substack: 60 * 60 * 1000 };
const REQUEST_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const requestCache = new Map(); // key -> { t, headers, body }
let requestCacheBytes = 0;

function remember(key, headers, body) {
    const old = requestCache.get(key);
    if (old) { requestCacheBytes -= old.body.length; requestCache.delete(key); }
    requestCache.set(key, { t: Date.now(), headers, body });
    requestCacheBytes += body.length;
    for (const [k, v] of requestCache) {
        if (requestCacheBytes <= REQUEST_CACHE_MAX_BYTES) break;
        requestCacheBytes -= v.body.length;
        requestCache.delete(k);
    }
}

// The function checks the sign-in itself; a cached answer is only given to the
// same signed-in account.
function cacheKey(name, req, url) {
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    const user = m ? auth.verifyIdToken(m[1].trim()) : null;
    if (!user) return null;
    const sid = crypto.createHash('sha256').update(String(req.headers['x-substack-sid'] || '')).digest('base64url').slice(0, 22);
    return `${name} ${url.search} ${user.uid} #${sid}`;
}

function expressResponse(res, onOk) {
    const api = {
        set(name, value) { res.setHeader(name, value); return api; },
        status(code) { res.statusCode = code; return api; },
        json(value) {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return api.send(JSON.stringify(value));
        },
        send(body) {   // a string or a Buffer
            const buf = Buffer.from(body);
            if (!res.getHeader('content-type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Content-Length', buf.length);
            if (onOk && res.statusCode === 200 && /json/i.test(String(res.getHeader('content-type')))) {
                onOk(Object.entries(res.getHeaders()), buf);
            }
            res.end(buf);
            return api;
        },
        end() { res.end(); return api; }
    };
    return api;
}

export async function handleRequestFunction(req, res, name, url) {
    const handler = upstream[name].__rkRequest;
    const ttl = req.method === 'GET' ? REQUEST_CACHE_MS[name] || 0 : 0;
    const key = ttl ? cacheKey(name, req, url) : null;
    const hit = key ? requestCache.get(key) : null;
    if (hit && Date.now() - hit.t < ttl) {
        res.writeHead(200, Object.fromEntries(hit.headers));
        res.end(hit.body);
        return;
    }
    // Node's request (headers, method, connection), plus Express's req.query.
    const request = Object.create(req, { query: { value: Object.fromEntries(url.searchParams) } });
    const response = expressResponse(res, key ? (headers, body) => remember(key, headers, body) : null);
    await withPublicNetworkOnly(() => handler(request, response));
}
