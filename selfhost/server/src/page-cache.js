// Manga pages kept on disk (DATA_DIR/manga-cache), up to MANGA_CACHE_MB (default 1024 MB,
// owner's request 2026-10-06): a page read again (going back, rereading a chapter, the
// AZW3 download after reading it) comes from here instead of MangaDex or Manhuagui. The
// least recently read pages are deleted first. images.js serveImage keeps its small
// memory cache in front of this one.
//
// Keys are made stable: MangaDex@Home page addresses change with the node and each visit
// (https://<node>/<token>/data/<chapter hash>/<file>), the chapter hash and file name
// don't; Manhuagui pages are keyed by the encoded image address, not the signature.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const TYPE = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));

export function stableKey(key) {
    const md = /\/(data(?:-saver)?)\/([0-9a-f]{16,})\/([^/?#|]+)$/i.exec(key);
    if (md) return `md:${md[1]}/${md[2]}/${md[3]}`;
    const mhg = /^mhg:([^:]+):/.exec(key);
    if (mhg) return `mhg:${mhg[1]}`;
    return key;
}

const hashOf = (key) => crypto.createHash('sha1').update(stableKey(key)).digest('hex');

// A cache in `dir` holding up to `maxBytes`. The server uses one (below); tests make their own.
export function createPageCache(dir, maxBytes) {
    let index = null;   // file hash -> { ext, size, used }
    let total = 0;

    function load() {
        if (index) return;
        index = new Map();
        fs.mkdirSync(dir, { recursive: true });
        for (const name of fs.readdirSync(dir)) {
            const file = path.join(dir, name);
            const m = /^([0-9a-f]{40})\.(\w+)$/.exec(name);
            if (!m || !TYPE[m[2]]) { fs.rmSync(file, { force: true }); continue; }   // half-written or foreign
            const st = fs.statSync(file);
            index.set(m[1], { ext: m[2], size: st.size, used: st.mtimeMs });
            total += st.size;
        }
    }

    // Over the limit: least recently read pages go until 90% of it is used.
    function evict() {
        if (total <= maxBytes) return;
        const oldest = [...index.entries()].sort((a, b) => a[1].used - b[1].used);
        for (const [hash, entry] of oldest) {
            if (total <= maxBytes * 0.9) break;
            fs.rmSync(path.join(dir, `${hash}.${entry.ext}`), { force: true });
            index.delete(hash);
            total -= entry.size;
        }
    }

    return {
        // { body, type } for a cached page, or null.
        async read(key) {
            load();
            const hash = hashOf(key);
            const entry = index.get(hash);
            if (!entry) return null;
            const file = path.join(dir, `${hash}.${entry.ext}`);
            try {
                const body = await fs.promises.readFile(file);
                entry.used = Date.now();
                const t = new Date();
                fs.promises.utimes(file, t, t).catch(() => { });   // the order survives restarts
                return { body, type: TYPE[entry.ext] };
            } catch {
                index.delete(hash);
                total -= entry.size;
                return null;
            }
        },
        // Saves a fetched page in the background; the promise is for tests.
        write(key, page) {
            load();
            const ext = EXT[page.type];
            const hash = hashOf(key);
            if (!ext || index.has(hash) || page.body.length > maxBytes / 10) return Promise.resolve();
            const file = path.join(dir, `${hash}.${ext}`);
            const tmp = `${file}.${process.pid}.tmp`;
            return fs.promises.writeFile(tmp, page.body)
                .then(() => fs.promises.rename(tmp, file))
                .then(() => {
                    if (!index.has(hash)) { index.set(hash, { ext, size: page.body.length, used: Date.now() }); total += page.body.length; }
                    evict();
                })
                .catch(() => fs.promises.rm(tmp, { force: true }).catch(() => { }));
        },
        stats() { load(); return { pages: index.size, bytes: total, max: maxBytes }; }
    };
}

const pages = createPageCache(path.join(config.dataDir, 'manga-cache'),
    (parseInt(process.env.MANGA_CACHE_MB || '1024', 10) || 1024) * 1024 * 1024);
export const readPage = (key) => pages.read(key);
export const writePage = (key, page) => pages.write(key, page);
export const cacheStats = () => pages.stats();
