// Serves the site. Uses the build output (main/, lite/, legacy/) when present,
// otherwise the repository itself with the self-hosting edits applied on the fly.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config, SERVER_DIR, UPSTREAM_ADMIN_EMAIL, UPSTREAM_GOOGLE_CLIENT_ID } from './config.js';
import { adminEmail } from './auth.js';
import { transformHtml, transformJs } from './transform.js';

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.jsonl': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
    '.webmanifest': 'application/manifest+json', '.epub': 'application/epub+zip', '.wad': 'application/octet-stream'
};

const TEXTUAL = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/;

const built = fs.existsSync(path.join(config.siteDir, 'main', 'index.html'));
const devMode = !built;

// Never serve backend code, data or tooling from the repository in dev mode.
const PRIVATE_TOP = new Set([
    'selfhost', 'workers', 'firebase-functions', 'functions', 'admin', 'scripts', 'node_modules',
    '_deploy', 'package.json', 'package-lock.json', 'build-automation.js', 'Dockerfile', 'docker-compose.yml',
    '.env', '.env.example', 'firebase.json', 'firebase-social.json', 'firestore.rules', 'firestore-social.rules',
    'rtdb-rules.json', 'rtdb-social-rules.json', 'storage.rules', 'cors.json', 'AGENTS.md'
]);

const CLIENT_FILE = path.join(SERVER_DIR, '..', 'client', 'rk-backend.js');
// Files the self-hosted setup adds to the site (copied in at build time).
const OVERLAY_DIR = path.join(SERVER_DIR, '..', 'site');

function resolveFile(urlPath) {
    let rel = decodeURIComponent(urlPath.split('?')[0]);
    let root = config.siteDir;
    if (built) {
        root = path.join(config.siteDir, 'main');
        for (const target of ['lite', 'legacy']) {
            if (rel === `/${target}` || rel.startsWith(`/${target}/`)) {
                root = path.join(config.siteDir, target);
                rel = rel.slice(target.length + 1) || '/';
                break;
            }
        }
    }
    const parts = rel.split('/').filter(Boolean);
    if (parts.some((p) => p.startsWith('.') || p.includes('\0'))) return null;
    if (devMode && parts.length && PRIVATE_TOP.has(parts[0])) return null;
    if (devMode && parts.length === 1 && parts[0] === 'rk-backend.js') return CLIENT_FILE;
    if (devMode && parts.length) {
        const overlay = path.join(OVERLAY_DIR, ...parts);
        if (overlay.startsWith(OVERLAY_DIR) && fs.existsSync(overlay) && fs.statSync(overlay).isFile()) return overlay;
    }
    let file = path.join(root, ...parts);
    if (!file.startsWith(root)) return null;
    try {
        const st = fs.statSync(file);
        if (st.isDirectory()) file = path.join(file, 'index.html');
    } catch {
        // Like Cloudflare Pages: /login serves login.html.
        if (path.extname(file) || !fs.existsSync(file + '.html')) return null;
        file += '.html';
    }
    return file;
}

// Small cache of processed text files: key -> { body, gz, etag }
const cache = new Map();
const CACHE_MAX = 400;

function processText(file, buf) {
    let text = buf.toString('utf8');
    const ext = path.extname(file).toLowerCase();
    if (devMode && file !== CLIENT_FILE && !file.startsWith(OVERLAY_DIR)) {
        if (ext === '.html') text = transformHtml(text, file);
        else if (ext === '.js') text = transformJs(text, file);
    }
    if (ext === '.html' || ext === '.js') {
        // Upstream code names the original developer's account as admin.
        text = text.split(UPSTREAM_ADMIN_EMAIL).join(adminEmail());
        // Google only accepts the upstream sign-in client on rekindle.ink.
        if (config.googleClientId) text = text.split(UPSTREAM_GOOGLE_CLIENT_ID).join(config.googleClientId);
    }
    return Buffer.from(text, 'utf8');
}

export function serveStatic(req, res, urlPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = resolveFile(urlPath);
    if (!file) return false;
    let st;
    try { st = fs.statSync(file); } catch { return false; }
    if (!st.isFile()) return false;

    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    const headers = {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': (ext === '.html' || ext === '.js' || ext === '.json' || file.endsWith('sw.js')) ? 'no-cache' : 'public, max-age=86400'
    };

    if (TEXTUAL.test(type)) {
        const admin = adminEmail();
        const key = `${file}|${st.mtimeMs}|${st.size}|${admin}`;
        let entry = cache.get(key);
        if (!entry) {
            const body = processText(file, fs.readFileSync(file));
            // ETag from the processed content: the on-the-fly edits can change while the file does not.
            entry = { body, gz: zlib.gzipSync(body), etag: `"${crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20)}"` };
            cache.set(key, entry);
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        }
        headers.ETag = entry.etag;
        headers.Vary = 'Accept-Encoding';
        if (req.headers['if-none-match'] === entry.etag) {
            res.writeHead(304, headers).end();
            return true;
        }
        const gzipOk = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
        const body = gzipOk ? entry.gz : entry.body;
        if (gzipOk) headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
    }

    const etag = `"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return true;
    }
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
}

export function siteMode() {
    return built ? 'build' : 'dev';
}
