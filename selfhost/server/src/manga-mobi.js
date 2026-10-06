// A Manga chapter as one MOBI file (the MOBI button in the Manga reader,
// selfhost/site/js/rk-manga-sources.js). The Kindle browser downloads only MOBI, AZW,
// PRC and TXT, so: the server packs the chapter's pages into a CBZ (a ZIP of the
// pictures) and the converter service (Calibre in the Z-Library browser service, POST
// /convert, ZLIBRARY_BROWSER_ENDPOINT) turns it into MOBI with image processing off.
//
// That takes a while, so it is a job, like Z-Library downloads: POST /__rk/manga/mobi
// {title, pages} -> {id}; GET /__rk/manga/mobi/<id> -> working (step "pages" or
// "convert") | failed (message) | ready (href); the href, /__rk/manga/mobi/<id>/file,
// downloads the file (kept 30 minutes; the random id is the permission). Pages come
// through the same server cache as the reader's own pages (images.js serveImage).
// Pictures stay the originals (owner's rule): JPEG and PNG pages go in unchanged; WebP
// and GIF pages (Manhuagui) become JPEG quality 90, since Kindle books can't show WebP.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { serveImage, mangadexOrigin } from './images.js';
import { withPublicNetworkOnly, rawFetch } from './netguard.js';
import * as manhuagui from './manhuagui.js';

const MAX_PAGES = 400;
const KEEP_MS = 30 * 60 * 1000;
const jobs = new Map();   // id -> { id, title, sources, status, step, done, total, started, dir, file, name, size, message, finished }

function fail(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code, userMessage: message });
}

setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
        if (job.finished && now - job.finished > KEEP_MS) {
            if (job.dir) fs.rmSync(job.dir, { recursive: true, force: true });
            jobs.delete(id);
        }
    }
}, 60000).unref();

// ---------------------------------------------------------------- pages

// The reader's page addresses: '/api/proxy?url=<MangaDex page>' or a signed
// '/__rk/manga/img?u=..&k=..' (Manhuagui). Anything else is refused.
function pageSource(page) {
    const s = String(page || '');
    let m = /^\/api\/proxy\?url=([^&]+)$/.exec(s);
    if (m) {
        let target;
        try { target = new URL(decodeURIComponent(m[1])); } catch { return null; }
        if (target.protocol !== 'https:' || !/(^|\.)(mangadex\.network|mangadex\.org)$/i.test(target.hostname)) return null;
        return { kind: 'md', target };
    }
    m = /^\/__rk\/manga\/img\?u=([A-Za-z0-9_-]+)&k=([A-Za-z0-9_-]+)$/.exec(s);
    if (m) return { kind: 'mhg', u: m[1], k: m[2] };
    return null;
}

async function fetchPage(src) {
    let response;
    if (src.kind === 'md') {
        const sources = [src.target.href];
        const origin = mangadexOrigin(src.target);
        if (origin) sources.push(origin);
        response = await withPublicNetworkOnly(() => serveImage(src.target.href, sources, { key: 'page' }));
    } else {
        response = await serveImage(`mhg:${src.u}:${src.k}`, [() => manhuagui.proxyImage(src.u, src.k)], { key: 'page' });
    }
    return { body: Buffer.from(await response.arrayBuffer()), type: response.headers.get('content-type') || '' };
}

// The picture to put in the comic: { ext, data }.
export async function comicImage(img) {
    const b = img.body;
    if (b[0] === 0xff && b[1] === 0xd8) return { ext: 'jpg', data: b };
    if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return { ext: 'png', data: b };
    const data = await sharp(b, { failOn: 'none', pages: 1, limitInputPixels: 2e8 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toBuffer();
    return { ext: 'jpg', data };
}

// ---------------------------------------------------------------- CBZ (ZIP, stored)

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

// Writes a ZIP with uncompressed entries (pictures are compressed already) to `out`.
export class ZipWriter {
    constructor(out) {
        this.out = out;
        this.offset = 0;
        this.entries = [];
    }

    write(buf) {
        this.offset += buf.length;
        return this.out.write(buf) ? Promise.resolve() : new Promise((resolve) => this.out.once('drain', resolve));
    }

    async add(name, data) {
        const nameBuf = Buffer.from(name, 'utf8');
        const crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0);
        header.writeUInt16LE(20, 4);            // version needed
        header.writeUInt16LE(0x0800, 6);        // UTF-8 names
        header.writeUInt16LE(0, 8);             // stored
        header.writeUInt32LE(0, 10);            // time, date
        header.writeUInt32LE(crc, 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(nameBuf.length, 26);
        header.writeUInt16LE(0, 28);
        this.entries.push({ nameBuf, crc, size: data.length, offset: this.offset });
        await this.write(header);
        await this.write(nameBuf);
        await this.write(data);
    }

    async finish() {
        const start = this.offset;
        for (const e of this.entries) {
            const h = Buffer.alloc(46);
            h.writeUInt32LE(0x02014b50, 0);
            h.writeUInt16LE(20, 4);
            h.writeUInt16LE(20, 6);
            h.writeUInt16LE(0x0800, 8);
            h.writeUInt16LE(0, 10);
            h.writeUInt32LE(0, 12);
            h.writeUInt32LE(e.crc, 16);
            h.writeUInt32LE(e.size, 20);
            h.writeUInt32LE(e.size, 24);
            h.writeUInt16LE(e.nameBuf.length, 28);
            h.writeUInt32LE(e.offset, 42);
            await this.write(h);
            await this.write(e.nameBuf);
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50, 0);
        end.writeUInt16LE(this.entries.length, 8);
        end.writeUInt16LE(this.entries.length, 10);
        end.writeUInt32LE(this.offset - start, 12);
        end.writeUInt32LE(start, 16);
        await this.write(end);
        await new Promise((resolve, reject) => this.out.end((e) => (e ? reject(e) : resolve())));
    }
}

// ---------------------------------------------------------------- jobs

function converter(pathname, init) {
    const headers = { ...(init.headers || {}) };
    if (process.env.ZLIBRARY_BROWSER_TOKEN) headers.Authorization = 'Bearer ' + process.env.ZLIBRARY_BROWSER_TOKEN;
    return rawFetch(new URL(pathname, process.env.ZLIBRARY_BROWSER_ENDPOINT), { ...init, headers });
}

const safeName = (title) => title.replace(/[\\/:*?"<>|]+/g, '-');

async function run(job) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-manga-'));
    job.dir = dir;
    try {
        const cbz = path.join(dir, 'chapter.cbz');
        const zip = new ZipWriter(fs.createWriteStream(cbz));
        let pages = 0;
        for (let n = 0; n < job.sources.length; n++) {
            try {
                const img = await comicImage(await fetchPage(job.sources[n]));
                await zip.add(String(n + 1).padStart(4, '0') + '.' + img.ext, img.data);
                pages++;
            } catch { /* a page that can't be fetched is left out */ }
            job.done = n + 1;
        }
        await zip.finish();
        if (!pages) throw fail('None of the pages could be fetched. Try again in a moment.', 502);
        job.step = 'convert';
        let res;
        try {
            res = await converter('/convert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(safeName(job.title) + '.cbz') },
                body: Readable.toWeb(fs.createReadStream(cbz)), duplex: 'half', signal: AbortSignal.timeout(600000)
            });
        } catch { throw fail('The converter could not be reached. Try again in a moment.', 502); }
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw fail(text && text.length < 300 && !/^\s*</.test(text) ? text : 'The chapter could not be made into a MOBI.', 502);
        }
        const file = path.join(dir, 'chapter.mobi');
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
        fs.rmSync(cbz, { force: true });
        Object.assign(job, { status: 'ready', file, name: safeName(job.title) + '.mobi', size: fs.statSync(file).size, missing: job.sources.length - pages, finished: Date.now() });
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        Object.assign(job, { status: 'failed', message: error.userMessage || 'Making the MOBI failed. Try again in a moment.', finished: Date.now() });
    }
}

export function startJob(body) {
    if (!process.env.ZLIBRARY_BROWSER_ENDPOINT) throw fail('MOBI downloads need the converter service (ZLIBRARY_BROWSER_ENDPOINT).', 503, 'manga/unavailable');
    const pages = Array.isArray(body && body.pages) ? body.pages : [];
    if (!pages.length) throw fail('No pages to download.');
    if (pages.length > MAX_PAGES) throw fail(`A chapter can have at most ${MAX_PAGES} pages.`);
    const sources = pages.map(pageSource);
    if (sources.some((src) => !src)) throw fail('Unknown page address.');
    const title = String((body && body.title) || 'Manga').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Manga';
    for (const job of jobs.values()) {
        if (job.status === 'working' && job.title === title) return { id: job.id };   // tapped twice
    }
    const job = { id: crypto.randomBytes(16).toString('base64url'), title, sources, status: 'working', step: 'pages', done: 0, total: sources.length, started: Date.now() };
    jobs.set(job.id, job);
    run(job);
    return { id: job.id };
}

export function jobStatus(id) {
    const job = jobs.get(String(id || ''));
    if (!job) throw fail('This download is no longer available. Tap MOBI again.', 404, 'not-found');
    if (job.status === 'failed') return { status: 'failed', message: job.message };
    if (job.status === 'working') return { status: 'working', step: job.step, done: job.done, total: job.total };
    return { status: 'ready', name: job.name, size: job.size, missing: job.missing, href: `/__rk/manga/mobi/${job.id}/file` };
}

export function sendFile(res, id) {
    const job = jobs.get(String(id || ''));
    if (!job || job.status !== 'ready' || !fs.existsSync(job.file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This download is no longer available. Tap MOBI again.');
        return;
    }
    const ascii = job.name.replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(200, {
        'Content-Type': 'application/x-mobipocket-ebook',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.name)}`,
        'Content-Length': job.size,
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(job.file).on('error', () => res.destroy()).pipe(res);
}
