// Runs ReKindle's Cloudflare Workers (workers/*/worker.js) and Pages Functions
// (functions/api/*.js) inside this server, unmodified.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { db } from './db.js';
import { config, SERVER_DIR } from './config.js';
import { aiBinding } from './ai.js';
import { withPublicNetworkOnly } from './netguard.js';
import { rememberGood, lastGood } from './cache.js';

// Workers that only served features this server does not offer
// (chat moderation, chat translation, ReKindle+ payments).
const SKIPPED_WORKERS = new Set(['rekindle-moderate', 'rekindle-translate', 'rekindle-stripe']);

// /api functions not served. reddit: the Reddit app opens old.reddit.com in the
// device's browser instead (Reddit turns servers away; old.reddit.com needs a login).
const SKIPPED_FUNCTIONS = new Set(['reddit']);

// Workers check the Origin header against rekindle.ink; requests arrive here
// same-origin, so present them as coming from the original site.
const TRUSTED_ORIGIN = 'https://rekindle.ink';

const RUNTIME_DIR = path.join(SERVER_DIR, '.runtime');

// Cloudflare KV namespace backed by SQLite.
function kvNamespace(name) {
    const get = db.prepare('SELECT value, expires FROM kv WHERE ns = ? AND key = ?');
    const put = db.prepare('INSERT INTO kv(ns, key, value, expires) VALUES(?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, expires = excluded.expires');
    const del = db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?');
    const list = db.prepare("SELECT key FROM kv WHERE ns = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?");
    return {
        async get(key, opts) {
            const type = typeof opts === 'string' ? opts : (opts && opts.type) || 'text';
            const row = get.get(name, String(key));
            if (!row) return null;
            if (row.expires && row.expires < Date.now()) { del.run(name, String(key)); return null; }
            const buf = Buffer.from(row.value);
            if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            if (type === 'json') return JSON.parse(buf.toString('utf8'));
            if (type === 'stream') return Readable.toWeb(Readable.from(buf));
            return buf.toString('utf8');
        },
        async put(key, value, opts = {}) {
            let buf;
            if (typeof value === 'string') buf = Buffer.from(value, 'utf8');
            else if (value instanceof ArrayBuffer) buf = Buffer.from(value);
            else if (ArrayBuffer.isView(value)) buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            else buf = Buffer.from(await new Response(value).arrayBuffer());
            let expires = null;
            if (opts.expirationTtl) expires = Date.now() + opts.expirationTtl * 1000;
            if (opts.expiration) expires = opts.expiration * 1000;
            put.run(name, String(key), buf, expires);
        },
        async delete(key) { del.run(name, String(key)); },
        async list(opts = {}) {
            const prefix = (opts.prefix || '').replace(/[\\%_]/g, (c) => '\\' + c);
            const rows = list.all(name, prefix + '%', opts.limit || 1000);
            return { keys: rows.map((r) => ({ name: r.key })), list_complete: true, cursor: '' };
        }
    };
}

function workerEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) env[k] = v;
    env.AI = aiBinding;
    env.STORIES = kvNamespace('STORIES');
    return env;
}

// Copy upstream code next to the server so its npm imports resolve from
// the server's node_modules.
function stage(srcFile, destName) {
    const dest = path.join(RUNTIME_DIR, destName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(srcFile, 'utf8'));
    return dest;
}

export const workers = new Map();
export const pagesFunctions = new Map();
const env = workerEnv();

export async function loadWorkers() {
    fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
    const wdir = path.join(config.upstreamDir, 'workers');
    if (fs.existsSync(wdir)) {
        for (const name of fs.readdirSync(wdir)) {
            const file = path.join(wdir, name, 'worker.js');
            if (SKIPPED_WORKERS.has(name) || !fs.existsSync(file)) continue;
            try {
                const staged = stage(file, path.join('workers', name, 'worker.mjs'));
                const mod = await import(pathToFileURL(staged).href);
                const handler = mod.default;
                if (!handler || typeof handler.fetch !== 'function') throw new Error('no default export with fetch()');
                workers.set(name, handler);
            } catch (e) {
                console.warn(`[workers] ${name} not loaded: ${e.message}`);
            }
        }
    }
    const fdir = path.join(config.upstreamDir, 'functions', 'api');
    if (fs.existsSync(fdir)) {
        for (const file of fs.readdirSync(fdir)) {
            if (!file.endsWith('.js') || SKIPPED_FUNCTIONS.has(file.replace(/\.js$/, ''))) continue;
            try {
                const staged = stage(path.join(fdir, file), path.join('functions', 'api', file.replace(/\.js$/, '.mjs')));
                const mod = await import(pathToFileURL(staged).href);
                pagesFunctions.set(file.replace(/\.js$/, ''), mod);
            } catch (e) {
                console.warn(`[functions/api] ${file} not loaded: ${e.message}`);
            }
        }
    }
    console.log(`[workers] loaded: ${[...workers.keys()].join(', ') || 'none'}; /api: ${[...pagesFunctions.keys()].join(', ') || 'none'}`);
}

async function readBody(req, limit = 30 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

// Browser cookies belong to this server, and the generic /api proxies would
// forward them (and Authorization) to whatever site they fetch. Workers keep
// Authorization: the Pinterest worker reads the user's token from it.
async function toRequest(req, url, stripAuth) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k.startsWith(':')) continue;
        if (k === 'host' || k === 'connection' || k === 'content-length' || k === 'cookie') continue;
        if (stripAuth && k === 'authorization') continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    headers.set('Origin', TRUSTED_ORIGIN);
    if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', req.socket.remoteAddress || '');
    const init = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        init.body = await readBody(req);
        init.duplex = 'half';
    }
    return new Request(url, init);
}

async function sendResponse(res, response) {
    const headers = {};
    response.headers.forEach((v, k) => {
        // Bodies from fetch() are already decoded; drop the stale encoding headers.
        if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') return;
        if (k === 'set-cookie') return;
        headers[k] = v;
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) headers['set-cookie'] = cookies;
    res.writeHead(response.status, headers);
    if (!response.body) { res.end(); return; }
    Readable.fromWeb(response.body).on('error', () => res.destroy()).pipe(res);
}

const ctx = () => ({ waitUntil: (p) => { Promise.resolve(p).catch(() => { }); }, passThroughOnException: () => { } });

// /__rk/w/<worker>/<rest>  ->  worker sees  <origin>/<rest>
export async function handleWorker(req, res, name, rest, search, origin) {
    const handler = workers.get(name);
    if (!handler) return false;
    const request = await toRequest(req, `${origin}/${rest}${search}`);
    const started = Date.now();
    const response = await withPublicNetworkOnly(() => handler.fetch(request, env, ctx()));
    // Path and status only (no query, headers or bodies): pages such as Substack
    // hide failed requests behind an empty list, so the log is where to look.
    console.log(`[workers] ${name} ${req.method} /${rest} -> ${response.status} (${Date.now() - started} ms)`);
    await sendResponse(res, response);
    return true;
}

// After an origin rate-limits a function, answer from the last good copy for a
// while instead of waiting through the function's own retries.
const COOLDOWN_MS = 2 * 60 * 1000;
const cooldownUntil = new Map();

// /api/<name>
export async function handlePagesFunction(req, res, name, url) {
    const mod = pagesFunctions.get(name);
    if (!mod) return false;
    if (req.method === 'GET' && (cooldownUntil.get(name) || 0) > Date.now()) {
        const good = lastGood(url);
        if (good) {
            const h = new Headers(good.headers);
            h.set('X-RK-Stale', '1');
            await sendResponse(res, new Response(good.body, { status: 200, headers: h }));
            return true;
        }
    }
    const method = req.method.charAt(0) + req.method.slice(1).toLowerCase();
    const fn = mod[`onRequest${method}`] || mod.onRequest;
    if (typeof fn !== 'function') {
        res.writeHead(405).end();
        return true;
    }
    const request = await toRequest(req, url, true);
    const c = ctx();
    let response = await withPublicNetworkOnly(() => fn({
        request, env, params: {}, data: {}, functionPath: `/api/${name}`,
        waitUntil: c.waitUntil, passThroughOnException: c.passThroughOnException,
        next: async () => new Response('Not found', { status: 404 })
    }));
    if (req.method === 'GET') {
        if (response.status === 200 && !/no-store/i.test(response.headers.get('cache-control') || '')) {
            // Keep the last good copy (feeds, images) for when the origin rate-limits us.
            const body = new Uint8Array(await response.arrayBuffer());
            const headers = [];
            response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers.push([k, v]); });
            rememberGood(url, 200, headers, body);
            response = new Response(body, { status: 200, headers });
        } else if (response.status === 429 || response.status >= 500) {
            if (response.status === 429) cooldownUntil.set(name, Date.now() + COOLDOWN_MS);
            const good = lastGood(url);
            if (good) {
                const h = new Headers(good.headers);
                h.set('X-RK-Stale', '1');
                response = new Response(good.body, { status: 200, headers: h });
            }
        }
    }
    await sendResponse(res, response);
    return true;
}
