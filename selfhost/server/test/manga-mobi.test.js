// deno test -A --unstable-detect-cjs --no-check test/manga-mobi.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { comicImage, ZipWriter, crc32, SCREEN } from '../src/manga-mobi.js';

const picture = (w, h) => sharp({ create: { width: w || 40, height: h || 30, channels: 3, background: { r: 200, g: 10, b: 10 } } });

test('pages are sized to fill the Kindle screen, aspect kept', async () => {
    const small = await comicImage({ body: await picture(850, 1200).png().toBuffer() });
    const m = await sharp(small.data).metadata();
    assert.equal(small.ext, 'jpg');
    assert.equal(m.height, SCREEN.height);
    assert.ok(Math.abs(m.width - Math.round(850 * SCREEN.height / 1200)) <= 1);
    const wide = await sharp((await comicImage({ body: await picture(2400, 1200).webp().toBuffer() })).data).metadata();
    assert.equal(wide.width, SCREEN.width);
});

test('a JPEG page that already fits goes in unchanged; PNG always becomes JPEG', async () => {
    const jpg = await picture(1240, SCREEN.height).jpeg().toBuffer();   // height fits exactly
    assert.deepEqual(await comicImage({ body: jpg }), { ext: 'jpg', data: jpg });
    const png = await comicImage({ body: await picture(1240, SCREEN.height).png().toBuffer() });
    assert.equal(png.ext, 'jpg');
    assert.equal(png.data[0], 0xff);
    assert.equal((await sharp(png.data).metadata()).height, SCREEN.height);
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
