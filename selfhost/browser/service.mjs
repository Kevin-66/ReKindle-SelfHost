// Z-Library catalogue browser service (Dockerfile.zlibrary-browser). The ReKindle
// server posts a catalogue URL; this loads it in Chromium (zlibrary-browser.mjs, a
// copy of selfhost/server/src/zlibrary-browser.js) and returns the page HTML.
// POST /download {url, cookie} downloads one book with the reader's Z-Library cookie
// and streams the file back (name in X-File-Name). POST /convert takes a book file
// (body, name in X-File-Name) and returns it as MOBI, the one e-book format the Kindle
// browser opens, made by Calibre's ebook-convert.
// It listens on ZLIBRARY_BROWSER_HOST:ZLIBRARY_BROWSER_PORT (loopback by default;
// 0.0.0.0 in its own container, reachable only on the private network). When
// ZLIBRARY_BROWSER_TOKEN is set, requests must carry "Authorization: Bearer <token>".
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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

// Calibre's input formats; DJVU and PDF convert only as well as their text allows.
const CONVERTIBLE = new Set(['epub', 'azw3', 'azw', 'azw4', 'prc', 'fb2', 'fbz', 'pdf', 'djvu', 'txt', 'txtz', 'rtf', 'docx', 'odt',
    'html', 'htm', 'htmlz', 'lit', 'pdb', 'pml', 'rb', 'snb', 'tcr', 'chm', 'cbz', 'cbr', 'cb7', 'cbc', 'lrf']);
const MAX_CONVERT_BYTES = 300 * 1024 * 1024;
const CONVERT_MS = 300000;
let converting = Promise.resolve();

function convertError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}

// One conversion at a time (it is CPU-heavy). MOBI "both" holds the old MOBI and the
// newer KF8 version, so any Kindle shows it, newer ones with full formatting.
function ebookConvert(input, output) {
    return new Promise((resolve, reject) => {
        execFile('ebook-convert', [input, output, '--output-profile', 'kindle_pw3', '--mobi-file-type', 'both'], {
            timeout: CONVERT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }
        }, (error) => (error ? reject(error) : resolve()));
    });
}

async function convert(req, res) {
    let name = 'book';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'book')); } catch { }
    name = name.replace(/[\\/\0\r\n"]/g, '_').slice(0, 200);
    const ext = (path.extname(name).slice(1) || '').toLowerCase();
    if (!CONVERTIBLE.has(ext)) { req.resume(); return convertError(res, 415, `A .${ext || '?'} file can't be converted to MOBI.`); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    const input = path.join(dir, 'book.' + ext), output = path.join(dir, 'book.mobi');
    try {
        let size = 0;
        const out = fs.createWriteStream(input);
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_CONVERT_BYTES) { out.destroy(); cleanup(); return convertError(res, 413, 'The book is too large to convert.'); }
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        const task = converting.then(() => ebookConvert(input, output));
        converting = task.catch(() => {});
        await task;
        const mobi = name.replace(/\.[^.]*$/, '') + '.mobi';
        res.writeHead(200, { 'Content-Type': 'application/x-mobipocket-ebook', 'Content-Length': fs.statSync(output).size, 'X-File-Name': encodeURIComponent(mobi), 'Cache-Control': 'no-store' });
        fs.createReadStream(output).on('close', cleanup).pipe(res);
    } catch (error) {
        cleanup();
        console.warn('MOBI conversion failed:', error && (error.killed ? 'timed out' : error.code || 'error'));
        convertError(res, 502, error && error.killed ? 'Converting to MOBI took too long.' : 'This book could not be converted to MOBI.');
    }
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || !['/catalogue', '/download', '/convert'].includes(req.url)) { res.writeHead(404).end(); return; }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    if (req.url === '/convert') return convert(req, res);
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
server.requestTimeout = 600000;   // a download can include Z-Library's conversion (up to 5 min)
server.listen(PORT, HOST, () => console.log(`ReKindle catalogue browser ready on ${HOST}:${PORT}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    server.close();
    await closeCatalogueBrowser();
    process.exit(0);
});
