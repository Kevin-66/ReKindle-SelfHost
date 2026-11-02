/*
 * Pro custom-claim regression test.
 *
 * Run: node scripts/test-claims.js
 *
 * Identity Toolkit replaces the entire customAttributes object. Buying or
 * cancelling Pro must never delete ageVerified/moderator or any other claim.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
    const { mergeClaims } = await import('../workers/rekindle-stripe/claims.js');

    assert.deepStrictEqual(
        mergeClaims({ ageVerified: true, moderator: true }, { pro: true }),
        { ageVerified: true, moderator: true, pro: true }
    );

    assert.deepStrictEqual(
        mergeClaims({ ageVerified: true, pro: true }, { pro: false }),
        { ageVerified: true, pro: false }
    );

    assert.deepStrictEqual(mergeClaims(null, { pro: true }), { pro: true });
    assert.deepStrictEqual(mergeClaims({ a: 1 }, null), { a: 1 });
    assert.deepStrictEqual(mergeClaims({ a: 1, b: 2 }, { b: null }), { a: 1 });

    // The Stripe worker must merge before writing; a raw {pro} write would
    // regress the bug this test exists for.
    const worker = fs.readFileSync(path.join(__dirname, '..', 'workers', 'rekindle-stripe', 'worker.js'), 'utf8');
    assert.ok(worker.includes("mergeClaims(existing, claims)"), 'Stripe worker must merge custom claims');
    assert.ok(!/customAttributes:\s*JSON\.stringify\(claims\)/.test(worker), 'Stripe worker must not write bare claims');

    // Functions-side social claim writes must merge too.
    const fn = fs.readFileSync(path.join(__dirname, '..', 'firebase-functions', 'index.js'), 'utf8');
    assert.ok(fn.includes('existingSocialClaims'), 'verifyAgeSelfDeclaration must preserve existing social claims');

    console.log('PASS - custom claim merge');
})().catch(err => {
    console.error('FAIL - custom claim merge:', err);
    process.exit(1);
});
