// Pictures for e-readers: fetch an image, scale it down to IMAGE_MAX_WIDTH and
// re-encode it as JPEG (first frame of animations; e-ink can't animate). Used by
// /api/reddit and by /__rk/img?url=..., which the Hacker News app uses for article
// and comment images (a 9.6 MB animated WebP on a GitHub page would not load on
// a Kindle otherwise).

import sharp from 'sharp';
import { withPublicNetworkOnly } from './netguard.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// E-reader screens are ~1072-1448 px wide. REDDIT_IMAGE_MAX_WIDTH is the old name.
const IMAGE_MAX_WIDTH = Math.max(320, parseInt(process.env.IMAGE_MAX_WIDTH || process.env.REDDIT_IMAGE_MAX_WIDTH || '1080', 10) || 1080);
const IMAGE_MAX_BYTES = 40 * 1024 * 1024;
const IMAGE_CACHE_MAX = 64 * 1024 * 1024;

function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

// Keeps the original when it is already smaller (and always for SVG, which the
// Kindle browser draws itself).
async function shrinkImage(buf, type) {
    if (type === 'image/svg+xml') return { body: buf, type };
    try {
        const out = await sharp(buf, { failOn: 'none', pages: 1, limitInputPixels: 2e8 })
            .rotate()
            .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 72, mozjpeg: true })
            .toBuffer();
        return out.length < buf.length ? { body: out, type: 'image/jpeg' } : { body: buf, type };
    } catch {
        return { body: buf, type };
    }
}

// Tries each source in turn (best first). Only image responses count: some image
// hosts answer a missing file with a 404 placeholder picture.
async function fetchImage(sources) {
    let status = 404;
    for (const src of sources) {
        let res;
        try {
            res = await fetch(src, {
                headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
                signal: AbortSignal.timeout(30000)
            });
        } catch (e) {
            status = e.status || 502;
            continue;
        }
        const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!res.ok || !type.startsWith('image/') || Number(res.headers.get('content-length')) > IMAGE_MAX_BYTES) {
            if (res.body) res.body.cancel().catch(() => { });
            status = res.status === 429 ? 429 : (res.ok ? 415 : res.status);
            continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > IMAGE_MAX_BYTES) throw httpError(413, 'Image too large');
        return shrinkImage(buf, type);
    }
    throw httpError(status === 404 || status === 403 || status === 410 ? 404 : status, `Image not available (HTTP ${status})`);
}

const imageCache = new Map(); // key -> { body, type }
let imageCacheBytes = 0;

// A Response with the shrunk image, cached under `key`.
export async function serveImage(key, sources) {
    let hit = imageCache.get(key);
    if (hit) {
        imageCache.delete(key);
        imageCache.set(key, hit);
    } else {
        hit = await fetchImage(sources);
        imageCache.set(key, hit);
        imageCacheBytes += hit.body.length;
        for (const [k, v] of imageCache) {
            if (imageCacheBytes <= IMAGE_CACHE_MAX) break;
            imageCacheBytes -= v.body.length;
            imageCache.delete(k);
        }
    }
    return new Response(hit.body, {
        status: 200,
        headers: { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }
    });
}

// GET /__rk/img?url=https://...  (public addresses only)
export async function handleImage(req, res, url) {
    let target;
    try { target = new URL(url.searchParams.get('url') || ''); } catch { target = null; }
    if (!target || (target.protocol !== 'https:' && target.protocol !== 'http:')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid url');
        return;
    }
    let response;
    try {
        response = await withPublicNetworkOnly(() => serveImage(target.href, [target.href]));
    } catch (e) {
        res.writeHead(e.status || 502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(e.message);
        return;
    }
    const body = Buffer.from(await response.arrayBuffer());
    const headers = {};
    response.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
}
