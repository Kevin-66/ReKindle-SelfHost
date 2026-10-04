// Document store with Cloud Firestore semantics, kept in SQLite.

import { db, transaction } from './db.js';
import { config } from './config.js';
import { emit, currentSeq } from './events.js';
import { isAdminEmail } from './auth.js';
import { allowed, makeIsPro } from './firestore-rules.js';
import {
    compareValues, valuesEqual, sameTypeClass, getField, resolveValue, deepMerge,
    setField, affectedKeys, isMap
} from './fsvalues.js';

export class FsError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

// ReKindle+ is unlocked by this date on the user's profile document.
const PLUS_UNTIL = { $ts: [4102444800, 0] }; // 2100-01-01

function splitPath(p) {
    return String(p || '').split('/').filter(Boolean);
}

function validDocPath(p) {
    const parts = splitPath(p);
    return parts.length >= 2 && parts.length % 2 === 0;
}

function parentOf(path) {
    const parts = splitPath(path);
    parts.pop();
    return parts.join('/');
}

const stmts = {
    get: db.prepare('SELECT path, data, ct, ut FROM fs_docs WHERE ns = ? AND path = ?'),
    byParent: db.prepare('SELECT path, data, ct, ut FROM fs_docs WHERE ns = ? AND parent = ?'),
    byColl: db.prepare('SELECT path, data, ct, ut FROM fs_docs WHERE ns = ? AND coll = ?'),
    upsert: db.prepare(`INSERT INTO fs_docs(ns, path, parent, coll, data, ct, ut) VALUES(?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(ns, path) DO UPDATE SET data = excluded.data, ut = excluded.ut`),
    del: db.prepare('DELETE FROM fs_docs WHERE ns = ? AND path = ?')
};

let lastUt = 0;
function nextUt() {
    lastUt = Math.max(Date.now(), lastUt + 1);
    return lastUt;
}

const NS = 'rekindle-dd1fa';

function rowToDoc(row) {
    return { path: row.path, exists: true, data: JSON.parse(row.data), ct: row.ct, ut: row.ut };
}

function readRaw(path) {
    const row = stmts.get.get(NS, path);
    return row ? rowToDoc(row) : { path, exists: false };
}

// Profile documents always show ReKindle+ as active on this server.
function decorate(doc) {
    if (!config.plusForAll || !doc.exists) return doc;
    const parts = splitPath(doc.path);
    if (parts.length === 2 && parts[0] === 'users') {
        return { ...doc, data: { ...doc.data, proExpiresAt: PLUS_UNTIL } };
    }
    return doc;
}

function ruleCtx(auth, extra) {
    const isAdmin = !!(auth && (auth.admin || isAdminEmail(auth.email)));
    return {
        auth,
        isAdmin,
        isPro: makeIsPro((p) => { const d = readRaw(p); return d.exists ? d.data : null; }, auth),
        ...extra
    };
}

function checkRead(auth, docPath) {
    if (auth && auth.internal) return;
    if (!allowed('read', docPath, ruleCtx(auth, { resource: null, data: null }))) {
        throw new FsError('permission-denied', 'Missing or insufficient permissions.', 403);
    }
}

export function getDoc(path, auth) {
    path = splitPath(path).join('/');
    if (!validDocPath(path)) throw new FsError('invalid-argument', `Invalid document path: ${path}`);
    checkRead(auth, path);
    return decorate(readRaw(path));
}

// ---------------------------------------------------------------- queries

function orderValue(doc, field) {
    if (field === '__name__') return splitPath(doc.path).pop();
    return getField(doc.data, field);
}

function matchesFilter(doc, [field, op, value]) {
    const v = field === '__name__' ? splitPath(doc.path).pop() : getField(doc.data, field);
    switch (op) {
        case '==': return v !== undefined && valuesEqual(v, value);
        case '!=': return v !== undefined && v !== null && !valuesEqual(v, value);
        case '<': return v !== undefined && sameTypeClass(v, value) && compareValues(v, value) < 0;
        case '<=': return v !== undefined && sameTypeClass(v, value) && compareValues(v, value) <= 0;
        case '>': return v !== undefined && sameTypeClass(v, value) && compareValues(v, value) > 0;
        case '>=': return v !== undefined && sameTypeClass(v, value) && compareValues(v, value) >= 0;
        case 'array-contains': return Array.isArray(v) && v.some((x) => valuesEqual(x, value));
        case 'array-contains-any': return Array.isArray(v) && Array.isArray(value) && v.some((x) => value.some((y) => valuesEqual(x, y)));
        case 'in': return v !== undefined && Array.isArray(value) && value.some((y) => valuesEqual(v, y));
        case 'not-in': return v !== undefined && v !== null && Array.isArray(value) && !value.some((y) => valuesEqual(v, y));
        default: throw new FsError('invalid-argument', `Unsupported query operator: ${op}`);
    }
}

const INEQUALITY = new Set(['<', '<=', '>', '>=', '!=', 'not-in']);

function cursorCompare(doc, cursor, orders) {
    const vals = cursor.values || [];
    for (let i = 0; i < vals.length && i < orders.length; i++) {
        const [field, dir] = orders[i];
        let c = compareValues(orderValue(doc, field), vals[i]);
        if (dir === 'desc') c = -c;
        if (c) return c;
    }
    if (cursor.id !== undefined && vals.length < orders.length) {
        const nameOrder = orders[orders.length - 1];
        let c = compareValues(splitPath(doc.path).pop(), String(cursor.id));
        if (nameOrder[1] === 'desc') c = -c;
        return c;
    }
    return 0;
}

export function runQuery(collPath, q, auth) {
    q = q || {};
    let rows;
    let probePath;
    if (String(collPath).startsWith('group:')) {
        const id = String(collPath).slice(6);
        rows = stmts.byColl.all(NS, id);
        probePath = null;
    } else {
        collPath = splitPath(collPath).join('/');
        if (splitPath(collPath).length % 2 !== 1) throw new FsError('invalid-argument', `Invalid collection path: ${collPath}`);
        rows = stmts.byParent.all(NS, collPath);
        probePath = `${collPath}/__any__`;
    }
    if (probePath) checkRead(auth, probePath);

    let docs = rows.map(rowToDoc);
    // Collection-group queries: only keep documents the caller may read.
    if (!probePath && !(auth && auth.internal)) {
        docs = docs.filter((d) => {
            try { checkRead(auth, d.path); return true; } catch { return false; }
        });
    }
    docs = docs.map(decorate);

    const filters = q.where || [];
    docs = docs.filter((d) => filters.every((f) => matchesFilter(d, f)));

    const orders = (q.orderBy || []).map(([f, dir]) => [f, dir === 'desc' ? 'desc' : 'asc']);
    if (!orders.length) {
        const ineq = filters.find((f) => INEQUALITY.has(f[1]) && f[0] !== '__name__');
        if (ineq) orders.push([ineq[0], 'asc']);
    }
    if (!orders.some((o) => o[0] === '__name__')) {
        orders.push(['__name__', orders.length ? orders[orders.length - 1][1] : 'asc']);
    }
    // Documents missing an ordered field are left out.
    docs = docs.filter((d) => orders.every(([f]) => f === '__name__' || getField(d.data, f) !== undefined));
    docs.sort((a, b) => {
        for (const [f, dir] of orders) {
            let c = compareValues(orderValue(a, f), orderValue(b, f));
            if (dir === 'desc') c = -c;
            if (c) return c;
        }
        return 0;
    });

    if (q.start) {
        docs = docs.filter((d) => {
            const c = cursorCompare(d, q.start, orders);
            return q.start.inclusive ? c >= 0 : c > 0;
        });
    }
    if (q.end) {
        docs = docs.filter((d) => {
            const c = cursorCompare(d, q.end, orders);
            return q.end.inclusive ? c <= 0 : c < 0;
        });
    }
    if (typeof q.offset === 'number' && q.offset > 0) docs = docs.slice(q.offset);
    if (typeof q.limit === 'number') docs = docs.slice(0, Math.max(0, q.limit));
    if (typeof q.limitToLast === 'number') docs = q.limitToLast > 0 ? docs.slice(-q.limitToLast) : [];
    return docs;
}

// ---------------------------------------------------------------- writes

// writes: [{ type: 'set', path, data, merge?, mergeFields? } | { type: 'update', path, fields } | { type: 'delete', path }]
// reads (transactions): [{ path, ut }] - fail with 'aborted' if any document changed since it was read.
export function commit(writes, reads, auth) {
    if (!Array.isArray(writes)) throw new FsError('invalid-argument', 'writes must be an array');
    const now = Date.now();
    const changed = [];
    transaction(() => {
        for (const r of reads || []) {
            const cur = readRaw(splitPath(r.path).join('/'));
            if ((cur.exists ? cur.ut : 0) !== (r.ut || 0)) {
                throw new FsError('aborted', 'Transaction failed because a document changed while it was running.', 409);
            }
        }
        const pending = new Map();
        const current = (p) => (pending.has(p) ? pending.get(p) : readRaw(p));

        for (const w of writes) {
            const path = splitPath(w.path).join('/');
            if (!validDocPath(path)) throw new FsError('invalid-argument', `Invalid document path: ${w.path}`);
            const old = current(path);
            const oldData = old.exists ? old.data : null;
            let newData;
            if (w.type === 'delete') {
                newData = null;
            } else if (w.type === 'set') {
                const data = isMap(w.data) ? w.data : {};
                if (w.mergeFields && w.mergeFields.length) {
                    newData = oldData ? { ...oldData } : {};
                    for (const f of w.mergeFields) newData = setField(newData, f, getField(data, f) === undefined ? { $fv: 'delete' } : getField(data, f), now);
                } else if (w.merge) {
                    newData = deepMerge(oldData, data, now);
                } else {
                    newData = resolveValue(data, oldData, now) || {};
                }
            } else if (w.type === 'update') {
                if (!old.exists) throw new FsError('not-found', `No document to update: ${path}`, 404);
                newData = { ...oldData };
                for (const [f, v] of Object.entries(w.fields || {})) newData = setField(newData, f, v, now);
            } else {
                throw new FsError('invalid-argument', `Unknown write type: ${w.type}`);
            }

            // ReKindle+ status on profile documents is managed by the server, not the page.
            const parts = splitPath(path);
            const isProfile = parts.length === 2 && parts[0] === 'users';
            if (isProfile && config.plusForAll && newData) {
                if (oldData && oldData.proExpiresAt !== undefined) newData.proExpiresAt = oldData.proExpiresAt;
                else delete newData.proExpiresAt;
                if (oldData && oldData.isPro !== undefined) newData.isPro = oldData.isPro;
                else delete newData.isPro;
            }

            if (!(auth && auth.internal)) {
                const op = newData === null ? 'delete' : (old.exists ? 'update' : 'create');
                const ctx = ruleCtx(auth, {
                    resource: oldData,
                    data: newData,
                    newKeys: () => Object.keys(newData || {}),
                    affected: () => affectedKeys(oldData, newData)
                });
                if (!allowed(op, path, ctx)) throw new FsError('permission-denied', 'Missing or insufficient permissions.', 403);
            }

            if (newData === null) {
                pending.set(path, { path, exists: false });
            } else {
                pending.set(path, { path, exists: true, data: newData, ct: old.exists ? old.ct : now, ut: 0 });
            }
        }

        for (const [path, doc] of pending) {
            if (!doc.exists) {
                stmts.del.run(NS, path);
            } else {
                const parent = parentOf(path);
                const coll = splitPath(parent).pop();
                stmts.upsert.run(NS, path, parent, coll, JSON.stringify(doc.data), doc.ct || now, nextUt());
            }
            changed.push(path);
        }
    });
    for (const p of changed) emit('fs', NS, p);
    return { seq: currentSeq() };
}

// Give every account its profile document so ReKindle+ pages see an active subscription.
export function ensureProfile(uid) {
    const path = `users/${uid}`;
    const cur = readRaw(path);
    if (cur.exists) return;
    commit([{ type: 'set', path, data: {}, merge: true }], [], { internal: true });
}
