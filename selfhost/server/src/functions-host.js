// Runs ReKindle's Cloud Functions file (firebase-functions/index.js) as-is.
// `require('firebase-admin')` and `require('firebase-functions/...')` get local
// stand-ins; everything else (imapflow, nodemailer, ...) loads normally.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, SERVER_DIR, UPSTREAM_ADMIN_EMAIL } from './config.js';
import { createAdminModule } from './admin-shim.js';
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
    // The upstream file hard-codes the original developer's account as admin.
    const src = fs.readFileSync(file, 'utf8')
        .split(`'${UPSTREAM_ADMIN_EMAIL}'`).join('__rkAdminEmail()')
        .split(`"${UPSTREAM_ADMIN_EMAIL}"`).join('__rkAdminEmail()');
    const nodeRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
    const fake = shims();
    const req = (name) => (Object.prototype.hasOwnProperty.call(fake, name) ? fake[name] : nodeRequire(name));
    const mod = { exports: {} };
    const run = new Function('require', 'module', 'exports', '__filename', '__dirname', '__rkAdminEmail', src);
    run(req, mod, mod.exports, file, path.dirname(file), auth.adminEmail);
    return mod.exports;
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
