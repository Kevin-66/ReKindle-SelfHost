import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'rekindle.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS users (
    uid TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    pass TEXT,
    display_name TEXT,
    photo_url TEXT,
    disabled INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    last_login INTEGER,
    valid_since INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_claims (
    uid TEXT NOT NULL,
    ns TEXT NOT NULL,
    claims TEXT NOT NULL,
    PRIMARY KEY (uid, ns)
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    uid TEXT NOT NULL,
    ns TEXT NOT NULL,
    provider TEXT NOT NULL,
    claims TEXT,
    created INTEGER NOT NULL,
    last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions(uid);

CREATE TABLE IF NOT EXISTS fs_docs (
    ns TEXT NOT NULL,
    path TEXT NOT NULL,
    parent TEXT NOT NULL,
    coll TEXT NOT NULL,
    data TEXT NOT NULL,
    ct INTEGER NOT NULL,
    ut INTEGER NOT NULL,
    PRIMARY KEY (ns, path)
);
CREATE INDEX IF NOT EXISTS fs_docs_parent ON fs_docs(ns, parent);
CREATE INDEX IF NOT EXISTS fs_docs_coll ON fs_docs(ns, coll);

CREATE TABLE IF NOT EXISTS rtdb (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (ns, key)
);

CREATE TABLE IF NOT EXISTS files (
    ns TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    type TEXT,
    token TEXT NOT NULL,
    md5 TEXT,
    meta TEXT,
    ct INTEGER NOT NULL,
    ut INTEGER NOT NULL,
    PRIMARY KEY (ns, path)
);

CREATE TABLE IF NOT EXISTS kv (
    ns TEXT NOT NULL,
    key TEXT NOT NULL,
    value BLOB,
    expires INTEGER,
    PRIMARY KEY (ns, key)
);

-- The Z-Library app's account cookie per ReKindle account (zlibrary-account.js).
CREATE TABLE IF NOT EXISTS zlib_accounts (
    uid TEXT PRIMARY KEY,
    cookie TEXT NOT NULL,
    updated INTEGER NOT NULL
);

-- The Manga app's library and reading progress per account (manga-state.js).
CREATE TABLE IF NOT EXISTS manga_state (
    uid TEXT PRIMARY KEY,
    library TEXT,
    progress TEXT NOT NULL DEFAULT '{}',
    library_updated INTEGER,
    updated INTEGER NOT NULL
);
`);

export function metaGet(key) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
}

export function metaSet(key, value) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Run fn inside a write transaction. Nested calls join the outer one.
let depth = 0;
export function transaction(fn) {
    if (depth > 0) return fn();
    depth++;
    db.exec('BEGIN IMMEDIATE');
    try {
        const out = fn();
        db.exec('COMMIT');
        return out;
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
    } finally {
        depth--;
    }
}
