// Z-Library catalogue browser service (Dockerfile.zlibrary-browser). The ReKindle
// server posts a catalogue URL; this loads it in Chromium (zlibrary-browser.mjs, a
// copy of selfhost/server/src/zlibrary-browser.js) and returns the page HTML.
// POST /download {url, cookie} downloads one book with the reader's Z-Library cookie
// and streams the file back (name in X-File-Name).
// It listens on ZLIBRARY_BROWSER_HOST:ZLIBRARY_BROWSER_PORT (loopback by default;
// 0.0.0.0 in its own container, reachable only on the private network). When
// ZLIBRARY_BROWSER_TOKEN is set, requests must carry "Authorization: Bearer <token>".
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadBrowserCatalogue, closeCatalogueBrowser, downloadBook } from './zlibrary-browser.mjs';

const HOST = process.env.ZLIBRARY_BROWSER_HOST || '127.0.0.1';
const PORT = Number(process.env.ZLIBRARY_BROWSER_PORT) || 8091;
const TOKEN = process.env.ZLIBRARY_BROWSER_TOKEN || '';

if (!TOKEN && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
    console.warn('ZLIBRARY_BROWSER_TOKEN is not set: any service on the private network can use this browser.');
}

function authorized(req) {
    if (!TOKEN) return true;
    const given = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from('Bearer ' + TOKEN);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || (req.url !== '/catalogue' && req.url !== '/download')) { res.writeHead(404).end(); return; }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    if (req.url === '/download') {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 16384) { res.writeHead(413).end(); return; }
        }
        let book;
        try {
            const input = JSON.parse(body);
            book = await downloadBook(input.url, input.cookie);
        } catch (error) {
            res.writeHead(error.status === 400 ? 400 : 502, { 'Content-Type': 'text/plain' }).end(error.code === 'zlibrary/download-failed' ? error.message : 'Download failed');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': book.size, 'X-File-Name': encodeURIComponent(book.name), 'Cache-Control': 'no-store' });
        fs.createReadStream(book.file).on('close', () => fs.rmSync(path.dirname(book.file), { recursive: true, force: true })).pipe(res);
        return;
    }
    try {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 4096) { res.writeHead(413).end(); return; }
        }
        let input;
        try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!input || typeof input.url !== 'string') { res.writeHead(400).end(); return; }
        const html = await loadBrowserCatalogue(input.url);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    } catch (error) {
        res.writeHead(error.status === 429 ? 429 : 502, { 'Content-Type': 'text/plain' }).end('Catalogue browser unavailable');
    }
});
server.requestTimeout = 180000;
server.listen(PORT, HOST, () => console.log(`ReKindle catalogue browser ready on ${HOST}:${PORT}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    server.close();
    await closeCatalogueBrowser();
    process.exit(0);
});
