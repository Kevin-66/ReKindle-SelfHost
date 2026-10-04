// A small stand-in for the `firebase-admin` package, backed by this server's
// own stores. It covers what ReKindle's firebase-functions/index.js uses, so
// that file can run unmodified.

import * as auth from './auth.js';
import { rtdb, pushId, valueHash } from './rtdb.js';
import * as fsStore from './firestore.js';
import { isTagged, isMap } from './fsvalues.js';
import { NS_MAIN } from './config.js';

const INTERNAL = { internal: true };

function adminError(code, message) {
    const e = new Error(message);
    e.code = code;
    e.errorInfo = { code, message };
    return e;
}

function wrapAuthError(e) {
    if (e instanceof auth.AuthError) {
        const code = e.code === 'auth/email-already-exists' ? 'auth/email-already-exists' : e.code;
        return adminError(code, e.message);
    }
    return e;
}

// ---------------------------------------------------------------- auth

function userRecord(u) {
    return {
        uid: u.uid,
        email: u.email,
        emailVerified: true,
        displayName: u.display_name || undefined,
        photoURL: u.photo_url || undefined,
        phoneNumber: undefined,
        disabled: !!u.disabled,
        customClaims: auth.getClaims(u.uid, NS_MAIN),
        metadata: {
            creationTime: new Date(u.created).toUTCString(),
            lastSignInTime: u.last_login ? new Date(u.last_login).toUTCString() : null
        },
        providerData: u.email ? [{ uid: u.email, email: u.email, providerId: 'password' }] : [],
        tokensValidAfterTime: u.valid_since ? new Date(u.valid_since).toUTCString() : undefined,
        toJSON() { return { ...this }; }
    };
}

const authApi = {
    async getUser(uid) {
        const u = auth.getUser(uid);
        if (!u) throw adminError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
        return userRecord(u);
    },
    async getUserByEmail(email) {
        const u = auth.getUserByEmail(email);
        if (!u) throw adminError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
        return userRecord(u);
    },
    async createUser(props = {}) {
        try {
            const u = auth.createUser(props);
            fsStore.ensureProfile(u.uid);
            return userRecord(u);
        } catch (e) { throw wrapAuthError(e); }
    },
    async updateUser(uid, props = {}) {
        try { return userRecord(auth.updateUser(uid, props)); } catch (e) { throw wrapAuthError(e); }
    },
    async deleteUser(uid) {
        try { auth.deleteUser(uid); } catch (e) { throw wrapAuthError(e); }
    },
    async setCustomUserClaims(uid, claims) {
        if (!auth.getUser(uid)) throw adminError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.');
        auth.setClaims(uid, NS_MAIN, claims || {});
    },
    async createCustomToken(uid, claims) {
        return auth.createCustomToken(uid, claims);
    },
    async revokeRefreshTokens(uid) {
        auth.revokeSessions(uid);
    },
    async verifyIdToken(token) {
        const d = auth.verifyIdToken(token);
        if (!d) throw adminError('auth/argument-error', 'Invalid ID token.');
        return d;
    },
    async listUsers(maxResults = 1000, pageToken) {
        const offset = pageToken ? parseInt(pageToken, 10) || 0 : 0;
        const rows = auth.listUsers(maxResults, offset);
        return {
            users: rows.map(userRecord),
            pageToken: rows.length === maxResults ? String(offset + maxResults) : undefined
        };
    }
};

// ---------------------------------------------------------------- realtime database

function splitPath(p) { return String(p || '').split('/').filter(Boolean); }

class AdminSnap {
    constructor(ref, val) {
        this.ref = ref;
        this.key = ref.key;
        this._v = val === undefined ? null : val;
    }
    val() { return this._v === null ? null : JSON.parse(JSON.stringify(this._v)); }
    exportVal() { return this.val(); }
    toJSON() { return this.val(); }
    exists() { return this._v !== null; }
    child(p) {
        let cur = this._v;
        for (const k of splitPath(p)) cur = (cur && typeof cur === 'object' && k in cur) ? cur[k] : null;
        return new AdminSnap(this.ref.child(p), cur);
    }
    hasChild(p) { return this.child(p).exists(); }
    hasChildren() { return !!this._v && typeof this._v === 'object' && Object.keys(this._v).length > 0; }
    numChildren() { return this._v && typeof this._v === 'object' ? Object.keys(this._v).length : 0; }
    forEach(fn) {
        if (!this._v || typeof this._v !== 'object') return false;
        for (const k of Object.keys(this._v)) {
            if (fn(new AdminSnap(this.ref.child(k), this._v[k])) === true) return true;
        }
        return false;
    }
}

class AdminRef {
    constructor(path, q) {
        this.path = splitPath(path).join('/');
        this._q = q || null;
        this.key = this.path ? this.path.split('/').pop() : null;
    }
    get parent() { return this.path ? new AdminRef(this.path.split('/').slice(0, -1).join('/')) : null; }
    get root() { return new AdminRef(''); }
    get ref() { return new AdminRef(this.path); }
    child(p) { return new AdminRef(this.path ? `${this.path}/${splitPath(p).join('/')}` : splitPath(p).join('/')); }
    toString() { return `/${this.path}`; }

    async once(eventType = 'value', cb) {
        if (eventType !== 'value') throw new Error(`once('${eventType}') is not supported on this server`);
        const snap = new AdminSnap(this.ref, rtdb.get(NS_MAIN, this.path, this._q, INTERNAL));
        if (typeof cb === 'function') cb(snap);
        return snap;
    }
    get() { return this.once('value'); }
    async set(v) { rtdb.set(NS_MAIN, this.path, v, INTERNAL); }
    async update(v) { rtdb.update(NS_MAIN, this.path, v, INTERNAL); }
    async remove() { rtdb.set(NS_MAIN, this.path, null, INTERNAL); }
    push(v) {
        const ref = this.child(pushId());
        const p = v === undefined ? Promise.resolve(ref) : ref.set(v).then(() => ref);
        ref.then = (a, b) => p.then(a, b);
        ref.catch = (b) => p.catch(b);
        return ref;
    }
    async transaction(fn) {
        for (let i = 0; i < 25; i++) {
            const cur = rtdb.get(NS_MAIN, this.path, null, INTERNAL);
            const next = fn(cur === null ? null : JSON.parse(JSON.stringify(cur)));
            if (next === undefined) return { committed: false, snapshot: new AdminSnap(this.ref, cur) };
            const r = rtdb.transaction(NS_MAIN, this.path, valueHash(cur), next, INTERNAL);
            if (r.ok) return { committed: true, snapshot: new AdminSnap(this.ref, r.val) };
        }
        throw new Error('Transaction failed after 25 attempts');
    }
    _with(patch) { return new AdminRef(this.path, { ...(this._q || {}), ...patch }); }
    orderByChild(c) { return this._with({ orderBy: 'child', child: splitPath(c).join('/') }); }
    orderByKey() { return this._with({ orderBy: 'key' }); }
    orderByValue() { return this._with({ orderBy: 'value' }); }
    limitToFirst(n) { return this._with({ limitToFirst: n }); }
    limitToLast(n) { return this._with({ limitToLast: n }); }
    startAt(v, k) { return this._with({ startAt: k === undefined ? [v] : [v, k] }); }
    endAt(v, k) { return this._with({ endAt: k === undefined ? [v] : [v, k] }); }
    equalTo(v, k) { return this._with({ equalTo: k === undefined ? [v] : [v, k] }); }
    on() { throw new Error('Realtime listeners are not supported in server functions on this server'); }
    off() { }
}

const databaseApi = { ref: (p) => new AdminRef(p), refFromURL: (u) => new AdminRef(new URL(u).pathname) };

// ---------------------------------------------------------------- firestore

class Timestamp {
    constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    static now() { return Timestamp.fromMillis(Date.now()); }
    static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
    static fromMillis(ms) { const s = Math.floor(ms / 1000); return new Timestamp(s, Math.round((ms - s * 1000) * 1e6)); }
    toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
    toDate() { return new Date(this.toMillis()); }
    isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
    valueOf() { return String(this.seconds + 62135596800).padStart(12, '0') + '.' + String(this.nanoseconds).padStart(9, '0'); }
    get _seconds() { return this.seconds; }
    get _nanoseconds() { return this.nanoseconds; }
}

class FieldValue {
    constructor(kind, payload) { this._kind = kind; this._payload = payload; }
    static serverTimestamp() { return new FieldValue('serverTimestamp'); }
    static delete() { return new FieldValue('delete'); }
    static increment(n) { return new FieldValue('increment', n); }
    static arrayUnion(...v) { return new FieldValue('arrayUnion', v); }
    static arrayRemove(...v) { return new FieldValue('arrayRemove', v); }
}

class FieldPath {
    constructor(...segments) { this._segments = segments; }
    static documentId() { return new FieldPath('__name__'); }
    toString() { return this._segments.join('.'); }
}

function encode(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) { const t = Timestamp.fromDate(v); return { $ts: [t.seconds, t.nanoseconds] }; }
    if (v instanceof Timestamp) return { $ts: [v.seconds, v.nanoseconds] };
    if (v instanceof AdminDoc) return { $ref: v.path };
    if (v instanceof FieldValue) {
        const o = { $fv: v._kind };
        if (v._kind === 'increment') o.n = v._payload;
        if (v._kind === 'arrayUnion' || v._kind === 'arrayRemove') o.v = v._payload.map(encode);
        return o;
    }
    if (Array.isArray(v)) return v.map(encode);
    const out = {};
    for (const [k, x] of Object.entries(v)) { const e = encode(x); if (e !== undefined) out[k] = e; }
    return out;
}

function decode(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decode);
    if (isTagged(v)) {
        if (v.$ts) return new Timestamp(v.$ts[0], v.$ts[1]);
        if (v.$ref) return new AdminDoc(v.$ref);
        if (v.$geo) return { latitude: v.$geo[0], longitude: v.$geo[1] };
        return v;
    }
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = decode(x);
    return out;
}

function fieldName(f) { return f instanceof FieldPath ? f.toString() : String(f); }

class AdminDocSnap {
    constructor(path, raw) {
        this.ref = new AdminDoc(path);
        this.id = this.ref.id;
        this.exists = !!raw.exists;
        this._data = raw.exists ? raw.data : undefined;
        this.createTime = raw.ct ? Timestamp.fromMillis(raw.ct) : undefined;
        this.updateTime = raw.ut ? Timestamp.fromMillis(raw.ut) : undefined;
        this.readTime = Timestamp.now();
    }
    data() { return this.exists ? decode(this._data) : undefined; }
    get(field) {
        if (!this.exists) return undefined;
        let cur = this._data;
        for (const s of fieldName(field).split('.')) { if (!isMap(cur) || !(s in cur)) return undefined; cur = cur[s]; }
        return decode(cur);
    }
}

class AdminQuery {
    constructor(collPath, q) { this._path = collPath; this._q = q || {}; }
    _with(patch) { return new AdminQuery(this._path, { ...this._q, ...patch }); }
    where(f, op, v) { return this._with({ where: [...(this._q.where || []), [fieldName(f), op, encode(v)]] }); }
    orderBy(f, dir) { return this._with({ orderBy: [...(this._q.orderBy || []), [fieldName(f), dir === 'desc' ? 'desc' : 'asc']] }); }
    limit(n) { return this._with({ limit: n }); }
    limitToLast(n) { return this._with({ limitToLast: n }); }
    offset(n) { return this._with({ offset: n }); }
    startAt(...v) { return this._with({ start: { values: v.map(encode), inclusive: true } }); }
    startAfter(...v) { return this._with({ start: { values: v.map(encode), inclusive: false } }); }
    endAt(...v) { return this._with({ end: { values: v.map(encode), inclusive: true } }); }
    endBefore(...v) { return this._with({ end: { values: v.map(encode), inclusive: false } }); }
    async get() {
        const docs = fsStore.runQuery(this._path, this._q, INTERNAL).map((d) => new AdminDocSnap(d.path, d));
        return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn), query: this, readTime: Timestamp.now() };
    }
    count() {
        return { get: async () => { const s = await this.get(); return { data: () => ({ count: s.size }) }; } };
    }
}

class AdminCollection extends AdminQuery {
    constructor(path) {
        super(splitPath(path).join('/'), {});
        this.path = this._path;
        this.id = this.path.split('/').pop();
    }
    get parent() { const p = this.path.split('/').slice(0, -1).join('/'); return p ? new AdminDoc(p) : null; }
    doc(id) {
        if (!id) id = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
        return new AdminDoc(`${this.path}/${id}`);
    }
    async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
    async listDocuments() { return fsStore.runQuery(this.path, {}, INTERNAL).map((d) => new AdminDoc(d.path)); }
}

class AdminDoc {
    constructor(path) {
        this.path = splitPath(path).join('/');
        this.id = this.path.split('/').pop();
    }
    get parent() { return new AdminCollection(this.path.split('/').slice(0, -1).join('/')); }
    collection(sub) { return new AdminCollection(`${this.path}/${splitPath(sub).join('/')}`); }
    async get() { return new AdminDocSnap(this.path, fsStore.getDoc(this.path, INTERNAL)); }
    async set(data, opts) {
        const w = { type: 'set', path: this.path, data: encode(data || {}) };
        if (opts && opts.merge) w.merge = true;
        if (opts && opts.mergeFields) w.mergeFields = opts.mergeFields.map(fieldName);
        fsStore.commit([w], [], INTERNAL);
        return { writeTime: Timestamp.now() };
    }
    async create(data) {
        if (fsStore.getDoc(this.path, INTERNAL).exists) throw adminError('already-exists', `Document already exists: ${this.path}`);
        return this.set(data);
    }
    async update(dataOrField, ...rest) {
        const fields = {};
        if (typeof dataOrField === 'object' && !(dataOrField instanceof FieldPath)) {
            for (const [k, v] of Object.entries(dataOrField)) fields[k] = encode(v);
        } else {
            const args = [dataOrField, ...rest];
            for (let i = 0; i + 1 < args.length; i += 2) fields[fieldName(args[i])] = encode(args[i + 1]);
        }
        fsStore.commit([{ type: 'update', path: this.path, fields }], [], INTERNAL);
        return { writeTime: Timestamp.now() };
    }
    async delete() { fsStore.commit([{ type: 'delete', path: this.path }], [], INTERNAL); return { writeTime: Timestamp.now() }; }
}

class AdminBatch {
    constructor() { this._writes = []; }
    set(ref, data, opts) {
        const w = { type: 'set', path: ref.path, data: encode(data || {}) };
        if (opts && opts.merge) w.merge = true;
        this._writes.push(w);
        return this;
    }
    update(ref, data) {
        const fields = {};
        for (const [k, v] of Object.entries(data || {})) fields[k] = encode(v);
        this._writes.push({ type: 'update', path: ref.path, fields });
        return this;
    }
    delete(ref) { this._writes.push({ type: 'delete', path: ref.path }); return this; }
    create(ref, data) { return this.set(ref, data); }
    async commit() { if (this._writes.length) fsStore.commit(this._writes, [], INTERNAL); return []; }
}

const firestoreApi = {
    collection: (p) => new AdminCollection(p),
    doc: (p) => new AdminDoc(p),
    collectionGroup: (id) => new AdminQuery(`group:${id}`, {}),
    batch: () => new AdminBatch(),
    async runTransaction(fn) {
        // Single-process server: run the function, then apply its writes in one commit.
        const batch = new AdminBatch();
        const tx = {
            get: (ref) => (ref instanceof AdminQuery ? ref.get() : ref.get()),
            set: (r, d, o) => { batch.set(r, d, o); return tx; },
            update: (r, d) => { batch.update(r, d); return tx; },
            delete: (r) => { batch.delete(r); return tx; },
            create: (r, d) => { batch.create(r, d); return tx; }
        };
        const out = await fn(tx);
        await batch.commit();
        return out;
    },
    settings() { },
    async listCollections() { return []; }
};

// ---------------------------------------------------------------- module

function makeApp(name, options) {
    return {
        name,
        options: options || {},
        auth: () => authApi,
        database: () => databaseApi,
        firestore: () => firestoreApi,
        delete: async () => { }
    };
}

export function createAdminModule() {
    const apps = [];
    const admin = {
        initializeApp(options, name = '[DEFAULT]') {
            const app = makeApp(name, options);
            apps.push(app);
            return app;
        },
        app(name = '[DEFAULT]') {
            const a = apps.find((x) => x.name === name);
            if (!a) throw adminError('app/no-app', `The default Firebase app does not exist.`);
            return a;
        },
        apps,
        credential: { cert: (x) => x, applicationDefault: () => ({}), refreshToken: (x) => x },
        auth: () => authApi,
        database: Object.assign(() => databaseApi, {
            ServerValue: { TIMESTAMP: { '.sv': 'timestamp' }, increment: (n) => ({ '.sv': { increment: n } }) }
        }),
        firestore: Object.assign(() => firestoreApi, { FieldValue, Timestamp, FieldPath }),
        storage: () => { throw new Error('Storage is not available to server functions on this server'); },
        messaging: () => ({ send: async () => '' })
    };
    admin.default = admin;
    return admin;
}
