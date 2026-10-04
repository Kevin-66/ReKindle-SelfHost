// In-memory JSON tree per namespace with Firebase Realtime Database semantics,
// persisted to SQLite (one row per top-level key).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { config, NS_MAIN, normalizeNs } from './config.js';
import { emit } from './events.js';
import { adminEmail } from './auth.js';
import { compileRules, canRead, canWrite, splitPath, getIn } from './rtdb-rules.js';

export class DbError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------- ordering

const INT_KEY = /^-?(0|[1-9][0-9]*)$/;
function isIntKey(k) {
    if (!INT_KEY.test(k)) return false;
    const n = parseInt(k, 10);
    return n >= -2147483648 && n <= 2147483647;
}
export function keyCompare(a, b) {
    if (a === b) return 0;
    const ai = isIntKey(a), bi = isIntKey(b);
    if (ai && bi) return parseInt(a, 10) - parseInt(b, 10);
    if (ai) return -1;
    if (bi) return 1;
    return a < b ? -1 : 1;
}
function rank(v) {
    if (v === null || v === undefined) return 0;
    if (v === false) return 1;
    if (v === true) return 2;
    if (typeof v === 'number') return 3;
    if (typeof v === 'string') return 4;
    return 5;
}
export function valueCompare(a, b) {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 3) return a - b;
    if (ra === 4) return a < b ? -1 : (a > b ? 1 : 0);
    return 0;
}

// ---------------------------------------------------------------- values

function resolveServerValue(sv, current) {
    if (sv === 'timestamp') return Date.now();
    if (sv && typeof sv === 'object' && hasOwn(sv, 'increment')) {
        const delta = Number(sv.increment) || 0;
        return (typeof current === 'number' ? current : 0) + delta;
    }
    throw new DbError('invalid-argument', 'Unknown server value');
}

// Convert a written value to the stored form: no arrays, no nulls, no empty objects.
export function normalize(value, current) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        const out = {};
        value.forEach((v, i) => {
            const n = normalize(v, current && typeof current === 'object' ? current[String(i)] : null);
            if (n !== null) out[String(i)] = n;
        });
        return Object.keys(out).length ? out : null;
    }
    if (typeof value === 'object') {
        if (hasOwn(value, '.sv')) return resolveServerValue(value['.sv'], current);
        if (hasOwn(value, '.value')) return normalize(value['.value'], current);
        const out = {};
        for (const k of Object.keys(value)) {
            if (k === '.priority') continue;
            if (k === '' || /[.#$\[\]]/.test(k) || k.includes('/')) {
                throw new DbError('invalid-argument', `Invalid key "${k}": keys must not contain ".", "#", "$", "[", "]" or "/"`);
            }
            const n = normalize(value[k], current && typeof current === 'object' ? current[k] : null);
            if (n !== null) out[k] = n;
        }
        return Object.keys(out).length ? out : null;
    }
    return null;
}

// Path-copying set: returns a new tree, the old one is untouched.
export function setIn(tree, parts, value) {
    if (!parts.length) return value;
    const [head, ...rest] = parts;
    const base = (tree && typeof tree === 'object') ? tree : {};
    const child = setIn(hasOwn(base, head) ? base[head] : null, rest, value);
    const copy = { ...base };
    if (child === null) delete copy[head];
    else copy[head] = child;
    return Object.keys(copy).length ? copy : null;
}

// Stored form -> what clients see (array-like objects become arrays).
export function toOutput(v) {
    if (v === null || typeof v !== 'object') return v;
    const keys = Object.keys(v);
    let allInts = keys.length > 0;
    let max = -1;
    for (const k of keys) {
        if (!/^(0|[1-9][0-9]*)$/.test(k)) { allInts = false; break; }
        max = Math.max(max, parseInt(k, 10));
    }
    if (allInts && keys.length * 2 > max) {
        const arr = new Array(max + 1).fill(null);
        for (const k of keys) arr[parseInt(k, 10)] = toOutput(v[k]);
        return arr;
    }
    const out = {};
    for (const k of keys) out[k] = toOutput(v[k]);
    return out;
}

function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

export function valueHash(v) {
    return crypto.createHash('sha1').update(canonical(v)).digest('hex');
}

// ---------------------------------------------------------------- queries

function childValue(v, childPath) {
    return getIn(v, splitPath(childPath));
}

export function applyQuery(v, q) {
    if (!q || v === null || typeof v !== 'object') return v;
    const ob = q.orderBy || 'key';
    const orderVal = (k) => (ob === 'key' ? k : ob === 'value' ? v[k] : childValue(v[k], q.child));
    let keys = Object.keys(v);
    keys.sort((a, b) => {
        if (ob === 'key') return keyCompare(a, b);
        return valueCompare(orderVal(a), orderVal(b)) || keyCompare(a, b);
    });
    const cmp = (k, bound) => {
        const bv = bound[0];
        let c = ob === 'key' ? keyCompare(k, String(bv)) : valueCompare(orderVal(k), bv);
        if (c === 0 && bound.length > 1 && bound[1] !== null && bound[1] !== undefined && ob !== 'key') c = keyCompare(k, String(bound[1]));
        return { c, hasKey: bound.length > 1 && bound[1] !== null && bound[1] !== undefined };
    };
    keys = keys.filter((k) => {
        if (q.equalTo) { if (cmp(k, q.equalTo).c !== 0) return false; }
        if (q.startAt) { if (cmp(k, q.startAt).c < 0) return false; }
        if (q.startAfter) {
            const r = cmp(k, q.startAfter);
            if (r.c < 0 || (r.c === 0)) return false;
        }
        if (q.endAt) { if (cmp(k, q.endAt).c > 0) return false; }
        if (q.endBefore) {
            const r = cmp(k, q.endBefore);
            if (r.c > 0 || r.c === 0) return false;
        }
        return true;
    });
    if (typeof q.limitToFirst === 'number') keys = keys.slice(0, Math.max(0, q.limitToFirst));
    if (typeof q.limitToLast === 'number') keys = q.limitToLast > 0 ? keys.slice(-q.limitToLast) : [];
    const out = {};
    for (const k of keys) out[k] = v[k];
    return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- store

function loadRulesFile(name) {
    const p = path.join(config.upstreamDir, name);
    try {
        return compileRules(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) {
        console.warn(`[rtdb] could not load ${name} (${e.message}); only admin access will be allowed`);
        return compileRules({ rules: {} });
    }
}

class Rtdb {
    constructor() {
        this.trees = new Map([[NS_MAIN, null]]);
        this.dirty = new Map();
        this.flushTimer = null;
        this.rules = new Map([[NS_MAIN, loadRulesFile('rtdb-rules.json')]]);
        for (const row of db.prepare('SELECT ns, key, data FROM rtdb').iterate()) {
            const ns = normalizeNs(row.ns);
            const tree = this.trees.get(ns) || {};
            tree[row.key] = JSON.parse(row.data);
            this.trees.set(ns, tree);
        }
        // onDisconnect operations by client id
        this.disconnectOps = new Map();
        this.lastSeen = new Map();
        this.activePolls = new Map();
        setInterval(() => this.sweepDisconnects(), 5000).unref();
    }

    root(ns) {
        return this.trees.get(normalizeNs(ns)) || null;
    }

    authCtx(auth) {
        if (!auth || auth.internal) return null;
        return { uid: auth.uid, provider: 'password', token: auth };
    }

    checkRead(ns, auth, p) {
        if (auth && auth.internal) return;
        ns = normalizeNs(ns);
        if (!canRead(this.rules.get(ns), this.authCtx(auth), adminEmail(), this.root(ns), p)) {
            throw new DbError('PERMISSION_DENIED', `permission_denied at /${p}: Client doesn't have permission to access the desired data.`, 403);
        }
    }

    get(ns, p, q, auth) {
        p = splitPath(p).join('/');
        this.checkRead(ns, auth, p);
        const raw = getIn(this.root(ns), splitPath(p));
        return toOutput(applyQuery(raw, q));
    }

    // Apply several [path, value] writes atomically.
    writeMulti(ns, entries, auth) {
        ns = normalizeNs(ns);
        const oldRoot = this.root(ns);
        let newRoot = oldRoot;
        const normalized = [];
        for (const [p, value] of entries) {
            const parts = splitPath(p);
            const current = getIn(newRoot, parts);
            const nv = normalize(value, current);
            newRoot = setIn(newRoot, parts, nv);
            normalized.push(parts);
        }
        if (!(auth && auth.internal)) {
            const rules = this.rules.get(ns);
            const a = this.authCtx(auth);
            const admin = adminEmail();
            for (const parts of normalized) {
                if (!canWrite(rules, a, admin, oldRoot, newRoot, parts.join('/'))) {
                    throw new DbError('PERMISSION_DENIED', `permission_denied at /${parts.join('/')}: Client doesn't have permission to access the desired data.`, 403);
                }
            }
        }
        this.commit(ns, newRoot, normalized);
    }

    commit(ns, newRoot, pathsParts) {
        this.trees.set(ns, newRoot);
        let dirty = this.dirty.get(ns);
        if (!dirty) { dirty = new Set(); this.dirty.set(ns, dirty); }
        let all = false;
        for (const parts of pathsParts) {
            if (!parts.length) all = true;
            else dirty.add(parts[0]);
        }
        if (all) dirty.add('*');
        this.scheduleFlush();
        for (const parts of pathsParts) emit('db', ns, parts.join('/'));
    }

    set(ns, p, value, auth) {
        this.writeMulti(ns, [[p, value]], auth);
    }

    update(ns, p, values, auth) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            throw new DbError('invalid-argument', 'update() expects an object');
        }
        const base = splitPath(p).join('/');
        const entries = Object.keys(values).map((k) => [base ? `${base}/${k}` : k, values[k]]);
        if (!entries.length) return;
        this.writeMulti(ns, entries, auth);
    }

    push(ns, p, value, auth) {
        const key = pushId();
        const full = splitPath(p).concat(key).join('/');
        this.writeMulti(ns, [[full, value]], auth);
        return key;
    }

    // Compare-and-set used by transactions.
    transaction(ns, p, expectHash, value, auth) {
        p = splitPath(p).join('/');
        this.checkRead(ns, auth, p);
        const current = toOutput(getIn(this.root(ns), splitPath(p)));
        if (valueHash(current) !== expectHash) return { ok: false };
        this.writeMulti(ns, [[p, value]], auth);
        return { ok: true, val: toOutput(getIn(this.root(ns), splitPath(p))) };
    }

    scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 250);
    }

    flush() {
        const upsert = db.prepare('INSERT INTO rtdb(ns, key, data) VALUES(?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET data = excluded.data');
        const del = db.prepare('DELETE FROM rtdb WHERE ns = ? AND key = ?');
        db.exec('BEGIN');
        try {
            for (const [ns, keys] of this.dirty) {
                const tree = this.root(ns) || {};
                if (keys.has('*')) {
                    db.prepare('DELETE FROM rtdb WHERE ns = ?').run(ns);
                    for (const k of Object.keys(tree)) upsert.run(ns, k, JSON.stringify(tree[k]));
                    continue;
                }
                for (const k of keys) {
                    if (hasOwn(tree, k)) upsert.run(ns, k, JSON.stringify(tree[k]));
                    else del.run(ns, k);
                }
            }
            db.exec('COMMIT');
            this.dirty.clear();
        } catch (e) {
            db.exec('ROLLBACK');
            console.error('[rtdb] flush failed:', e);
            this.scheduleFlush();
        }
    }

    // ------------------------------------------------ onDisconnect / presence

    touch(cid) {
        if (cid) this.lastSeen.set(cid, Date.now());
    }

    pollStarted(cid) {
        this.touch(cid);
        this.activePolls.set(cid, (this.activePolls.get(cid) || 0) + 1);
    }

    pollEnded(cid) {
        this.touch(cid);
        const n = (this.activePolls.get(cid) || 1) - 1;
        if (n <= 0) this.activePolls.delete(cid);
        else this.activePolls.set(cid, n);
    }

    onDisconnect(cid, ns, p, action, value, auth) {
        if (!cid) throw new DbError('invalid-argument', 'Missing client id');
        ns = normalizeNs(ns);
        p = splitPath(p).join('/');
        const entries = action === 'update'
            ? Object.keys(value || {}).map((k) => [p ? `${p}/${k}` : k, value[k]])
            : [[p, action === 'set' ? value : null]];
        // Check permission now against current data, like Firebase does.
        if (!(auth && auth.internal)) {
            const oldRoot = this.root(ns);
            let newRoot = oldRoot;
            for (const [ep, ev] of entries) newRoot = setIn(newRoot, splitPath(ep), normalize(ev, getIn(newRoot, splitPath(ep))));
            for (const [ep] of entries) {
                if (!canWrite(this.rules.get(ns), this.authCtx(auth), adminEmail(), oldRoot, newRoot, ep)) {
                    throw new DbError('PERMISSION_DENIED', `permission_denied at /${ep}: Client doesn't have permission to access the desired data.`, 403);
                }
            }
        }
        const list = this.disconnectOps.get(cid) || [];
        list.push({ ns, path: p, entries });
        this.disconnectOps.set(cid, list);
        this.touch(cid);
    }

    cancelDisconnect(cid, ns, p) {
        ns = normalizeNs(ns);
        p = splitPath(p).join('/');
        const list = this.disconnectOps.get(cid);
        if (!list) return;
        const kept = list.filter((op) => !(op.ns === ns && (op.path === p || op.path.startsWith(p ? p + '/' : ''))));
        if (kept.length) this.disconnectOps.set(cid, kept);
        else this.disconnectOps.delete(cid);
    }

    fireDisconnect(cid) {
        const list = this.disconnectOps.get(cid);
        this.disconnectOps.delete(cid);
        this.lastSeen.delete(cid);
        this.activePolls.delete(cid);
        if (!list) return;
        for (const op of list) {
            try {
                this.writeMulti(op.ns, op.entries, { internal: true });
            } catch (e) {
                console.warn('[rtdb] onDisconnect write failed:', e.message);
            }
        }
    }

    sweepDisconnects() {
        const now = Date.now();
        for (const cid of [...this.disconnectOps.keys()]) {
            if (this.activePolls.get(cid)) continue;
            const seen = this.lastSeen.get(cid) || 0;
            if (now - seen > 35000) this.fireDisconnect(cid);
        }
        for (const [cid, seen] of this.lastSeen) {
            if (!this.disconnectOps.has(cid) && !this.activePolls.get(cid) && now - seen > 120000) this.lastSeen.delete(cid);
        }
    }
}

// Firebase push ids: time-ordered, 20 chars.
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastPushTime = 0;
const lastRand = [];
export function pushId() {
    let now = Date.now();
    const dup = now === lastPushTime;
    lastPushTime = now;
    const timeChars = new Array(8);
    for (let i = 7; i >= 0; i--) { timeChars[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
    let id = timeChars.join('');
    if (!dup) {
        for (let i = 0; i < 12; i++) lastRand[i] = Math.floor(Math.random() * 64);
    } else {
        let i;
        for (i = 11; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0;
        if (i >= 0) lastRand[i]++;
    }
    for (let i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRand[i]);
    return id;
}

export const rtdb = new Rtdb();

process.on('exit', () => rtdb.flush());
