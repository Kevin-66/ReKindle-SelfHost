// HTTP endpoints under /__rk/ used by client/rk-backend.js.

import fs from 'node:fs';
import { config } from './config.js';
import * as auth from './auth.js';
import { rtdb, valueHash } from './rtdb.js';
import * as fsStore from './firestore.js';
import * as storage from './storage.js';
import { currentSeq, waitForChanges } from './events.js';
import { invokeCallable, errorStatus } from './functions-host.js';
import { handleWorker } from './workers-host.js';
import * as manhuagui from './manhuagui.js';
import * as mangaState from './manga-state.js';
import { handleImage, pageOptions, sendImage, serveImage } from './images.js';
import { listBooks } from './zlibrary.js';
import * as zlibAccount from './zlibrary-account.js';
import * as notesAgent from './notes-agent.js';
import { Readable } from 'node:stream';

const MAX_JSON = 16 * 1024 * 1024;

export function clientIp(req) {
    if (config.trustProxy) {
        const fwd = req.headers['x-forwarded-for'];
        if (fwd) return String(fwd).split(',')[0].trim().replace(/^::ffff:/, '');
    }
    return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function publicOrigin(req) {
    const proto = (config.trustProxy && req.headers['x-forwarded-proto']) ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http');
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
    return `${proto}://${host}`;
}

function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-RK-Time': String(Date.now())
    });
    res.end(body);
}

function sendError(res, e) {
    const status = e.status || errorStatus(e) || 500;
    const code = e.code || 'internal';
    if (status >= 500) console.error('[api]', e);
    send(res, status, { error: { code, message: status >= 500 && !e.code ? 'Internal server error' : e.message, details: e.details } });
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > MAX_JSON) throw Object.assign(new Error('Request too large'), { status: 413, code: 'invalid-argument' });
        chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Invalid JSON'), { status: 400, code: 'invalid-argument' });
    }
}

function bearer(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? auth.verifyIdToken(m[1].trim()) : null;
}

// Very small per-IP limiter for password guessing.
const attempts = new Map();
function rateLimit(req, key, max, windowMs) {
    const id = `${key}|${clientIp(req)}`;
    const now = Date.now();
    const list = (attempts.get(id) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
        throw Object.assign(new Error('Too many attempts. Please wait a minute and try again.'), { status: 429, code: 'auth/too-many-requests' });
    }
    list.push(now);
    attempts.set(id, list);
}
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of attempts) if (!v.some((t) => now - t < 600000)) attempts.delete(k);
}, 600000).unref();

// ---------------------------------------------------------------- handlers

async function handleAuth(req, res, action) {
    const body = await readJson(req);
    switch (action) {
        case 'signin':
            rateLimit(req, 'signin', 10, 60000);
            return send(res, 200, auth.signInWithPassword(body.email, body.password, body.ns));
        case 'signup': {
            rateLimit(req, 'signup', 5, 60000);
            if (!auth.canRegister(String(body.email || '').split('@')[0])) throw new auth.AuthError('auth/operation-not-allowed', auth.registrationClosedMessage(), 403);
            const u = auth.createUser({ email: body.email, password: body.password });
            fsStore.ensureProfile(u.uid);
            return send(res, 200, auth.signInWithPassword(body.email, body.password, body.ns));
        }
        case 'custom':
            return send(res, 200, auth.signInWithCustomToken(body.token, body.ns));
        case 'refresh':
            return send(res, 200, auth.refreshSession(body.refreshToken));
        case 'signout':
            auth.signOut(body.refreshToken);
            return send(res, 200, {});
        case 'update': {
            const me = bearer(req);
            if (!me) throw new auth.AuthError('auth/requires-recent-login', 'Please sign in again.', 401);
            const u = auth.updateUser(me.uid, { password: body.password, displayName: body.displayName, photoURL: body.photoURL });
            return send(res, 200, { idToken: auth.mintIdToken(u, body.ns, me.firebase && me.firebase.sign_in_provider), user: auth.publicUser(u) });
        }
        case 'delete': {
            const me = bearer(req);
            if (!me) throw new auth.AuthError('auth/requires-recent-login', 'Please sign in again.', 401);
            auth.deleteUser(me.uid);
            return send(res, 200, {});
        }
        default:
            return send(res, 404, { error: { code: 'not-found', message: 'Unknown auth action' } });
    }
}

async function handleFs(req, res) {
    const body = await readJson(req);
    const me = bearer(req);
    switch (body.op) {
        case 'get':
            return send(res, 200, { doc: fsStore.getDoc(body.path, me), s: currentSeq() });
        case 'query':
            return send(res, 200, { docs: fsStore.runQuery(body.path, body.q, me), s: currentSeq() });
        case 'commit': {
            const r = fsStore.commit(body.writes, body.reads, me);
            return send(res, 200, { ok: true, s: r.seq });
        }
        default:
            return send(res, 400, { error: { code: 'invalid-argument', message: 'Unknown operation' } });
    }
}

async function handleDb(req, res) {
    const body = await readJson(req);
    const me = bearer(req);
    const ns = body.ns;
    switch (body.op) {
        case 'get': {
            const s = currentSeq();
            const val = rtdb.get(ns, body.path, body.q || null, me);
            const out = { val, s };
            if (body.hash) out.hash = valueHash(val);
            return send(res, 200, out);
        }
        case 'set':
            rtdb.set(ns, body.path, body.value, me);
            return send(res, 200, { s: currentSeq() });
        case 'update':
            rtdb.update(ns, body.path, body.values, me);
            return send(res, 200, { s: currentSeq() });
        case 'tx': {
            const r = rtdb.transaction(ns, body.path, body.expect, body.value, me);
            return send(res, 200, { ...r, s: currentSeq() });
        }
        case 'od':
            rtdb.onDisconnect(body.cid, ns, body.path, body.action, body.value, me);
            return send(res, 200, {});
        case 'odcancel':
            rtdb.cancelDisconnect(body.cid, ns, body.path);
            return send(res, 200, {});
        default:
            return send(res, 400, { error: { code: 'invalid-argument', message: 'Unknown operation' } });
    }
}

async function handlePoll(req, res) {
    const body = await readJson(req);
    const cid = typeof body.cid === 'string' ? body.cid.slice(0, 64) : null;
    const watches = Array.isArray(body.w) ? body.w.slice(0, 500).filter((w) => Array.isArray(w) && w.length === 4) : [];
    if (cid) rtdb.pollStarted(cid);
    let cancel = null;
    let closed = false;
    res.on('close', () => { closed = true; if (cancel) cancel(); });
    try {
        const result = await waitForChanges(body.since, watches, 25000, (fn) => { cancel = fn; });
        if (!closed) send(res, 200, result);
    } finally {
        if (cid) rtdb.pollEnded(cid);
    }
}

async function handleFunction(req, res, name) {
    const body = await readJson(req);
    const me = bearer(req);
    const headers = { ...req.headers };
    if (!config.trustProxy) delete headers['x-forwarded-for'];
    try {
        const result = await invokeCallable(name, body.data, me, { headers, ip: clientIp(req), method: req.method });
        send(res, 200, { result: result === undefined ? null : result });
    } catch (e) {
        const code = typeof e.code === 'string' ? e.code.replace(/^functions\//, '') : 'internal';
        const known = !!(e.httpErrorCode);
        const status = known ? e.httpErrorCode.status : 500;
        if (!known) console.error(`[functions] ${name} failed:`, e);
        send(res, status, { error: { code: known ? code : 'internal', message: known ? e.message : 'INTERNAL', details: e.details } });
    }
}

async function handleStorage(req, res, action, rest, url) {
    const origin = publicOrigin(req);
    if (action === 'dl') {
        const found = storage.openDownload(decodeURIComponent(rest), url.searchParams.get('t'));
        if (!found) return send(res, 404, { error: { code: 'storage/object-not-found', message: 'Not found' } });
        const meta = found.row.meta ? JSON.parse(found.row.meta) : {};
        const headers = {
            'Content-Type': found.row.type || 'application/octet-stream',
            'Content-Length': found.row.size,
            'Cache-Control': meta.cacheControl || 'private, max-age=3600'
        };
        if (meta.contentDisposition) headers['Content-Disposition'] = meta.contentDisposition;
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(found.file).pipe(res);
        return;
    }
    const me = bearer(req);
    if (action === 'upload') {
        let meta = {};
        try { meta = JSON.parse(decodeURIComponent(req.headers['x-rk-meta'] || '%7B%7D')); } catch { meta = {}; }
        if (!meta.contentType && req.headers['content-type']) meta.contentType = req.headers['content-type'];
        const r = await storage.upload(req, me, decodeURIComponent(req.headers['x-rk-path'] || ''), meta, origin);
        return send(res, 200, r);
    }
    const body = await readJson(req);
    switch (action) {
        case 'meta':
            return send(res, 200, storage.getMeta(me, body.path, body.update, origin));
        case 'delete':
            storage.remove(me, body.path);
            return send(res, 200, {});
        case 'list':
            return send(res, 200, storage.list(me, body.path, body.max, body.page));
        default:
            return send(res, 404, { error: { code: 'not-found', message: 'Unknown storage action' } });
    }
}

// Manga sources (Manhuagui) for the Manga app's add-on script.
async function handleManga(req, res, url, parts) {
    if (parts[2] === 'img') {
        const u = url.searchParams.get('u');
        const k = url.searchParams.get('k');
        // With ?page=1: a Manga reader page, unchanged but not cached by the browser (images.js).
        const opts = pageOptions(url.searchParams);
        if (opts) return await sendImage(req, res, () => serveImage(`mhg:${u}:${k}`, [() => manhuagui.proxyImage(u, k)], opts));
        const r = await manhuagui.proxyImage(u, k);
        res.writeHead(200, {
            'Content-Type': r.headers.get('content-type') || 'image/jpeg',
            'Cache-Control': 'public, max-age=604800, immutable'
        });
        Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
        return;
    }
    if (parts[2] === 'state') {
        // The signed-in reader's library and progress (manga-state.js).
        const me = bearer(req);
        if (!me) return send(res, 401, { error: { code: 'unauthenticated', message: 'Sign in to ReKindle to keep your Manga library.' } });
        if (req.method === 'GET') return send(res, 200, mangaState.getState(me.uid));
        if (req.method === 'PUT') return send(res, 200, mangaState.putState(me.uid, await readJson(req)));
        return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET or PUT' } });
    }
    if (!bearer(req)) return send(res, 401, { error: { code: 'unauthenticated', message: 'Sign in to ReKindle to browse Manhuagui.' } });
    const p = url.searchParams;
    if (parts[2] !== 'manhuagui') return send(res, 404, { error: { code: 'not-found', message: 'Unknown manga source' } });
    switch (parts[3]) {
        case 'filters':
            return send(res, 200, { sorts: manhuagui.SORTS, genres: manhuagui.GENRES });
        case 'list':
            return send(res, 200, await manhuagui.list({ q: (p.get('q') || '').trim(), sort: p.get('sort'), genre: p.get('genre'), page: p.get('page') }));
        case 'details':
            return send(res, 200, await manhuagui.details(p.get('id')));
        case 'pages':
            return send(res, 200, await manhuagui.pages(p.get('chapter')));
        default:
            return send(res, 404, { error: { code: 'not-found', message: 'Unknown manga action' } });
    }
}

async function readBody(req, max) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > max) throw Object.assign(new Error(`The note is larger than ${Math.round(max / 1024)} KB.`), { status: 413, code: 'invalid-argument' });
        chunks.push(c);
    }
    return Buffer.concat(chunks);
}

// Notes agent link (notes-agent.js). The link itself is the permission: no sign-in,
// open to any origin, so agents and scripts anywhere can use it.
async function handleNotes(req, res, url, parts) {
    if (parts[2] === 'agent' && parts[3]) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        rateLimit(req, 'notes-agent', 120, 60000);
        const uid = notesAgent.ownerOf(parts[3]);
        if (!uid) return send(res, 404, { error: { code: 'not-found', message: 'This agent link does not exist or was replaced.' } });
        const rest = parts.slice(4);
        const body = async () => notesAgent.parseBody(await readBody(req, notesAgent.MAX_BYTES), req.headers['content-type'], url.searchParams);
        if (!rest.length && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(notesAgent.usage(publicOrigin(req), parts[3]));
            return;
        }
        if (!rest.length || (rest.length === 1 && rest[0] === 'notes')) {
            if (req.method === 'GET') return send(res, 200, notesAgent.listNotes(uid, url.searchParams.get('q')));
            if (req.method === 'POST') return send(res, 201, notesAgent.addNote(uid, await body()));
            return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET to list notes or POST to add one.' } });
        }
        if (rest.length === 2 && rest[0] === 'notes') {
            const id = decodeURIComponent(rest[1]);
            if (req.method === 'GET') return send(res, 200, notesAgent.readNote(uid, id));
            if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') return send(res, 200, notesAgent.editNote(uid, id, await body()));
            if (req.method === 'DELETE') return send(res, 200, notesAgent.deleteNote(uid, id));
            return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET, PATCH, PUT or DELETE.' } });
        }
        return send(res, 404, { error: { code: 'not-found', message: 'Not found. Open the agent link itself for instructions.' } });
    }
    if (parts[2] === 'agent-link') {
        const me = bearer(req);
        if (!me) return send(res, 401, { error: { code: 'unauthenticated', message: 'Sign in to ReKindle first.' } });
        if (req.method === 'GET') return send(res, 200, notesAgent.agentLink(me.uid, publicOrigin(req)));
        if (req.method === 'POST') return send(res, 200, { url: notesAgent.resetLink(me.uid, publicOrigin(req)).url });
        return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET or POST' } });
    }
    return send(res, 404, { error: { code: 'not-found', message: 'Not found' } });
}

export async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['__rk', ...]
    const section = parts[1];
    try {
        if (section === 'health') return send(res, 200, { ok: true });
        if (section === 'w') {
            const name = parts[2];
            const rest = parts.slice(3).join('/') + (url.pathname.endsWith('/') && parts.length > 3 ? '/' : '');
            const handled = await handleWorker(req, res, name, rest, url.search, publicOrigin(req));
            if (!handled) send(res, 404, { error: { code: 'not-found', message: `Service ${name} is not available on this server.` } });
            return;
        }
        if (section === 'st') return await handleStorage(req, res, parts[2], parts.slice(3).join('/'), url);
        if (section === 'manga') return await handleManga(req, res, url, parts);
        if (section === 'img') return await handleImage(req, res, url);
        if (section === 'notes') return await handleNotes(req, res, url, parts);
        if (section === 'zlibrary') {
            // The reader's Z-Library cookie and downloads with it (zlibrary-account.js).
            if (parts[2] === 'download') return await zlibAccount.sendDownload(res, url.searchParams.get('t'));
            if (parts[2] === 'account' || parts[2] === 'jobs') {
                const me = bearer(req);
                if (!me) return send(res, 401, { error: { code: 'unauthenticated', message: 'Sign in to ReKindle first.' } });
                if (parts[2] === 'jobs') {
                    // POST /jobs {url} starts a download (and MOBI conversion); GET /jobs/<id> reports on it.
                    if (req.method === 'GET' && parts[3]) return send(res, 200, zlibAccount.jobStatus(me.uid, parts[3]));
                    if (req.method !== 'POST' || parts[3]) return send(res, 405, { error: { code: 'invalid-argument', message: 'Use POST /jobs or GET /jobs/<id>' } });
                    rateLimit(req, 'zlibrary-download', 20, 60000);
                    return send(res, 200, zlibAccount.startJob(me.uid, (await readJson(req)).url));
                }
                if (req.method === 'GET') return send(res, 200, zlibAccount.accountStatus(me.uid));
                if (req.method === 'PUT') return send(res, 200, zlibAccount.saveAccount(me.uid, (await readJson(req)).cookie));
                if (req.method === 'DELETE') return send(res, 200, zlibAccount.removeAccount(me.uid));
                return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET, PUT or DELETE' } });
            }
            if (req.method !== 'GET') return send(res, 405, { error: { code: 'invalid-argument', message: 'Use GET' } });
            rateLimit(req, 'zlibrary', 30, 60000);
            return send(res, 200, await listBooks(url.searchParams.get('q') || '', Number(url.searchParams.get('page') || 1)));
        }
        if (req.method !== 'POST') return send(res, 405, { error: { code: 'invalid-argument', message: 'Use POST' } });
        switch (section) {
            case 'auth': return await handleAuth(req, res, parts[2]);
            case 'fs': return await handleFs(req, res);
            case 'db': return await handleDb(req, res);
            case 'poll': return await handlePoll(req, res);
            case 'bye': {
                const cid = url.searchParams.get('cid');
                if (cid) rtdb.fireDisconnect(cid);
                req.resume();
                return send(res, 200, {});
            }
            case 'fn': return await handleFunction(req, res, decodeURIComponent(parts[2] || ''));
            default: return send(res, 404, { error: { code: 'not-found', message: 'Not found' } });
        }
    } catch (e) {
        if (!res.headersSent) sendError(res, e);
        else res.destroy();
    }
}
