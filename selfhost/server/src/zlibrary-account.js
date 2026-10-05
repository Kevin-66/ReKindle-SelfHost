// The Z-Library app's account cookie, per ReKindle account, and book downloads with it.
// Like the Substack app, the reader pastes their own Z-Library cookie (from a desktop
// browser where they are signed in); it is kept here and only ever sent to the
// Z-Library browser service, whose Chromium downloads the book (downloadBook in
// zlibrary-browser.js) so Z-Library's verification still passes. The Kindle then
// gets the file from this server through a short-lived signed link, since a plain
// link cannot carry the ReKindle sign-in.

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
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

export function downloadLink(uid, bookUrl) {
    if (!bookUrlOk(bookUrl)) throw bad('Not a Z-Library book page.');
    if (!getRow.get(uid)) throw bad('Connect your Z-Library account first (Account, then paste your cookie).', 'zlibrary/not-connected');
    const payload = Buffer.from(JSON.stringify({ u: uid, b: bookUrl, e: Date.now() + LINK_MS })).toString('base64url');
    return { href: '/__rk/zlibrary/download?t=' + payload + '.' + sign(payload) };
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

// GET /__rk/zlibrary/download?t=<signed>: opened by the Kindle as a normal link.
export async function sendDownload(res, token) {
    const [payload, sig] = String(token || '').split('.');
    const expected = payload ? sign(payload) : '';
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return failPage(res, 403, 'This download link is not valid.');
    let link;
    try { link = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return failPage(res, 403, 'This download link is not valid.'); }
    if (!link || link.e < Date.now()) return failPage(res, 410, 'This download link has expired. Tap Download again.');
    const row = getRow.get(link.u);
    if (!row) return failPage(res, 400, 'Connect your Z-Library account first.');
    if (!process.env.ZLIBRARY_BROWSER_ENDPOINT) return failPage(res, 503, 'Downloads need the Z-Library browser service (ZLIBRARY_BROWSER_ENDPOINT).');
    let upstream;
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.ZLIBRARY_BROWSER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ZLIBRARY_BROWSER_TOKEN;
        upstream = await rawFetch(new URL('/download', process.env.ZLIBRARY_BROWSER_ENDPOINT), {
            method: 'POST', headers, body: JSON.stringify({ url: link.b, cookie: row.cookie }), signal: AbortSignal.timeout(170000)
        });
    } catch {
        return failPage(res, 502, 'The Z-Library browser could not be reached. Try again in a moment.');
    }
    if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return failPage(res, 502, text && text.length < 400 ? text : 'Z-Library did not start the download.');
    }
    let name = 'book';
    try { name = decodeURIComponent(upstream.headers.get('x-file-name') || 'book'); } catch { }
    const ext = (name.split('.').pop() || '').toLowerCase();
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {}),
        'Cache-Control': 'no-store'
    });
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
}
