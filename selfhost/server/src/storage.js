// File storage (Cloud Storage replacement). Files live under DATA_DIR/files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { isAdminEmail } from './auth.js';
import { randomToken } from './jwt.js';

export class StorageError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const NS = 'rekindle-dd1fa';
const ROOT = path.join(config.dataDir, 'files');
fs.mkdirSync(ROOT, { recursive: true });

function cleanPath(p) {
    const parts = String(p || '').split('/').filter(Boolean);
    for (const s of parts) {
        if (s === '.' || s === '..' || s.includes('\0')) throw new StorageError('storage/invalid-argument', 'Invalid path');
    }
    return parts.join('/');
}

function diskPath(p) {
    // Hash-free layout mirrors the logical path; cleanPath() rules out traversal.
    return path.join(ROOT, ...p.split('/'));
}

// Upstream storage.rules: users/{uid}/files/** and users/{uid}/photos/** belong
// to that user (and are a ReKindle+ feature). Everything else is closed.
function canAccess(auth, p) {
    if (auth && auth.internal) return true;
    if (!auth) return false;
    const parts = p.split('/');
    const isPro = config.plusForAll || auth.pro === true || isAdminEmail(auth.email);
    return parts.length >= 3
        && parts[0] === 'users'
        && parts[1] === auth.uid
        && (parts[2] === 'files' || parts[2] === 'photos')
        && isPro;
}

function check(auth, p) {
    if (!canAccess(auth, p)) {
        throw new StorageError('storage/unauthorized', `User does not have permission to access '${p}'.`, 403);
    }
}

const stmts = {
    get: db.prepare('SELECT * FROM files WHERE ns = ? AND path = ?'),
    upsert: db.prepare(`INSERT INTO files(ns, path, size, type, token, md5, meta, ct, ut) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(ns, path) DO UPDATE SET size = excluded.size, type = excluded.type, md5 = excluded.md5,
                        meta = excluded.meta, ut = excluded.ut`),
    updMeta: db.prepare('UPDATE files SET type = ?, meta = ?, ut = ? WHERE ns = ? AND path = ?'),
    del: db.prepare('DELETE FROM files WHERE ns = ? AND path = ?'),
    under: db.prepare("SELECT path FROM files WHERE ns = ? AND path LIKE ? ESCAPE '\\' ORDER BY path")
};

export function describe(row, origin) {
    const meta = row.meta ? JSON.parse(row.meta) : {};
    const name = row.path.split('/').pop();
    return {
        meta: {
            bucket: 'local',
            name,
            fullPath: row.path,
            size: row.size,
            contentType: row.type || 'application/octet-stream',
            md5Hash: row.md5 || undefined,
            timeCreated: new Date(row.ct).toISOString(),
            updated: new Date(row.ut).toISOString(),
            generation: String(row.ut),
            metageneration: '1',
            cacheControl: meta.cacheControl || undefined,
            contentDisposition: meta.contentDisposition || undefined,
            customMetadata: meta.customMetadata || undefined,
            type: 'file'
        },
        url: `${origin}/__rk/st/dl/${encodeURIComponent(row.path)}?t=${row.token}`
    };
}

export async function upload(req, auth, p, meta, origin) {
    p = cleanPath(p);
    if (!p) throw new StorageError('storage/invalid-argument', 'Missing path');
    check(auth, p);
    const dest = diskPath(p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + '.upload-' + crypto.randomBytes(6).toString('hex');
    const hash = crypto.createHash('md5');
    let size = 0;
    await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(tmp);
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > config.maxUploadBytes) {
                req.destroy();
                out.destroy();
                reject(new StorageError('storage/quota-exceeded', `File is larger than the ${Math.round(config.maxUploadBytes / 1048576)} MB limit.`, 413));
                return;
            }
            hash.update(chunk);
            out.write(chunk);
        });
        req.on('end', () => out.end());
        req.on('error', reject);
        out.on('finish', resolve);
        out.on('error', reject);
    }).catch((e) => {
        fs.rmSync(tmp, { force: true });
        throw e;
    });
    fs.renameSync(tmp, dest);
    const now = Date.now();
    const existing = stmts.get.get(NS, p);
    const stored = {
        customMetadata: meta.customMetadata || null,
        cacheControl: meta.cacheControl || null,
        contentDisposition: meta.contentDisposition || null
    };
    stmts.upsert.run(NS, p, size, meta.contentType || 'application/octet-stream', existing ? existing.token : randomToken(18),
        hash.digest('base64'), JSON.stringify(stored), existing ? existing.ct : now, now);
    return describe(stmts.get.get(NS, p), origin);
}

export function getMeta(auth, p, update, origin) {
    p = cleanPath(p);
    check(auth, p);
    const row = stmts.get.get(NS, p);
    if (!row) throw new StorageError('storage/object-not-found', `Object '${p}' does not exist.`, 404);
    if (update) {
        const meta = row.meta ? JSON.parse(row.meta) : {};
        if (update.customMetadata !== undefined) meta.customMetadata = update.customMetadata;
        if (update.cacheControl !== undefined) meta.cacheControl = update.cacheControl;
        if (update.contentDisposition !== undefined) meta.contentDisposition = update.contentDisposition;
        stmts.updMeta.run(update.contentType || row.type, JSON.stringify(meta), Date.now(), NS, p);
        return describe(stmts.get.get(NS, p), origin);
    }
    return describe(row, origin);
}

export function remove(auth, p) {
    p = cleanPath(p);
    check(auth, p);
    const row = stmts.get.get(NS, p);
    if (!row) throw new StorageError('storage/object-not-found', `Object '${p}' does not exist.`, 404);
    stmts.del.run(NS, p);
    fs.rmSync(diskPath(p), { force: true });
}

export function list(auth, p, max, pageToken) {
    p = cleanPath(p);
    // Listing a folder needs access to what is inside it.
    check(auth, p ? p + '/x' : 'x');
    const prefix = p ? p + '/' : '';
    const like = prefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const items = [];
    const prefixes = new Set();
    for (const row of stmts.under.iterate(NS, like)) {
        const rest = row.path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash === -1) items.push(row.path);
        else prefixes.add(prefix + rest.slice(0, slash));
    }
    let start = 0;
    if (pageToken) start = Math.max(0, parseInt(pageToken, 10) || 0);
    const limit = max ? Math.max(1, Math.min(1000, max)) : items.length;
    const page = items.slice(start, start + limit);
    const next = start + limit < items.length ? String(start + limit) : null;
    return { items: page, prefixes: start === 0 ? [...prefixes] : [], next };
}

// Download by path + per-file token (like Firebase download URLs, usable in <img src>).
export function openDownload(p, token) {
    p = cleanPath(p);
    const row = stmts.get.get(NS, p);
    if (!row || !token || row.token !== token) return null;
    const file = diskPath(p);
    if (!fs.existsSync(file)) return null;
    return { file, row };
}
