// A Manga chapter as one MOBI file (the MOBI button in the Manga reader,
// selfhost/site/js/rk-manga-sources.js). The Kindle browser downloads only MOBI, AZW,
// PRC and TXT, so: the server packs the chapter's pages into a CBZ (a ZIP of the
// pictures) and the converter service (Calibre in the Z-Library browser service, POST
// /convert, ZLIBRARY_BROWSER_ENDPOINT) turns it into MOBI with image processing off.
//
// That takes a while, so it is a job (file-jobs.js), like Z-Library downloads: POST
// /__rk/manga/mobi {title, pages} -> {id}; GET /__rk/manga/mobi/<id> -> working (step
// "pages" or "convert") | failed (message) | ready (href); the href,
// /__rk/manga/mobi/<id>/file, downloads the file (the random id is the permission). Pages come
// through the same server cache as the reader's own pages (images.js serveImage), and
// are sized to fill the Kindle Scribe's screen (see comicImage).

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { serveImage, mangadexOrigin } from './images.js';
import { withPublicNetworkOnly } from './netguard.js';
import { browserService, browserServiceConfigured, serviceMessage } from './browser-service.js';
import { jobStore, userError, saveBody, isReady, sendJobFile } from './file-jobs.js';
import * as manhuagui from './manhuagui.js';

const MAX_PAGES = 400;
const jobs = jobStore();

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

// The Kindle Scribe's screen (Calibre's kindle_scribe profile, used for comics).
export const SCREEN = { width: 1860, height: 2480 };

// The picture to put in the comic: { ext: 'jpg', data }. Pages are sized for the screen
// (the Kindle doesn't enlarge a book's pictures; the converter also makes them full
// width), and always JPEG: Calibre stores PNG pages in Kindle books as 256-colour GIFs.
// Sharp's Lanczos resize to fit 1860x2480 (aspect kept), JPEG quality 92 with full
// colour detail; a JPEG page that already fits the screen goes in unchanged.
export async function comicImage(img) {
    const b = img.body;
    const isJpeg = b[0] === 0xff && b[1] === 0xd8;
    const meta = await sharp(b, { failOn: 'none', pages: 1, limitInputPixels: 2e8 }).metadata();
    const scale = meta.width && meta.height ? Math.min(SCREEN.width / meta.width, SCREEN.height / meta.height) : 1;
    if (isJpeg && Math.abs(scale - 1) < 0.02) return { ext: 'jpg', data: b };
    const data = await sharp(b, { failOn: 'none', pages: 1, limitInputPixels: 2e8 })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({ width: SCREEN.width, height: SCREEN.height, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' })
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
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

const safeName = (title) => title.replace(/[\\/:*?"<>|]+/g, '-');

async function makeMobi(job, dir) {
    const cbz = path.join(dir, 'chapter.cbz');
    const zip = new ZipWriter(fs.createWriteStream(cbz));
    let pages = 0;
    for (let n = 0; n < job.sources.length; n++) {
        try {
            const img = await comicImage(await fetchPage(job.sources[n]));
            await zip.add(String(n + 1).padStart(4, '0') + '.' + img.ext, img.data);
            pages++;
        } catch { /* a page that can't be fetched is left out */ }
    }
    await zip.finish();
    if (!pages) throw userError('None of the pages could be fetched. Try again in a moment.', 502);
    job.missing = job.sources.length - pages;
    job.step = 'convert';
    let res;
    try {
        res = await browserService('/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(safeName(job.title) + '.cbz') },
            body: Readable.toWeb(fs.createReadStream(cbz)), duplex: 'half', signal: AbortSignal.timeout(600000)
        });
    } catch { throw userError('The converter could not be reached. Try again in a moment.', 502); }
    if (!res.ok) throw userError(await serviceMessage(res, 'The chapter could not be made into a MOBI.'), 502);
    const file = await saveBody(res, path.join(dir, 'chapter.mobi'));
    fs.rmSync(cbz, { force: true });
    return { file, name: safeName(job.title) + '.mobi' };
}

export function startJob(body) {
    if (!browserServiceConfigured()) throw userError('MOBI downloads need the converter service (ZLIBRARY_BROWSER_ENDPOINT).', 503, 'manga/unavailable');
    const pages = Array.isArray(body && body.pages) ? body.pages : [];
    if (!pages.length) throw userError('No pages to download.');
    if (pages.length > MAX_PAGES) throw userError(`A chapter can have at most ${MAX_PAGES} pages.`);
    const sources = pages.map(pageSource);
    if (sources.some((src) => !src)) throw userError('Unknown page address.');
    const title = String((body && body.title) || 'Manga').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Manga';
    const running = jobs.working().find((job) => job.title === title);   // tapped twice
    if (running) return { id: running.id };
    return { id: jobs.start({ title, sources, step: 'pages' }, makeMobi, 'Making the MOBI failed. Try again in a moment.').id };
}

export function jobStatus(id) {
    const job = jobs.get(id);
    if (!job) throw userError('This download is no longer available. Tap MOBI again.', 404, 'not-found');
    if (job.status === 'failed') return { status: 'failed', message: job.message };
    if (job.status === 'working') return { status: 'working', step: job.step };
    return { status: 'ready', name: job.name, size: job.size, missing: job.missing, href: `/__rk/manga/mobi/${job.id}/file` };
}

export function sendFile(res, id) {
    const job = jobs.get(id);
    if (!isReady(job)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This download is no longer available. Tap MOBI again.');
        return;
    }
    sendJobFile(res, job, 'application/x-mobipocket-ebook');
}
