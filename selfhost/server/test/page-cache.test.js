// deno test -A --unstable-detect-cjs --no-check test/page-cache.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPageCache, stableKey } from '../src/page-cache.js';

const page = (n, size = 1000) => ({ body: Buffer.alloc(size, n), type: 'image/png' });

test('MangaDex pages are the same page whichever MangaDex@Home node served them', () => {
    const a = stableKey('https://abc.mangadex.network/tokenA/data/0123456789abcdef0123/1-x.png');
    const b = stableKey('https://other.mangadex.network/tokenB/data/0123456789abcdef0123/1-x.png');
    const c = stableKey('https://uploads.mangadex.org/data/0123456789abcdef0123/1-x.png');
    assert.equal(a, b);
    assert.equal(a, c);
    assert.notEqual(a, stableKey('https://abc.mangadex.network/t/data-saver/0123456789abcdef0123/1-x.png'));
    assert.equal(stableKey('mhg:aHR0cHM:sig1'), stableKey('mhg:aHR0cHM:sig2'));   // Manhuagui: the address, not the signature
});

test('pages are saved, read back with their type, and survive a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-pages-'));
    const cache = createPageCache(dir, 1024 * 1024);
    assert.equal(await cache.read('https://n/t/data/0123456789abcdef0123/1.png'), null);
    await cache.write('https://n/t/data/0123456789abcdef0123/1.png', page(1));
    const hit = await cache.read('https://other/t2/data/0123456789abcdef0123/1.png');
    assert.equal(hit.type, 'image/png');
    assert.deepEqual(hit.body, page(1).body);
    const again = createPageCache(dir, 1024 * 1024);   // a new server process
    assert.ok(await again.read('https://n/t/data/0123456789abcdef0123/1.png'));
    assert.equal(again.stats().pages, 1);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('over the limit, the least recently read pages go first', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-pages-'));
    const cache = createPageCache(dir, 10000);   // room for 10 pages of 1000 bytes
    for (let n = 0; n < 10; n++) { await cache.write('mhg:p' + n + ':s', page(n)); await new Promise((r) => setTimeout(r, 2)); }
    await cache.read('mhg:p0:s');   // page 0 read again: it stays
    await new Promise((r) => setTimeout(r, 2));
    await cache.write('mhg:p10:s', page(10));
    const s = cache.stats();
    assert.ok(s.bytes <= 10000 * 0.9, 'trimmed to 90%');
    assert.ok(await cache.read('mhg:p0:s'), 'recently read page kept');
    assert.equal(await cache.read('mhg:p1:s'), null, 'oldest unread page dropped');
    assert.ok(await cache.read('mhg:p10:s'), 'new page kept');
    fs.rmSync(dir, { recursive: true, force: true });
});
