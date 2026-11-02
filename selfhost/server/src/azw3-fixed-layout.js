// Marks a KF8 book (AZW3) from Calibre as a fixed-layout comic, the way Amazon's tools
// and Kindle Comic Converter do. A reflowable book's pictures sit inside the Kindle's
// page margins, under the title and above the reading-progress line, however wide the
// pictures are; a fixed-layout comic shows each page edge to edge. Calibre can't write
// these settings, so they are added to the finished file: EXTH records in record 0
// (codes as KindleUnpack's mobi_header.py names them).
//
// Record 0 is PalmDOC header (16 bytes), MOBI header, EXTH block, then the full name.
// Only record 0 changes size; every other record keeps its bytes and moves, so the
// PDB record list gets new offsets. Everything inside the book refers to records by
// number, not by file offset.

const EXTH_FLAG = 0x40;

export function fixedLayoutRecords({ width, height }) {
    return [
        [122, 'true'],                  // fixed-layout
        [123, 'comic'],                 // book-type
        [124, 'portrait'],              // orientation-lock
        [126, `${width}x${height}`],    // original-resolution
        [127, 'true'],                  // zero-gutter
        [128, 'true'],                  // zero-margin
        [132, 'false'],                 // region magnification (panel zoom) off
        [525, 'horizontal-lr'],         // primary-writing-mode
        [527, 'ltr']                    // page-progression-direction
    ];
}

// Reads the EXTH records of record 0 as [code, Buffer] pairs (for tests and checks).
export function readExth(book) {
    const { r0 } = parse(book);
    const exth = exthBlock(r0);
    return exth ? exth.records : [];
}

// Returns a new Buffer: `book` with `records` ([code, string]) replacing any EXTH
// records with the same codes.
export function setExth(book, records) {
    const { offsets, gap, r0, n } = parse(book);
    const exth = exthBlock(r0);
    if (!exth) throw new Error('This book has no EXTH block');
    const codes = new Set(records.map(([code]) => code));
    const all = exth.records.filter(([code]) => !codes.has(code))
        .concat(records.map(([code, value]) => [code, Buffer.from(value, 'utf8')]));

    const parts = all.map(([code, value]) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(code, 0);
        head.writeUInt32BE(value.length + 8, 4);
        return Buffer.concat([head, value]);
    });
    const body = Buffer.concat(parts);
    const exthHead = Buffer.alloc(12);
    exthHead.write('EXTH', 0, 'latin1');
    exthHead.writeUInt32BE(12 + body.length, 4);
    exthHead.writeUInt32BE(all.length, 8);
    const pad = Buffer.alloc((4 - ((12 + body.length) % 4)) % 4);
    const newExth = Buffer.concat([exthHead, body, pad]);

    const nameOffset = r0.readUInt32BE(84);
    const nameLength = r0.readUInt32BE(88);
    const name = r0.subarray(nameOffset, nameOffset + nameLength);
    const before = Buffer.from(r0.subarray(0, exth.start));
    const nameStart = before.length + newExth.length;
    before.writeUInt32BE(nameStart, 84);
    // The name ends with at least two zero bytes; the record stays a multiple of 4.
    const tailLength = Math.max(2, r0.length - (nameOffset + nameLength));
    let newR0 = Buffer.concat([before, newExth, name, Buffer.alloc(tailLength)]);
    if (newR0.length % 4) newR0 = Buffer.concat([newR0, Buffer.alloc(4 - (newR0.length % 4))]);

    const delta = newR0.length - (offsets[1] - offsets[0]);
    const head = Buffer.from(book.subarray(0, 78 + 8 * n));
    for (let i = 1; i < n; i++) head.writeUInt32BE(offsets[i] + delta, 78 + 8 * i);
    return Buffer.concat([head, gap, newR0, book.subarray(offsets[1])]);
}

function parse(book) {
    if (book.length < 78 || book.toString('latin1', 60, 68) !== 'BOOKMOBI') throw new Error('Not a Kindle book (MOBI/AZW3)');
    const n = book.readUInt16BE(76);
    if (n < 2) throw new Error('This MOBI has no records');
    const offsets = [];
    for (let i = 0; i < n; i++) offsets.push(book.readUInt32BE(78 + 8 * i));
    const gap = book.subarray(78 + 8 * n, offsets[0]);
    const r0 = book.subarray(offsets[0], offsets[1]);
    if (r0.toString('latin1', 16, 20) !== 'MOBI') throw new Error('Record 0 has no MOBI header');
    return { n, offsets, gap, r0 };
}

function exthBlock(r0) {
    const headerLength = r0.readUInt32BE(20);
    if (!(r0.readUInt32BE(16 + 0x70) & EXTH_FLAG)) return null;
    const start = 16 + headerLength;
    if (r0.toString('latin1', start, start + 4) !== 'EXTH') return null;
    const count = r0.readUInt32BE(start + 8);
    const records = [];
    let p = start + 12;
    for (let i = 0; i < count; i++) {
        const code = r0.readUInt32BE(p);
        const length = r0.readUInt32BE(p + 4);
        if (length < 8 || p + length > r0.length) throw new Error('Damaged EXTH block');
        records.push([code, Buffer.from(r0.subarray(p + 8, p + length))]);
        p += length;
    }
    return { start, records };
}
