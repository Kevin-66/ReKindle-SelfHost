/**
 * Unit tests for the daily social-content retention helpers.
 *
 * Run: node scripts/test-cleanup.js
 *
 * Pure logic only: no Firebase credentials, no network. The I/O layer
 * (firebase-functions/social-cleanup.js) is cross-checked for loadability and
 * documented defaults, then exercised in production via SOCIAL_CLEANUP_DRY_RUN.
 */
const assert = require('assert');

const {
    DAY_MS,
    TRANSLATION_LANGS,
    isSafeRtdbKey,
    isQuotaError,
    cutoffMs,
    pushIdTimestamp,
    chunk,
    mapWithConcurrency,
    buildChatDeletePaths,
    shouldDeleteReport,
    toMillis
} = require('../firebase-functions/cleanup-lib');

const { CLEANUP_CONFIG, runSocialCleanup } = require('../firebase-functions/social-cleanup');

(async () => {
    /* ---------------------------------------------------------------- */
    /* 1. Retention arithmetic                                          */
    /* ---------------------------------------------------------------- */
    const now = Date.UTC(2026, 9, 21, 12, 0, 0); // 2026-10-21T12:00:00Z
    assert.strictEqual(cutoffMs(now, 30), now - 30 * DAY_MS);
    assert.strictEqual(cutoffMs(now, 90), now - 90 * DAY_MS);
    assert.strictEqual(cutoffMs(now, 365), now - 365 * DAY_MS);

    assert.throws(() => cutoffMs(NaN, 30), /finite/);
    assert.throws(() => cutoffMs(now, 0), /positive integer/);
    assert.throws(() => cutoffMs(now, 1.5), /positive integer/);

    /* ---------------------------------------------------------------- */
    /* 2. Push-ID timestamps                                            */
    /* ---------------------------------------------------------------- */
    // Real KindleChat message: its `timestamp` field is exactly this value.
    assert.strictEqual(pushIdTimestamp('-OtUAWqyOL4lSCy3ro-e'), 1779713318334);
    assert.strictEqual(pushIdTimestamp('-P3nBCeCwUrF-nkp3m-P'), 1791860202125);
    assert.ok(pushIdTimestamp('-OtUAWqyOL4lSCy3ro-e') < pushIdTimestamp('-P3nBCeCwUrF-nkp3m-P'));
    assert.strictEqual(pushIdTimestamp(''), 0);
    assert.strictEqual(pushIdTimestamp('bad/key'), 0);
    assert.strictEqual(pushIdTimestamp('short'), 0);

    /* ---------------------------------------------------------------- */
    /* 2. RTDB key/path safety                                          */
    /* ---------------------------------------------------------------- */
    assert.ok(isSafeRtdbKey('-Nabc_123'));
    assert.ok(isSafeRtdbKey('abcXYZ'));
    assert.ok(!isSafeRtdbKey('abc/def'));
    assert.ok(!isSafeRtdbKey('..'));
    assert.ok(!isSafeRtdbKey('.'));
    assert.ok(!isSafeRtdbKey(''));
    assert.ok(!isSafeRtdbKey(null));

    assert.strictEqual(isQuotaError({ code: 8 }), true);
    assert.strictEqual(isQuotaError({ code: 'resource-exhausted' }), true);
    assert.strictEqual(isQuotaError({ message: '8 RESOURCE_EXHAUSTED: Quota exceeded.' }), true);
    assert.strictEqual(isQuotaError(new Error('Quota exceeded for quota metric')), true);
    assert.strictEqual(isQuotaError(new Error('permission denied')), false);
    assert.strictEqual(isQuotaError(null), false);

    const paths = buildChatDeletePaths(['-Nabc_123', 'bad/id'], ['en', 'es']);
    assert.deepStrictEqual(Object.keys(paths).sort(), [
        'kindlechat/art_index/-Nabc_123',
        'kindlechat/messages/-Nabc_123',
        'kindlechat/translations_by_lang/en/-Nabc_123',
        'kindlechat/translations_by_lang/es/-Nabc_123'
    ].sort());
    assert.ok(Object.values(paths).every((value) => value === null), 'all paths must delete');
    assert.strictEqual(Object.keys(paths).length, 4, 'invalid id must be skipped');

    const noLangPaths = buildChatDeletePaths(['-Nabc_123'], []);
    assert.deepStrictEqual(Object.keys(noLangPaths).sort(), [
        'kindlechat/art_index/-Nabc_123',
        'kindlechat/messages/-Nabc_123'
    ].sort());

    const badLangPaths = buildChatDeletePaths(['-Nabc_123'], ['en/../x']);
    assert.strictEqual(Object.keys(badLangPaths).length, 2, 'unsafe language key must be skipped');

    /* ---------------------------------------------------------------- */
    /* 3. Report retention                                              */
    /* ---------------------------------------------------------------- */
    const old = now - 91 * DAY_MS;
    const recent = now - 89 * DAY_MS;

    assert.strictEqual(shouldDeleteReport({ status: 'resolved', createdAt: old }, now, 90), true);
    assert.strictEqual(shouldDeleteReport({ status: 'dismissed', createdAt: old }, now, 90), true);
    assert.strictEqual(shouldDeleteReport({ status: 'resolved', createdAt: recent }, now, 90), false);
    assert.strictEqual(shouldDeleteReport({ status: 'pending', createdAt: old }, now, 90), false);
    assert.strictEqual(shouldDeleteReport({ createdAt: old }, now, 90), false);
    assert.strictEqual(shouldDeleteReport({ status: 'resolved' }, now, 90), false);
    assert.strictEqual(shouldDeleteReport({ status: 'resolved', createdAt: 'not-a-number' }, now, 90), false);
    assert.strictEqual(shouldDeleteReport(null, now, 90), false);

    /* ---------------------------------------------------------------- */
    /* 4. Timestamp coercion                                            */
    /* ---------------------------------------------------------------- */
    assert.strictEqual(toMillis(1234), 1234);
    assert.strictEqual(toMillis(new Date(5678)), 5678);
    assert.strictEqual(toMillis({ toMillis: () => 9012 }), 9012);
    assert.strictEqual(toMillis(undefined), 0);
    assert.strictEqual(toMillis('1234'), 0);
    assert.strictEqual(toMillis(NaN), 0);

    /* ---------------------------------------------------------------- */
    /* 5. Chunking and concurrency                                      */
    /* ---------------------------------------------------------------- */
    assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepStrictEqual(chunk([], 10), []);
    assert.deepStrictEqual(chunk([1, 2], 0), [[1], [2]], 'zero width clamps to 1');

    let active = 0;
    let peak = 0;
    const visited = [];
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        visited.push(value);
        active--;
        return value * 2;
    });

    assert.deepStrictEqual(results, [2, 4, 6, 8, 10], 'results must keep input order');
    assert.strictEqual(visited.length, 5);
    assert.ok(peak <= 2, `concurrency must stay <= 2 (peak ${peak})`);

    /* ---------------------------------------------------------------- */
    /* 6. Documented defaults / module loadability                     */
    /* ---------------------------------------------------------------- */
    assert.strictEqual(CLEANUP_CONFIG.chatRetentionDays, 30);
    assert.strictEqual(CLEANUP_CONFIG.keepLatestChatMessages, 50);
    assert.strictEqual(CLEANUP_CONFIG.topicRetentionDays, 90);
    assert.strictEqual(CLEANUP_CONFIG.neighbourhoodRetentionDays, 90);
    assert.strictEqual(CLEANUP_CONFIG.reportRetentionDays, 90);
    assert.strictEqual(CLEANUP_CONFIG.automodRetentionDays, 30);
    assert.strictEqual(CLEANUP_CONFIG.modActionsRetentionDays, 365);
    assert.strictEqual(CLEANUP_CONFIG.maxTopicsPerRun, 500);
    assert.strictEqual(CLEANUP_CONFIG.maxCommentDeletesPerRun, 4000);
    assert.strictEqual(CLEANUP_CONFIG.maxPostDeletesPerRun, 100);
    assert.strictEqual(TRANSLATION_LANGS.length, 10);
    assert.deepStrictEqual(TRANSLATION_LANGS, ['en', 'es', 'pt', 'pl', 'de', 'it', 'fr', 'ru', 'zh', 'vi']);
    assert.strictEqual(typeof runSocialCleanup, 'function');

    await assert.rejects(() => runSocialCleanup({}), /socialApp is required/);
    await assert.rejects(
        () => runSocialCleanup({ socialApp: {}, config: { chatRetentionDays: 0 } }),
        /chatRetentionDays/
    );

    console.log('cleanup tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
