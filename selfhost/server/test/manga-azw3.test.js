// deno test -A --unstable-detect-cjs --no-check test/manga-azw3.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { comicImage, bookPageSize, ZipWriter, crc32, SCREEN, withJfif } from '../src/manga-azw3.js';

const picture = (w, h) => sharp({ create: { width: w || 40, height: h || 30, channels: 3, background: { r: 200, g: 10, b: 10 } } });

const pixel = async (jpg, x, y) => {
    const { data, info } = await sharp(jpg).raw().toBuffer({ resolveWithObject: true });
    return data[(y * info.width + x) * info.channels];
};

const size = async (data) => { const m = await sharp(data).metadata(); return [m.width, m.height]; };
const solid = (w, h, v) => sharp({ create: { width: w, height: h, channels: 3, background: { r: v, g: v, b: v } } });
const PAGE = { width: 900, height: 1200 };

test('the book\'s page size is the chapter\'s most common page, in the screen\'s 3:4 shape', async () => {
    const page = async (w, h) => picture(w, h).png().toBuffer();
    const chapter = [await page(650, 924), await page(650, 924), await page(1600, 1115), await page(650, 924)];
    assert.deepEqual(await bookPageSize(chapter), { width: 693, height: 924 });
    assert.deepEqual(await bookPageSize([await page(4000, 4000)]), SCREEN);   // larger than the screen: shrinks
    assert.deepEqual(await bookPageSize([Buffer.from('not a picture'), await page(900, 1200)]), PAGE);
    assert.deepEqual(await bookPageSize([]), SCREEN);
});

test('a PNG or JPEG page already the book\'s page size goes in as it is', async () => {
    const png = await picture(900, 1200).png().toBuffer();
    assert.deepEqual(await comicImage({ body: png }, PAGE), { ext: 'png', data: png });
    const jpg = withJfif(await picture(900, 1200).jpeg().toBuffer());
    assert.deepEqual(await comicImage({ body: jpg }, PAGE), { ext: 'jpg', data: jpg });
    const noJfif = await picture(900, 1200).jpeg().toBuffer();   // only the JFIF header is added
    assert.deepEqual((await comicImage({ body: noJfif }, PAGE)).data.subarray(20), noJfif.subarray(2));
});

test('other pages are fitted into the page size, PNG losslessly, colour and grey as in the original', async () => {
    const tall = await comicImage({ body: await picture(850, 1200).png().toBuffer() }, PAGE);
    assert.equal(tall.ext, 'png');
    assert.deepEqual(await size(tall.data), [900, 1200]);
    const { data } = await sharp(tall.data).raw().toBuffer({ resolveWithObject: true });
    const mid = ((600 * 900) + 450) * 3;
    assert.deepEqual([...data.subarray(mid, mid + 3)], [200, 10, 10]);   // exact colour
    assert.deepEqual(await size((await comicImage({ body: await picture(1800, 2400).png().toBuffer() }, PAGE)).data), [900, 1200]);
    assert.deepEqual(await size((await comicImage({ body: await picture(1600, 1115).png().toBuffer() }, PAGE)).data), [900, 1200]);
    const grey = await comicImage({ body: await solid(850, 1200, 90).toColourspace('b-w').png().toBuffer() }, PAGE);
    assert.equal((await sharp(grey.data).metadata()).channels, 1);
    const webp = await comicImage({ body: await picture(650, 924).webp().toBuffer() }, { width: 693, height: 924 });
    assert.equal(webp.ext, 'jpg');
    assert.equal(webp.data.toString('latin1', 6, 11), 'JFIF\0');
    assert.equal(withJfif(webp.data), webp.data);   // added once
});

test('the gap is black beside a dark page and white beside a light one', async () => {
    const dark = await comicImage({ body: await solid(850, 1200, 20).png().toBuffer() }, PAGE);
    assert.ok(await pixel(dark.data, 5, 600) < 15);
    const light = await comicImage({ body: await solid(850, 1200, 235).png().toBuffer() }, PAGE);
    assert.ok(await pixel(light.data, 5, 600) > 245);
    const half = await sharp({ create: { width: 850, height: 1200, channels: 3, background: '#ffffff' } })
        .composite([{ input: { create: { width: 425, height: 1200, channels: 3, background: '#111111' } }, left: 0, top: 0 }]).png().toBuffer();
    const split = await comicImage({ body: half }, PAGE);   // dark left edge, white right edge
    assert.ok(await pixel(split.data, 5, 600) < 15);
    assert.ok(await pixel(split.data, 895, 600) > 245);
    const greyJpeg = await solid(850, 1200, 20).toColourspace('b-w').jpeg().toBuffer();   // one channel
    assert.ok(await pixel((await comicImage({ body: greyJpeg }, PAGE)).data, 5, 600) < 15);
    const wideDark = await comicImage({ body: await solid(1200, 600, 10).png().toBuffer() }, PAGE);
    assert.ok(await pixel(wideDark.data, 450, 5) < 15);   // gap above a wide page
});

test('crc32 matches the standard value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the comic archive is a valid ZIP with stored entries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-zip-test-'));
    const file = path.join(dir, 'a.cbz');
    const entries = [['0001.jpg', Buffer.from('first page')], ['0002.png', Buffer.alloc(5000, 7)]];
    const zip = new ZipWriter(fs.createWriteStream(file));
    for (const [name, data] of entries) await zip.add(name, data);
    await zip.finish();
    const buf = fs.readFileSync(file);
    const end = buf.length - 22;
    assert.equal(buf.readUInt32LE(end), 0x06054b50);
    assert.equal(buf.readUInt16LE(end + 10), entries.length);
    let at = buf.readUInt32LE(end + 16);
    for (const [name, data] of entries) {
        assert.equal(buf.readUInt32LE(at), 0x02014b50);
        const size = buf.readUInt32LE(at + 20), nameLen = buf.readUInt16LE(at + 28), local = buf.readUInt32LE(at + 42);
        assert.equal(buf.toString('utf8', at + 46, at + 46 + nameLen), name);
        assert.equal(buf.readUInt32LE(local), 0x04034b50);
        const start = local + 30 + buf.readUInt16LE(local + 26);
        const stored = buf.subarray(start, start + size);
        assert.deepEqual(stored, data);
        assert.equal(buf.readUInt32LE(at + 16), crc32(data));
        at += 46 + nameLen;
    }
    fs.rmSync(dir, { recursive: true, force: true });
});
