// The Z-Library app's account cookie, per ReKindle account, and book downloads with it.
// Like the Substack app, the reader pastes their own Z-Library cookie (from a desktop
// browser where they are signed in); it is kept here and only ever sent to the
// Z-Library browser service, whose Chromium downloads the book (downloadBook in
// zlibrary-browser.js) so Z-Library's verification still passes. EPUB books, which
// the Kindle can't open, become MOBI: Z-Library's own converter first, Calibre (POST
// /convert) when that fails (see downloadBook); other formats are passed on as they are.
// That can take minutes, longer than a page request should wait behind a proxy, so it
// runs as a job: the page starts it (startJob), asks how it is going (jobStatus) and,
// when the file is ready here, opens a short-lived signed link to it (sendDownload),
// since a plain link cannot carry the ReKindle sign-in.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db, metaGet, metaSet } from './db.js';
import { rawFetch } from './netguard.js';
import { noticePage } from './transform.js';
import { cookiePairs } from './zlibrary-browser.js';

const LINK_MS = 10 * 60 * 1000;
const getRow = db.prepare('SELECT cookie FROM zlib_accounts WHERE uid = ?');
const putRow = db.prepare('INSERT INTO zlib_accounts(uid, cookie, updated) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET cookie = excluded.cookie, updated = excluded.updated');
const delRow = db.prepare('DELETE FROM zlib_accounts WHERE uid = ?');

function linkKey() {
    let k = metaGet('zlibrary_link_key');
    if (!k) {
        k = crypto.randomBytes(32).toString('hex');
        metaSet('zlibrary_link_key', k);
    }
    return k;
}
const KEY = linkKey();
const sign = (payload) => crypto.createHmac('sha256', KEY).update(payload).digest('base64url');

function bad(message, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status: 400, code });
}

// "remix_userid=...; remix_userkey=..." or a whole Cookie line; only name=value pairs kept.
export function normalizeCookie(text) {
    const pairs = cookiePairs(String(text || '').replace(/^\s*cookie:\s*/i, '').replace(/\n/g, ';'));
    const joined = pairs.map(([k, v]) => k + '=' + v).join('; ');
    return pairs.length && joined.length <= 4096 ? joined : null;
}

export function accountStatus(uid) {
    return { connected: !!getRow.get(uid) };
}

export function saveAccount(uid, text) {
    const cookie = normalizeCookie(text);
    if (!cookie) throw bad('Paste the cookie as name=value pairs, e.g. remix_userid=...; remix_userkey=...');
    putRow.run(uid, cookie, Date.now());
    return { connected: true };
}

export function removeAccount(uid) {
    delRow.run(uid);
    return { connected: false };
}

function bookUrlOk(value) {
    try {
        const u = new URL(value);
        return u.origin === 'https://z-lib.sk' && /^\/book\/[^/]+\/[^/]+\.html$/.test(u.pathname);
    } catch { return false; }
}

// ------------------------------------------------------------------ download jobs

const JOB_KEEP_MS = 30 * 60 * 1000;   // a finished file stays this long (the Kindle may retry)
const jobs = new Map();               // id -> { id, uid, book, status, step, started, file, name, size, message }

function userError(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code, userMessage: message });
}

function browserFetch(pathname, init) {
    const headers = { ...(init.headers || {}) };
    if (process.env.ZLIBRARY_BROWSER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ZLIBRARY_BROWSER_TOKEN;
    return rawFetch(new URL(pathname, process.env.ZLIBRARY_BROWSER_ENDPOINT), { ...init, headers });
}

async function browserError(res, fallback) {
    const text = await res.text().catch(() => '');
    return userError(text && text.length < 400 && !/^\s*</.test(text) ? text : fallback, 502, 'zlibrary/download-failed');
}

function fileName(res, fallback) {
    try { return decodeURIComponent(res.headers.get('x-file-name') || fallback); } catch { return fallback; }
}

const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

async function runJob(job, cookie) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-zlib-'));
    job.dir = dir;
    try {
        let res;
        try {
            res = await browserFetch('/download', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: job.book, cookie }), signal: AbortSignal.timeout(600000)
            });
        } catch { throw userError('The Z-Library browser could not be reached. Try again in a moment.', 502); }
        if (!res.ok) throw await browserError(res, 'Z-Library did not start the download.');
        let name = fileName(res, 'book');
        let file = path.join(dir, 'original');
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
        if (extOf(name) === 'epub') {   // the Kindle opens other formats (MOBI, PDF, TXT, ...) as they are
            job.step = 'convert';
            job.from = extOf(name);
            try {
                res = await browserFetch('/convert', {
                    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
                    body: Readable.toWeb(fs.createReadStream(file)), duplex: 'half', signal: AbortSignal.timeout(400000)
                });
            } catch { throw userError('The converter could not be reached. Try again in a moment.', 502); }
            if (!res.ok) throw await browserError(res, 'This book could not be converted to MOBI.');
            name = fileName(res, name.replace(/\.[^.]*$/, '') + '.mobi');
            const mobi = path.join(dir, 'book.mobi');
            await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(mobi));
            fs.rmSync(file, { force: true });
            file = mobi;
        }
        Object.assign(job, { status: 'ready', file, name, size: fs.statSync(file).size, finished: Date.now() });
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        Object.assign(job, { status: 'failed', message: error.userMessage || 'The download failed. Try again in a moment.', finished: Date.now() });
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finished && now - job.finished > JOB_KEEP_MS) {
            if (job.dir) fs.rmSync(job.dir, { recursive: true, force: true });
            jobs.delete(id);
        }
    }
}, 60000).unref();

// Starts downloading (and converting) a book for this reader; returns { id }.
export function startJob(uid, bookUrl) {
    if (!bookUrlOk(bookUrl)) throw bad('Not a Z-Library book page.');
    const row = getRow.get(uid);
    if (!row) throw bad('Connect your Z-Library account first (Account, then paste your cookie).', 'zlibrary/not-connected');
    if (!process.env.ZLIBRARY_BROWSER_ENDPOINT) throw userError('Downloads need the Z-Library browser service (ZLIBRARY_BROWSER_ENDPOINT).', 503, 'zlibrary/unavailable');
    for (const job of jobs.values()) {
        if (job.uid !== uid || job.status !== 'working') continue;
        if (job.book === bookUrl) return { id: job.id };
        throw userError('Another book is still downloading. Wait for it to finish.', 409, 'zlibrary/busy');
    }
    const job = { id: crypto.randomBytes(12).toString('base64url'), uid, book: bookUrl, status: 'working', step: 'download', started: Date.now() };
    jobs.set(job.id, job);
    runJob(job, row.cookie);
    return { id: job.id };
}

export function jobStatus(uid, id) {
    const job = jobs.get(String(id || ''));
    if (!job || job.uid !== uid) throw userError('This download is no longer available. Tap Download again.', 404, 'not-found');
    if (job.status === 'failed') return { status: 'failed', message: job.message };
    if (job.status === 'working') return { status: 'working', step: job.step, from: job.from || null, seconds: Math.round((Date.now() - job.started) / 1000) };
    const payload = Buffer.from(JSON.stringify({ u: uid, j: job.id, e: Date.now() + LINK_MS })).toString('base64url');
    return { status: 'ready', name: job.name, size: job.size, href: '/__rk/zlibrary/download?t=' + payload + '.' + sign(payload) };
}

const TYPES = {
    pdf: 'application/pdf', epub: 'application/epub+zip', mobi: 'application/x-mobipocket-ebook',
    azw3: 'application/vnd.amazon.ebook', azw: 'application/vnd.amazon.ebook', txt: 'text/plain; charset=utf-8',
    djvu: 'image/vnd.djvu', fb2: 'application/x-fictionbook+xml', rtf: 'application/rtf'
};

function failPage(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        .end(noticePage('Download failed', message.replace(/[<>&]/g, '') + ' <a href="zlibrary">Back to Z-Library</a>'));
}

// GET /__rk/zlibrary/download?t=<signed>: opened by the Kindle as a normal link once
// the job's file is ready.
export async function sendDownload(res, token) {
    const [payload, sig] = String(token || '').split('.');
    const expected = payload ? sign(payload) : '';
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return failPage(res, 403, 'This download link is not valid.');
    let link;
    try { link = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return failPage(res, 403, 'This download link is not valid.'); }
    if (!link || link.e < Date.now()) return failPage(res, 410, 'This download link has expired. Tap Download again.');
    const job = jobs.get(String(link.j || ''));
    if (!job || job.uid !== link.u || job.status !== 'ready' || !fs.existsSync(job.file)) return failPage(res, 410, 'This download is no longer available. Tap Download again.');
    const name = job.name;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
        'Content-Type': TYPES[extOf(name)] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Content-Length': job.size,
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(job.file).on('error', () => res.destroy()).pipe(res);
}
