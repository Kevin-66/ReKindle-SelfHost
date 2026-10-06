// deno test -A --unstable-detect-cjs --no-check test/azw3-fixed-layout.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setExth, readExth, fixedLayoutRecords } from '../src/azw3-fixed-layout.js';

// A small KF8 book: PDB header, record 0 (PalmDOC header, MOBI header, EXTH, full name) and
// two more records.
function book(name, exth, others) {
    const mobiHeaderLength = 232;
    const entries = exth.map(([code, value]) => {
        const b = Buffer.alloc(8 + value.length);
        b.writeUInt32BE(code, 0); b.writeUInt32BE(8 + value.length, 4); Buffer.from(value).copy(b, 8);
        return b;
    });
    const body = Buffer.concat(entries);
    const exthBlock = Buffer.concat([Buffer.from('EXTH'), Buffer.alloc(8), body, Buffer.alloc((4 - ((12 + body.length) % 4)) % 4)]);
    exthBlock.writeUInt32BE(12 + body.length, 4); exthBlock.writeUInt32BE(exth.length, 8);
    const head = Buffer.alloc(16 + mobiHeaderLength);
    head.write('MOBI', 16, 'latin1');
    head.writeUInt32BE(mobiHeaderLength, 20);
    head.writeUInt32BE(0x50, 16 + 0x70);
    const nameBytes = Buffer.from(name);
    head.writeUInt32BE(head.length + exthBlock.length, 84);
    head.writeUInt32BE(nameBytes.length, 88);
    const r0 = Buffer.concat([head, exthBlock, nameBytes, Buffer.alloc(6)]);
    const records = [r0, ...others];
    const pdb = Buffer.alloc(78 + 8 * records.length + 2);
    pdb.write('BOOKMOBI', 60, 'latin1');
    pdb.writeUInt16BE(records.length, 76);
    let at = pdb.length;
    records.forEach((r, i) => { pdb.writeUInt32BE(at, 78 + 8 * i); pdb.writeUInt32BE(i * 2, 82 + 8 * i); at += r.length; });
    return Buffer.concat([pdb, ...records]);
}

function records(buf) {
    const n = buf.readUInt16BE(76);
    const offs = [];
    for (let i = 0; i < n; i++) offs.push(buf.readUInt32BE(78 + 8 * i));
    offs.push(buf.length);
    return offs.slice(0, n).map((o, i) => buf.subarray(o, offs[i + 1]));
}

test('adds the fixed-layout records and keeps everything else', () => {
    const others = [Buffer.from('text record'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])];
    const before = book('Chapter 1', [[100, 'Author'], [126, '600x800'], [524, 'en']], others);
    const after = setExth(before, fixedLayoutRecords({ width: 1860, height: 2480 }));

    const exth = new Map(readExth(after).map(([code, value]) => [code, value.toString()]));
    assert.equal(exth.get(122), 'true');
    assert.equal(exth.get(123), 'comic');
    assert.equal(exth.get(126), '1860x2480');   // replaced, not added twice
    assert.equal(readExth(after).filter(([code]) => code === 126).length, 1);
    assert.equal(exth.get(100), 'Author');
    assert.equal(exth.get(524), 'en');

    const [r0, ...rest] = records(after);
    assert.equal(r0.length % 4, 0);
    const nameAt = r0.readUInt32BE(84);
    assert.equal(r0.toString('utf8', nameAt, nameAt + r0.readUInt32BE(88)), 'Chapter 1');
    assert.deepEqual(rest, others);
    assert.equal(after.readUInt32BE(82 + 8), before.readUInt32BE(82 + 8));   // record attributes kept
});

test('refuses files that are not Kindle books', () => {
    assert.throws(() => setExth(Buffer.alloc(100), []), /Not a Kindle book/);
});
