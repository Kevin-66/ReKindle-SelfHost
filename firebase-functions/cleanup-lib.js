/**
 * Pure helpers for the daily social-content retention job (`cleanupSocial`).
 *
 * Deliberately free of firebase-admin / firebase-functions imports so
 * `scripts/test-cleanup.js` can exercise the cutoffs and multi-path builder
 * without credentials. The I/O layer lives in social-cleanup.js.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Firebase push-ID alphabet. It is in ASCII order, which is why push IDs sort
// lexicographically in creation order.
const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

// Keep in sync with targetLangs in workers/rekindle-translate/worker.js.
// social-cleanup.js prefers the live keys under kindlechat/translations_by_lang
// and only falls back to this list if that shallow read fails.
const TRANSLATION_LANGS = ['en', 'es', 'pt', 'pl', 'de', 'it', 'fr', 'ru', 'zh', 'vi'];

// Firebase push IDs are URL-safe; reject slashes/dots so a malformed key can
// never escape the intended RTDB subtree.
const RTDB_KEY_RE = /^[A-Za-z0-9_-]{1,768}$/;

function isSafeRtdbKey(key) {
    return typeof key === 'string' && RTDB_KEY_RE.test(key);
}

function isQuotaError(error) {
    if (!error) return false;
    if (error.code === 8 || error.code === 'resource-exhausted') return true;
    const text = error.message || String(error);
    return /RESOURCE_EXHAUSTED|Quota exceeded/i.test(text);
}

function cutoffMs(nowMs, days) {
    if (!Number.isFinite(nowMs)) {
        throw new Error('cutoffMs: nowMs must be a finite number');
    }
    if (!Number.isInteger(days) || days < 1) {
        throw new Error('cutoffMs: days must be a positive integer');
    }
    return nowMs - days * DAY_MS;
}

/**
 * Decode the creation timestamp embedded in a Firebase push ID (first 8 chars,
 * 48-bit ms since the epoch). Returns 0 for keys that are not valid push IDs.
 *
 * Needed because RTDB REST shallow GETs reject orderBy/endAt/startAt; paging
 * keys and decoding the push time is the only way to age-filter without
 * downloading every message body.
 */
function pushIdTimestamp(key) {
    if (typeof key !== 'string' || key.length < 8) return 0;

    let ms = 0;
    for (let i = 0; i < 8; i++) {
        const index = PUSH_CHARS.indexOf(key.charAt(i));
        if (index === -1) return 0;
        ms = ms * 64 + index;
    }
    return ms > 0 ? ms : 0;
}

function chunk(items, size) {
    const list = Array.isArray(items) ? items : [];
    const width = Math.max(1, Math.trunc(Number(size)) || 1);
    const out = [];
    for (let i = 0; i < list.length; i += width) {
        out.push(list.slice(i, i + width));
    }
    return out;
}

/**
 * Run `fn` over `items` with at most `limit` concurrent calls. Results keep the
 * input order so callers can log deterministic summaries.
 */
async function mapWithConcurrency(items, limit, fn) {
    const list = Array.isArray(items) ? items : [];
    const width = Math.max(1, Math.min(Math.trunc(Number(limit)) || 1, list.length || 1));
    const results = new Array(list.length);
    let next = 0;

    async function worker() {
        for (;;) {
            const index = next++;
            if (index >= list.length) return;
            results[index] = await fn(list[index], index);
        }
    }

    await Promise.all(Array.from({ length: width }, () => worker()));
    return results;
}

/**
 * Build the single multi-path RTDB update that removes a batch of chat
 * messages plus everything derived from them. Passing null deletes the path.
 *
 * Each message costs 2 + N_languages paths (message, art_index, translations).
 * social-cleanup.js keeps batches at 200 messages (~2,400 paths) so one write
 * stays comfortably small.
 */
function buildChatDeletePaths(ids, langs) {
    const updates = {};
    const safeLangs = Array.from(new Set((Array.isArray(langs) ? langs : []).filter(isSafeRtdbKey)));

    for (const id of Array.isArray(ids) ? ids : []) {
        if (!isSafeRtdbKey(id)) continue;

        updates[`kindlechat/messages/${id}`] = null;
        updates[`kindlechat/art_index/${id}`] = null;
        for (const lang of safeLangs) {
            updates[`kindlechat/translations_by_lang/${lang}/${id}`] = null;
        }
    }

    return updates;
}

/**
 * Resolved/dismissed reports are pruned after `retentionDays`. Pending reports
 * are deliberately never auto-deleted: they are the moderator queue.
 */
function shouldDeleteReport(report, nowMs, retentionDays) {
    if (!report || typeof report !== 'object') return false;
    if (report.status !== 'resolved' && report.status !== 'dismissed') return false;

    const createdAt = Number(report.createdAt);
    if (!Number.isFinite(createdAt)) return false;

    return createdAt < cutoffMs(nowMs, retentionDays);
}

function toMillis(value) {
    if (!value) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value.toMillis === 'function') {
        const ms = value.toMillis();
        return Number.isFinite(ms) ? ms : 0;
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : 0;
    }
    return 0;
}

module.exports = {
    DAY_MS,
    PUSH_CHARS,
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
};
