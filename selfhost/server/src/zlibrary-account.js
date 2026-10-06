// The Z-Library app's account cookie, per ReKindle account, and book downloads with it.
// Like the Substack app, the reader pastes their own Z-Library cookie (from a desktop
// browser where they are signed in); it is kept here and only ever sent to the
// Z-Library browser service, whose Chromium downloads the book (downloadBook in
// zlibrary-browser.js) so Z-Library's verification still passes. The Kindle browser
// downloads only MOBI, AZW, PRC and TXT (AZW3 is kept too), so any other book becomes
// Z-Library's MOBI (a MOBI file of the book, or Z-Library's own converter) or, when
// neither works, AZW3 made by Calibre (POST /convert).
// Downloads run as jobs (file-jobs.js); the finished file is fetched through a
// short-lived signed link (sendDownload), since a plain link cannot carry the ReKindle
// sign-in.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { db, metaGet, metaSet } from './db.js';
import { noticePage } from './transform.js';
import { cookiePairs } from './zlibrary-browser.js';
import { browserService, browserServiceConfigured, serviceMessage } from './browser-service.js';
import { jobStore, userError, saveBody, isReady, sendJobFile } from './file-jobs.js';

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
function normalizeCookie(text) {
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

const jobs = jobStore();
const KINDLE_FORMATS = new Set(['mobi', 'azw', 'azw3', 'prc', 'txt']);   // azw3: owner's choice
const TYPES = { mobi: 'application/x-mobipocket-ebook', azw: 'application/vnd.amazon.ebook', azw3: 'application/vnd.amazon.ebook', prc: 'application/x-mobipocket-ebook', txt: 'text/plain; charset=utf-8' };
const extOf = (name) => (String(name).split('.').pop() || '').toLowerCase();

// The file's name without Z-Library's " (Z-Library)" tag: "Title (Author).epub".
function fileName(res, fallback) {
    let name;
    try { name = decodeURIComponent(res.headers.get('x-file-name') || fallback); } catch { name = fallback; }
    return name.replace(/\s*\(Z-Library\)(?=\.[^.]+$)/i, '');
}

async function call(pathname, init, unreachable) {
    try { return await browserService(pathname, init); } catch { throw userError(unreachable, 502); }
}

async function download(job, dir, cookie) {
    let res = await call('/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: job.book, cookie }), signal: AbortSignal.timeout(600000)
    }, 'The Z-Library browser could not be reached. Try again in a moment.');
    if (!res.ok) throw userError(await serviceMessage(res, 'Z-Library did not start the download.'), 502, 'zlibrary/download-failed');
    let name = fileName(res, 'book');
    const original = await saveBody(res, path.join(dir, 'original'));
    if (KINDLE_FORMATS.has(extOf(name))) return { file: original, name };
    job.step = 'convert';
    res = await call('/convert', {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) },
        body: Readable.toWeb(fs.createReadStream(original)), duplex: 'half', signal: AbortSignal.timeout(400000)
    }, 'The converter could not be reached. Try again in a moment.');
    if (!res.ok) throw userError(await serviceMessage(res, 'This book could not be converted to AZW3.'), 502, 'zlibrary/download-failed');
    name = fileName(res, name.replace(/\.[^.]*$/, '') + '.azw3');
    const converted = await saveBody(res, path.join(dir, 'book.azw3'));
    fs.rmSync(original, { force: true });
    return { file: converted, name };
}

// Starts downloading (and converting) a book for this reader; returns { id }.
export function startJob(uid, bookUrl) {
    if (!bookUrlOk(bookUrl)) throw bad('Not a Z-Library book page.');
    const row = getRow.get(uid);
    if (!row) throw bad('Connect your Z-Library account first (Account, then paste your cookie).', 'zlibrary/not-connected');
    if (!browserServiceConfigured()) throw userError('Downloads need the Z-Library browser service (ZLIBRARY_BROWSER_ENDPOINT).', 503, 'zlibrary/unavailable');
    for (const job of jobs.working()) {
        if (job.uid !== uid) continue;
        if (job.book === bookUrl) return { id: job.id };
        throw userError('Another book is still downloading. Wait for it to finish.', 409, 'zlibrary/busy');
    }
    const job = jobs.start({ uid, book: bookUrl, step: 'download' }, (j, dir) => download(j, dir, row.cookie), 'The download failed. Try again in a moment.');
    return { id: job.id };
}

export function jobStatus(uid, id) {
    const job = jobs.get(id);
    if (!job || job.uid !== uid) throw userError('This download is no longer available. Tap Download again.', 404, 'not-found');
    if (job.status === 'failed') return { status: 'failed', message: job.message };
    if (job.status === 'working') return { status: 'working', step: job.step };
    const payload = Buffer.from(JSON.stringify({ u: uid, j: job.id, e: Date.now() + LINK_MS })).toString('base64url');
    return { status: 'ready', name: job.name, size: job.size, href: '/__rk/zlibrary/download?t=' + payload + '.' + sign(payload) };
}

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
    const job = jobs.get(link.j);
    if (!isReady(job) || job.uid !== link.u) return failPage(res, 410, 'This download is no longer available. Tap Download again.');
    sendJobFile(res, job, TYPES[extOf(job.name)] || 'application/octet-stream');
}
