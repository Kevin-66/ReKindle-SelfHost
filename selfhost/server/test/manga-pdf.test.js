// deno test -A --unstable-detect-cjs --no-check test/manga-pdf.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pdfImage } from '../src/manga-pdf.js';

const picture = (channels) => sharp({ create: { width: 40, height: 30, channels, background: channels === 4 ? { r: 200, g: 10, b: 10, alpha: 0.5 } : { r: 200, g: 10, b: 10 } } });

test('JPEG pages go in unchanged', async () => {
    const body = await picture(3).jpeg().toBuffer();
    const out = await pdfImage({ body, type: 'image/jpeg' });
    assert.equal(out.filter, 'DCTDecode');
    assert.equal(out.colorSpace, '/DeviceRGB');
    assert.equal(out.data, body);
    assert.deepEqual([out.width, out.height], [40, 30]);
});

test('plain RGB and palette PNG data go in unchanged, with the PNG predictor', async () => {
    const rgb = await picture(3).png().toBuffer();
    const a = await pdfImage({ body: rgb, type: 'image/png' });
    assert.equal(a.filter, 'FlateDecode');
    assert.match(a.decodeParms, /\/Predictor 15 \/Colors 3 \/BitsPerComponent 8 \/Columns 40/);
    const pal = await picture(3).png({ palette: true }).toBuffer();
    const b = await pdfImage({ body: pal, type: 'image/png' });
    assert.match(b.colorSpace, /^\[\/Indexed \/DeviceRGB \d+ <[0-9a-f]+>\]$/);
});

test('PNG with transparency is re-saved without it; WebP becomes JPEG', async () => {
    const rgba = await picture(4).png().toBuffer();
    const a = await pdfImage({ body: rgba, type: 'image/png' });
    assert.equal(a.filter, 'FlateDecode');
    assert.equal(a.colorSpace, '/DeviceRGB');
    const webp = await picture(3).webp().toBuffer();
    const b = await pdfImage({ body: webp, type: 'image/webp' });
    assert.equal(b.filter, 'DCTDecode');
    assert.deepEqual([b.width, b.height], [40, 30]);
});
