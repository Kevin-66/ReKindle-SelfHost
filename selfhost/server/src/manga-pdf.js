// A Manga chapter as one PDF, which the Kindle opens natively (the PDF button in the
// Manga reader, selfhost/site/js/rk-manga-sources.js).
//
// The reader POSTs the chapter's page list ({title, pages}) to /__rk/manga/pdf and
// gets back a link, /__rk/manga/pdf/<id>; opening it downloads the PDF. Pages come
// through the same server cache as the reader's own pages (images.js serveImage), and
// the PDF is written page by page as they arrive, so the download starts at once and
// the connection never sits idle. Pictures stay the originals where PDF allows (owner's
// rule): JPEG pages and plain PNG data go in byte for byte (see pdfImage). A page that
// can't be fetched becomes a page saying so.

import crypto from 'node:crypto';
import sharp from 'sharp';
import { serveImage, mangadexOrigin } from './images.js';
import { withPublicNetworkOnly } from './netguard.js';
import * as manhuagui from './manhuagui.js';

const MAX_PAGES = 400;
const KEEP_MS = 30 * 60 * 1000;
const jobs = new Map();   // id -> { title, pages, created }

function bad(message, status = 400) {
    return Object.assign(new Error(message), { status, code: 'invalid-argument' });
}

setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) if (now - job.created > KEEP_MS) jobs.delete(id);
}, 60000).unref();

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

export function createPdf(body) {
    const pages = Array.isArray(body && body.pages) ? body.pages : [];
    if (!pages.length) throw bad('No pages to put in a PDF.');
    if (pages.length > MAX_PAGES) throw bad(`A chapter can have at most ${MAX_PAGES} pages.`);
    const sources = pages.map(pageSource);
    if (sources.some((src) => !src)) throw bad('Unknown page address.');
    const title = String((body && body.title) || 'Manga').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Manga';
    const id = crypto.randomBytes(12).toString('base64url');
    jobs.set(id, { title, sources, created: Date.now() });
    return { href: '/__rk/manga/pdf/' + id };
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

// Width, height and colour components of a JPEG, from its SOF marker.
function jpegInfo(buf) {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
        }
        i += 2 + len;
    }
    return null;
}

// A PNG's header and compressed image data, if PDF can take the data as it is: not
// interlaced, no alpha, and grey (1-8 bit), RGB (8 bit) or palette (1-8 bit).
function pngParts(buf) {
    if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let i = 8, ihdr = null, plte = null;
    const idat = [];
    while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i), kind = buf.toString('latin1', i + 4, i + 8);
        const data = buf.subarray(i + 8, i + 8 + len);
        if (kind === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], type: data[9], interlace: data[12] };
        else if (kind === 'PLTE') plte = data;
        else if (kind === 'IDAT') idat.push(data);
        else if (kind === 'IEND') break;
        i += 12 + len;
    }
    if (!ihdr || !idat.length || ihdr.interlace) return null;
    const { width, height, depth, type } = ihdr;
    let colorSpace, colors;
    if (type === 0 && [1, 2, 4, 8].includes(depth)) { colorSpace = '/DeviceGray'; colors = 1; }
    else if (type === 2 && depth === 8) { colorSpace = '/DeviceRGB'; colors = 3; }
    else if (type === 3 && [1, 2, 4, 8].includes(depth) && plte) { colorSpace = `[/Indexed /DeviceRGB ${plte.length / 3 - 1} <${plte.toString('hex')}>]`; colors = 1; }
    else return null;
    return {
        width, height, colorSpace, bits: depth, filter: 'FlateDecode',
        decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${width} >>`,
        data: Buffer.concat(idat)
    };
}

// { width, height, filter, colorSpace, bits, decodeParms?, data } for an image XObject.
// JPEG and suitable PNG data go in unchanged; other PNGs are re-saved as PNG (lossless,
// alpha flattened onto white), other formats (WebP, GIF, ...) as JPEG quality 90, since
// storing them losslessly would make the PDF several times larger.
export async function pdfImage(img) {
    const jpeg = (buf) => {
        const info = jpegInfo(buf);
        if (!info || !info.width || !info.height || (info.components !== 1 && info.components !== 3)) return null;
        return { width: info.width, height: info.height, filter: 'DCTDecode', colorSpace: info.components === 1 ? '/DeviceGray' : '/DeviceRGB', bits: 8, data: buf };
    };
    if (/jpe?g/i.test(img.type)) {
        const direct = jpeg(img.body);
        if (direct) return direct;
    }
    const base = () => sharp(img.body, { failOn: 'none', pages: 1, limitInputPixels: 2e8 }).rotate().flatten({ background: '#ffffff' });
    if (/png/i.test(img.type)) {
        const direct = pngParts(img.body);
        if (direct) return direct;
        const resaved = pngParts(await base().png({ compressionLevel: 9, palette: false }).toBuffer());
        if (resaved) return resaved;
    }
    const out = jpeg(await base().jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer());
    if (!out) throw new Error('Could not convert the page');
    return out;
}

// A PDF text string: plain ASCII as (..), anything else as UTF-16BE hex.
function pdfString(text) {
    if (/^[\x20-\x7e]*$/.test(text)) return '(' + text.replace(/[\\()]/g, '\\$&') + ')';
    const utf16 = Buffer.from('﻿' + text, 'utf16le');
    utf16.swap16();
    return '<' + utf16.toString('hex') + '>';
}

export async function sendPdf(res, id) {
    const job = jobs.get(String(id || ''));
    if (!job) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This PDF link has expired. Tap PDF again.');
        return;
    }
    const name = job.title.replace(/[\\/:*?"<>|]+/g, '-') + '.pdf';
    const ascii = name.replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store'
    });

    let offset = 0;
    const offsets = [];   // object number -> byte offset
    let closed = false;
    res.on('close', () => { closed = true; });
    const write = (chunk) => new Promise((resolve) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
        offset += buf.length;
        if (res.write(buf)) resolve(); else res.once('drain', resolve);
    });
    const object = async (num, dict, stream) => {
        offsets[num] = offset;
        if (stream) {
            await write(`${num} 0 obj\n${dict.replace('>>', `/Length ${stream.length} >>`)}\nstream\n`);
            await write(stream);
            await write('\nendstream\nendobj\n');
        } else {
            await write(`${num} 0 obj\n${dict}\nendobj\n`);
        }
    };

    // 1 = catalog, 2 = page tree, 3 = info, 4 = font for error pages; pages from 5.
    await write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    await object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    let next = 5;
    const kids = [];
    for (let n = 0; n < job.sources.length && !closed; n++) {
        let image = null;
        try { image = await pdfImage(await fetchPage(job.sources[n])); } catch { image = null; }
        const pageNum = next++;
        kids.push(pageNum);
        if (image) {
            const imageNum = next++, contentNum = next++;
            await object(imageNum, `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bits} /Filter /${image.filter}${image.decodeParms ? ' /DecodeParms ' + image.decodeParms : ''} >>`, image.data);
            await object(contentNum, '<< >>', Buffer.from(`q ${image.width} 0 0 ${image.height} 0 0 cm /Im0 Do Q`, 'latin1'));
            await object(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${image.width} ${image.height}] /Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
        } else {
            const contentNum = next++;
            await object(contentNum, '<< >>', Buffer.from(`BT /F1 24 Tf 60 420 Td (Page ${n + 1} could not be loaded.) Tj ET`, 'latin1'));
            await object(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 840] /Resources << /Font << /F1 4 0 R >> >> /Contents ${contentNum} 0 R >>`);
        }
    }
    if (closed) return;
    await object(2, `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
    await object(3, `<< /Title ${pdfString(job.title)} /Producer (ReKindle) >>`);
    await object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const xref = offset;
    let table = `xref\n0 ${next}\n0000000000 65535 f \n`;
    for (let num = 1; num < next; num++) table += `${String(offsets[num] || 0).padStart(10, '0')} 00000 n \n`;
    await write(`${table}trailer\n<< /Size ${next} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    res.end();
}
