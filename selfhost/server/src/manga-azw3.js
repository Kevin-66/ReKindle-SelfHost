// A Manga chapter as one Kindle book (the AZW3 button in the Manga reader,
// selfhost/site/js/rk-manga-sources.js). The Kindle browser downloads only Kindle books
// and TXT, so: the server packs the chapter's pages into a CBZ (a ZIP of the pictures)
// and the converter service (Calibre in the Z-Library browser service, POST /convert,
// ZLIBRARY_BROWSER_ENDPOINT) turns it into a KF8 book with image processing off. KF8
// only (the converter's comic settings), so it is named .azw3: the same file named
// .mobi would not open on the Kindle.
//
// That takes a while, so it is a job (file-jobs.js), like Z-Library downloads: POST
// /__rk/manga/azw3 {title, pages} -> {id}; GET /__rk/manga/azw3/<id> -> working (step
// "pages" or "convert") | failed (message) | ready (href); the href,
// /__rk/manga/azw3/<id>/file, downloads the file (the random id is the permission).
// Pages come through the same server cache as the reader's own pages (images.js
// serveImage), go in as the originals as far as possible (see comicImage), and the
// finished book is marked as a fixed-layout comic (azw3-fixed-layout.js), so each page
// fills the screen instead of sitting inside the Kindle's page margins.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { serveImage, mangadexOrigin } from './images.js';
import { withPublicNetworkOnly } from './netguard.js';
import { browserService, browserServiceConfigured, serviceMessage } from './browser-service.js';
import { jobStore, userError, saveBody, isReady, sendJobFile } from './file-jobs.js';
import { setExth, fixedLayoutRecords } from './azw3-fixed-layout.js';
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

// The Kindle Scribe's screen (Calibre's kindle_scribe profile, used for comics): pages
// larger than this shrink to fit it, and every page has its 3:4 shape.
export const SCREEN = { width: 1860, height: 2480 };

const OPEN = { failOn: 'none', pages: 1, limitInputPixels: 2e8 };

// The book's page size: a fixed-layout book has one (its original-resolution), and the
// Kindle scales that page to fill the screen. It does not enlarge a picture beyond its
// own size within the page, so the page must be the pictures' own size: the chapter's
// most common page size (each page shrunk to fit the screen if larger, in its 3:4 shape).
// `pictures`: Buffers or file paths.
export async function bookPageSize(pictures) {
    const counts = new Map();
    for (const picture of pictures) {
        let meta;
        try { meta = await sharp(picture, OPEN).metadata(); } catch { continue; }
        const { width, height } = meta.orientation > 4 ? { width: meta.height, height: meta.width } : meta;
        if (!width || !height) continue;
        const scale = Math.min(1, SCREEN.width / width, SCREEN.height / height);
        const page = pageShape(Math.round(width * scale), Math.round(height * scale));
        const key = page.width + 'x' + page.height;
        counts.set(key, { page, n: ((counts.get(key) || {}).n || 0) + 1 });
    }
    let best = null;
    for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.page.width > best.page.width)) best = c;
    return best ? best.page : SCREEN;
}

// The picture to put in the comic: { ext, data }, the original as far as possible, as a
// page of `page` size (bookPageSize):
// - a picture already that size goes in as it is; any other is fitted into the page
//   (aspect kept), centred, each gap black or white to match the picture's edge beside
//   it (like Kindle Comic Converter, so a dark page doesn't get white bars);
// - colour as it is; PNG stays PNG (re-saved losslessly when fitted); JPEG stays JPEG,
//   re-encoded (quality 92) only when fitted or carrying EXIF; anything else
//   (WebP: the Kindle can't show it) becomes JPEG. Calibre's AZW3 writer keeps PNG and
//   JPEG as they are, except a JPEG without a JFIF header or with EXIF, which it re-saves
//   at quality 75 ("Amazon's renderer can't show JPEGs without JFIF"); sharp writes no
//   JFIF, so withJfif adds it.
export async function comicImage(img, page) {
    const b = img.body;
    const meta = await sharp(b, OPEN).metadata();
    const png = meta.format === 'png';
    const asIs = meta.width === page.width && meta.height === page.height && !(meta.orientation > 1);
    if (asIs && png) return { ext: 'png', data: b };
    if (asIs && meta.format === 'jpeg' && !meta.exif) return { ext: 'jpg', data: withJfif(b) };   // CMYK too: the Kindle shows it
    const grey = meta.space === 'b-w' || meta.channels <= 2;   // no colour in the original
    let pipeline = sharp(b, OPEN).rotate();
    if (meta.hasAlpha) pipeline = pipeline.flatten({ background: '#ffffff' });
    const { data: raw, info } = await pipeline
        .toColourspace(grey ? 'b-w' : 'srgb')   // 1 or 3 channels (also from CMYK)
        .resize({ width: page.width, height: page.height, fit: 'inside', kernel: 'lanczos3' })
        .raw()
        .toBuffer({ resolveWithObject: true });
    let out = sharp(fillPage(raw, info, page), { raw: { width: page.width, height: page.height, channels: info.channels } });
    if (grey) out = out.toColourspace('b-w');   // else sharp writes a 1-channel picture as RGB
    if (png) return { ext: 'png', data: await out.png({ compressionLevel: 9 }).toBuffer() };
    return { ext: 'jpg', data: withJfif(await out.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer()) };
}

// The smallest page of the screen's shape around a width x height picture.
function pageShape(width, height) {
    return width * SCREEN.height >= height * SCREEN.width
        ? { width, height: Math.round(width * SCREEN.height / SCREEN.width) }
        : { width: Math.round(height * SCREEN.width / SCREEN.height), height };
}

// JFIF APP0 segment: version 1.1, no units, 1:1 pixels, no thumbnail.
const JFIF = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
const hasJfif = (jpg) => jpg.length > 11 && jpg[2] === 0xff && jpg[3] === 0xe0 && jpg.toString('latin1', 6, 11) === 'JFIF\0';
export const withJfif = (jpg) => hasJfif(jpg) ? jpg : Buffer.concat([jpg.subarray(0, 2), JFIF, jpg.subarray(2)]);

// The raw picture centred on a raw canvas of `page` size, each gap black or white to
// match the picture's edge beside it.
function fillPage(raw, { width, height, channels }, page) {
    const row = page.width * channels;
    const left = Math.floor((page.width - width) / 2), top = Math.floor((page.height - height) / 2);
    const shade = (side) => edgeBrightness(raw, width, height, channels, side) < 128 ? 0 : 255;
    const out = Buffer.alloc(row * page.height);
    out.fill(shade('top'), 0, top * row);
    out.fill(shade('bottom'), (top + height) * row);
    const l = shade('left'), r = shade('right');
    for (let y = 0; y < height; y++) {
        const o = (top + y) * row;
        out.fill(l, o, o + left * channels);
        raw.copy(out, o + left * channels, y * width * channels, (y + 1) * width * channels);
        out.fill(r, o + (left + width) * channels, o + row);
    }
    return out;
}

// Mean brightness (0-255) of the 8-pixel strip along one side of a raw picture
// (1 channel: grey; 3: RGB).
function edgeBrightness(raw, width, height, channels, side) {
    const strip = 8, across = side === 'left' || side === 'right';
    let sum = 0, count = 0;
    for (let a = 0; a < (across ? height : width); a += 2) {
        for (let k = 0; k < Math.min(strip, across ? width : height); k++) {
            const x = across ? (side === 'left' ? k : width - 1 - k) : a;
            const y = across ? a : (side === 'top' ? k : height - 1 - k);
            const i = (y * width + x) * channels;
            sum += channels >= 3 ? (raw[i] + raw[i + 1] + raw[i + 2]) / 3 : raw[i];
            count++;
        }
    }
    return count ? sum / count : 255;
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

async function makeBook(job, dir) {
    // Fetch every page first (kept in dir): the book's page size depends on all of them.
    const originals = [];
    for (let n = 0; n < job.sources.length; n++) {
        try {
            const file = path.join(dir, 'page' + n);
            fs.writeFileSync(file, (await fetchPage(job.sources[n])).body);
            originals.push(file);
        } catch { /* a page that can't be fetched is left out */ }
    }
    if (!originals.length) throw userError('None of the pages could be fetched. Try again in a moment.', 502);
    job.missing = job.sources.length - originals.length;
    const page = await bookPageSize(originals);
    const cbz = path.join(dir, 'chapter.cbz');
    const zip = new ZipWriter(fs.createWriteStream(cbz));
    for (let n = 0; n < originals.length; n++) {
        try {
            const img = await comicImage({ body: fs.readFileSync(originals[n]) }, page);
            await zip.add(String(n + 1).padStart(4, '0') + '.' + img.ext, img.data);
        } catch { job.missing++; }   // a picture sharp can't read
        fs.rmSync(originals[n], { force: true });
    }
    await zip.finish();
    job.step = 'convert';
    let res;
    try {
        res = await browserService('/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(safeName(job.title) + '.cbz') },
            body: Readable.toWeb(fs.createReadStream(cbz)), duplex: 'half', signal: AbortSignal.timeout(600000)
        });
    } catch { throw userError('The converter could not be reached. Try again in a moment.', 502); }
    if (!res.ok) throw userError(await serviceMessage(res, 'The chapter could not be made into a Kindle book.'), 502);
    const file = await saveBody(res, path.join(dir, 'chapter.azw3'));
    fs.rmSync(cbz, { force: true });
    fs.writeFileSync(file, setExth(fs.readFileSync(file), fixedLayoutRecords(page)));
    return { file, name: safeName(job.title) + '.azw3' };
}

export function startJob(body) {
    if (!browserServiceConfigured()) throw userError('Kindle book downloads need the converter service (ZLIBRARY_BROWSER_ENDPOINT).', 503, 'manga/unavailable');
    const pages = Array.isArray(body && body.pages) ? body.pages : [];
    if (!pages.length) throw userError('No pages to download.');
    if (pages.length > MAX_PAGES) throw userError(`A chapter can have at most ${MAX_PAGES} pages.`);
    const sources = pages.map(pageSource);
    if (sources.some((src) => !src)) throw userError('Unknown page address.');
    const title = String((body && body.title) || 'Manga').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Manga';
    const running = jobs.working().find((job) => job.title === title);   // tapped twice
    if (running) return { id: running.id };
    return { id: jobs.start({ title, sources, step: 'pages' }, makeBook, 'Making the book failed. Try again in a moment.').id };
}

export function jobStatus(id) {
    const job = jobs.get(id);
    if (!job) throw userError('This download is no longer available. Tap AZW3 again.', 404, 'not-found');
    if (job.status === 'failed') return { status: 'failed', message: job.message };
    if (job.status === 'working') return { status: 'working', step: job.step };
    return { status: 'ready', name: job.name, size: job.size, missing: job.missing, href: `/__rk/manga/azw3/${job.id}/file` };
}

export function sendFile(res, id) {
    const job = jobs.get(id);
    if (!isReady(job)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This download is no longer available. Tap AZW3 again.');
        return;
    }
    sendJobFile(res, job, 'application/vnd.amazon.ebook');
}
