// Z-Library catalogue browser service (Dockerfile.zlibrary-browser). The ReKindle
// server posts a catalogue URL; this loads it in Chromium (zlibrary-browser.mjs, a
// copy of selfhost/server/src/zlibrary-browser.js) and returns the page HTML.
// POST /download {url, cookie} downloads one book with the reader's Z-Library cookie
// and streams the file back (name in X-File-Name). POST /convert takes a book file
// (body, name in X-File-Name; a book or a CBZ comic) and returns it as AZW3, which the
// Kindle browser can download, made by Calibre's ebook-convert. POST /kcc takes one
// Manga page and returns it as Kindle Comic Converter makes it for the reader.
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

// The Kindle browser downloads Kindle books (MOBI, AZW, AZW3, PRC) and TXT only, so
// books in any format Calibre reads (Z-Library) and CBZ comics (Manga chapters, made by
// the ReKindle server) are converted, to AZW3 (KF8; owner, 2026-10-06). PDF and DJVU
// convert only as well as their text allows.
const CONVERTIBLE = new Set(['epub', 'azw4', 'fb2', 'fbz', 'pdf', 'djvu', 'docx', 'odt', 'rtf', 'html', 'htm', 'htmlz',
    'lit', 'pdb', 'pml', 'rb', 'snb', 'tcr', 'chm', 'lrf', 'txtz', 'cbz', 'cbr', 'cb7', 'cbc']);
// Comics: no greyscale, resizing or sharpening (the owner reads colour manga on a Kindle
// Scribe Colorsoft): the ReKindle server sends the original PNG/JPEG pages, padded to the
// screen's shape (manga-azw3.js), and the AZW3 writer keeps them byte for byte (checked
// on the live service), except a JPEG without a JFIF header, which it re-saves at
// quality 75 (the server adds JFIF). Calibre's page HTML shows each picture at its own
// size (width/height auto); width: 100% makes it fill the page. --no-inline-toc: no
// "Page 1, Page 2, ..." contents page in the book (owner). The server then marks the
// book fixed-layout (azw3-fixed-layout.js), which Calibre can't.
const COMIC_ARGS = ['--no-process', '--output-profile', 'kindle_scribe', '--no-inline-toc',
    '--extra-css', 'img { width: 100% !important; height: auto !important; }'];
// Formats that usually carry no title or author: those come from the file name, which
// for Z-Library is "Title (Author) (Z-Library).ext". (Without this the Kindle library
// showed such books, and every Manga chapter, as "book" by "Unknown": the upload is
// saved under a temporary name.) EPUB, FB2, DOCX, ... keep their own details.
const NAME_METADATA = new Set(['pdf', 'djvu', 'rtf', 'html', 'htm', 'txtz', 'chm', 'cbr', 'cb7', 'cbc', 'lrf', 'pdb', 'pml', 'rb', 'snb', 'tcr']);

function metadataArgs(base, ext) {
    if (ext === 'cbz') return ['--title', base];   // Manga chapters: "Manga title - Ch 12"
    if (!NAME_METADATA.has(ext)) return [];
    const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(base);
    return m ? ['--title', m[1], '--authors', m[2]] : ['--title', base];
}
const MAX_CONVERT_BYTES = 300 * 1024 * 1024;
const CONVERT_MS = 300000;
let converting = Promise.resolve();

// Kindle Comic Converter (KCC, github.com/ciromattia/kcc, ISC licence; its own Python
// in Dockerfile.zlibrary-browser), when Settings asks for it (owner, 2026-10-19). Off,
// pages stay the originals as above. Its own MOBI/AZW3 output needs Amazon's KindleGen,
// which Amazon no longer offers, so KCC only prepares the pages (-f FOLDER: no
// KindleGen, no 7-Zip) and Calibre still makes the book. --forcecolor keeps colour pages
// in colour (Kindle Scribe Colorsoft); grey pages stay grey. Profile KS = 1860x2480, the
// screen the rest of the comic pipeline uses (manga-azw3.js SCREEN).
// - Books (X-Comic-Style kcc / kcc-rtl on a CBZ): margins and page numbers cropped,
//   contrast and gamma for e-ink, double pages split (right half first for kcc-rtl,
//   KCC's manga mode), every page enlarged or padded to exactly 1860x2480.
// - Reader pages (/kcc): the same, but small pages keep their size (the browser draws
//   them as large as the reader allows) and double pages stay whole (-r 1 --norotate),
//   so the chapter keeps its page count.
const KCC = process.env.KCC_C2E || '/opt/kcc/bin/kcc-c2e';
const KCC_ARGS = ['-p', 'KS', '-f', 'FOLDER', '--forcecolor'];
const KCC_BOOK_ARGS = { kcc: ['--upscale'], 'kcc-rtl': ['--upscale', '-m'] };
const KCC_PAGE_ARGS = ['-r', '1', '--norotate'];
const KCC_PAGE_MS = 25000;   // the ReKindle server gives up after 30 s and shows the original
const MAX_PAGE_BYTES = 40 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const PAGES_AT_ONCE = 2;   // reader pages; a book is one Calibre job at a time anyway
let pagesRunning = 0;
const pagesWaiting = [];

const kccInstalled = () => fs.existsSync(KCC);

function run(file, args, timeout) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error) => (error ? reject(error) : resolve()));
    });
}

// The pictures KCC wrote (in a folder named after the input), in page order: its names
// are kcc-<original name>-kcc-<x>.<ext>, the halves of a split page b then c.
function picturesIn(dir) {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...picturesIn(file));
        else if (IMAGE_TYPE[path.extname(entry.name).slice(1).toLowerCase()]) found.push(file);
    }
    return found.sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
}

async function kcc(inDir, outDir, extra, timeout) {
    fs.mkdirSync(outDir, { recursive: true });
    await run(KCC, KCC_ARGS.concat(extra, ['-o', outDir, inDir]), timeout);
    const pictures = picturesIn(outDir);
    if (!pictures.length) throw new Error('KCC wrote no pages');
    return pictures;
}

// A chapter's CBZ, its pages replaced by KCC's (stored ZIP, as the ReKindle server
// writes it; Python's zipfile is already there for KCC).
async function kccComic(cbz, style, dir) {
    const pages = path.join(dir, 'pages'), out = path.join(dir, 'kcc');
    await run('python3', ['-m', 'zipfile', '-e', cbz, pages], CONVERT_MS);
    const pictures = await kcc(pages, out, KCC_BOOK_ARGS[style], CONVERT_MS);
    fs.rmSync(cbz, { force: true });
    await run('python3', ['-m', 'zipfile', '-c', cbz].concat(pictures), CONVERT_MS);
}

async function pageSlot() {
    if (pagesRunning < PAGES_AT_ONCE) { pagesRunning++; return; }
    await new Promise((resolve) => pagesWaiting.push(resolve));
}

function pageDone() {
    const next = pagesWaiting.shift();
    if (next) next(); else pagesRunning--;
}

// POST /kcc: body = one Manga page (JPEG, PNG, WebP or GIF), answer = KCC's version.
async function kccPage(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_EXT[type]) { req.resume(); return convertError(res, 415, 'Send a JPEG, PNG, WebP or GIF page.'); }
    if (!kccInstalled()) { req.resume(); return convertError(res, 501, 'Kindle Comic Converter is not installed in the converter service.'); }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_PAGE_BYTES) return convertError(res, 413, 'The page is too large.');
        chunks.push(chunk);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcc-'));
    await pageSlot();
    try {
        fs.mkdirSync(path.join(dir, 'page'));
        fs.writeFileSync(path.join(dir, 'page', '0001.' + IMAGE_EXT[type]), Buffer.concat(chunks));
        const [picture] = await kcc(path.join(dir, 'page'), path.join(dir, 'out'), KCC_PAGE_ARGS, KCC_PAGE_MS);
        const body = fs.readFileSync(picture);
        res.writeHead(200, { 'Content-Type': IMAGE_TYPE[path.extname(picture).slice(1).toLowerCase()], 'Content-Length': body.length, 'Cache-Control': 'no-store' }).end(body);
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') console.warn('KCC page failed:', error && (error.killed ? 'timed out' : error.code || error.message));   // logged locally only
        convertError(res, 502, 'Kindle Comic Converter could not process this page.');
    } finally {
        pageDone();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

function convertError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(message);
}

// One conversion at a time (it is CPU-heavy). The output's .azw3 name picks Calibre's
// AZW3 (KF8 only) writer. (A KF8-only file named .mobi, Calibre's MOBI writer with
// --mobi-file-type new, would not open on the Kindle.)
function ebookConvert(input, output, extra) {
    const args = [input, output].concat(extra || []);
    if (args.indexOf('--output-profile') < 0) args.push('--output-profile', 'kindle_pw3');
    return new Promise((resolve, reject) => {
        execFile('ebook-convert', args, {
            timeout: CONVERT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }
        }, (error) => (error ? reject(error) : resolve()));
    });
}

async function convert(req, res) {
    let name = 'book';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'book')); } catch { }
    name = name.replace(/[\\/\0\r\n"]/g, '_').slice(0, 200);
    const ext = (path.extname(name).slice(1) || '').toLowerCase();
    if (!CONVERTIBLE.has(ext)) { req.resume(); return convertError(res, 415, `A .${ext || '?'} file can't be converted to AZW3.`); }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    // The book's own name (without Z-Library's tag), so Calibre has it as a fallback title.
    const base = name.replace(/\.[^.]*$/, '').replace(/\s*\(Z-Library\)\s*$/i, '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 150) || 'book';
    const input = path.join(dir, base + '.' + ext), output = path.join(dir, 'book.azw3');
    // Manga chapters: the pages as KCC makes them, when Settings asks for it.
    const style = ext === 'cbz' ? String(req.headers['x-comic-style'] || '') : '';
    const withKcc = Object.prototype.hasOwnProperty.call(KCC_BOOK_ARGS, style);
    if (withKcc && !kccInstalled()) { req.resume(); cleanup(); return convertError(res, 501, 'Kindle Comic Converter is not installed in the converter service.'); }
    let step = 'convert';
    try {
        let size = 0;
        const out = fs.createWriteStream(input);
        for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_CONVERT_BYTES) { out.destroy(); cleanup(); return convertError(res, 413, 'The book is too large to convert.'); }
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
        const task = converting.then(async () => {
            if (withKcc) { step = 'kcc'; await kccComic(input, style, dir); step = 'convert'; }
            await ebookConvert(input, output, (ext === 'cbz' ? COMIC_ARGS : []).concat(metadataArgs(base, ext)));
        });
        converting = task.catch(() => {});
        await task;
        res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.ebook', 'Content-Length': fs.statSync(output).size, 'X-File-Name': encodeURIComponent(base + '.azw3'), 'Cache-Control': 'no-store' });
        fs.createReadStream(output).on('close', cleanup).pipe(res);
    } catch (error) {
        cleanup();
        if (process.env.NODE_ENV !== 'production') console.warn(step === 'kcc' ? 'KCC failed:' : 'AZW3 conversion failed:', error && (error.killed ? 'timed out' : error.code || 'error'));   // logged locally only
        if (step === 'kcc') return convertError(res, 502, error && error.killed ? 'Kindle Comic Converter took too long.' : 'Kindle Comic Converter could not process these pages.');
        convertError(res, 502, error && error.killed ? 'Converting to AZW3 took too long.' : 'This book could not be converted to AZW3.');
    }
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || !['/catalogue', '/download', '/convert', '/kcc'].includes(req.url)) { res.writeHead(404).end(); return; }
    if (!authorized(req)) { res.writeHead(401).end(); return; }
    if (req.url === '/convert') return convert(req, res);
    if (req.url === '/kcc') return kccPage(req, res);
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
