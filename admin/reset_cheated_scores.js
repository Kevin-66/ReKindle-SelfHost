/**
 * Remove leaderboard entries that could not have come from play.
 *
 * The old rules accepted any number, so boards now contain things like
 * 6.7e+67 and 1e308. This script walks every leaderboard collection, compares
 * each document against the bounds in firebase-functions/score-config.js, and
 * (only with --apply) deletes the documents that are impossible.
 *
 * Usage:
 *   node reset_cheated_scores.js            # dry run — prints offenders only
 *   node reset_cheated_scores.js --apply    # actually deletes them
 *
 * Deleting the document removes that user's whole entry for the game, so they
 * start from zero. That is intentional: a document that holds a fabricated
 * value is not trustworthy, and the player can re-earn a real score.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
const { COLLECTIONS } = require('../firebase-functions/score-config');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'service-account.json');
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error(`Error: service account key not found at ${SERVICE_ACCOUNT_PATH}`);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH))
});

const db = admin.firestore();

function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
}

function problemsFor(collection, data) {
    const config = COLLECTIONS[collection];
    const problems = [];
    const fields = config.fields || {};

    Object.keys(fields).forEach((field) => {
        const rule = fields[field];
        // Only validate fields this leaderboard actually uses for ranking.
        // (e.g. trivia has two; mario four; most have one.)
        if (!(field in data)) {
            // Missing is fine for secondary fields (mario dist/coins/time).
            return;
        }
        const value = data[field];
        if (!isFiniteNumber(value)) {
            problems.push(`${field}=${String(value)} (not a finite number)`);
            return;
        }
        if (!rule.float && !Number.isInteger(value)) {
            problems.push(`${field}=${value} (not a whole number)`);
            return;
        }
        if (value < rule.min || value > rule.max) {
            problems.push(`${field}=${value} (outside ${rule.min}..${rule.max})`);
        }
    });

    return problems;
}

async function main() {
    console.log('\n=== ReKindle hacked-score cleanup ===');
    console.log(`Mode: ${APPLY ? 'APPLY (deleting)' : 'DRY RUN (read-only)'}\n`);

    let offenders = 0;
    let scanned = 0;
    const doomed = {};
    const backup = [];

    for (const collection of Object.keys(COLLECTIONS)) {
        let snapshot;
        try {
            snapshot = await db.collection(collection).get();
        } catch (e) {
            console.error(`Could not read ${collection}:`, e.message);
            continue;
        }

        snapshot.forEach((doc) => {
            scanned++;
            const data = doc.data() || {};
            const problems = problemsFor(collection, data);
            if (problems.length === 0) return;
            offenders++;
            (doomed[collection] = doomed[collection] || []).push(doc.ref);
            backup.push({ collection: collection, id: doc.id, data: data });
            console.log(`${collection}/${doc.id}  user=${data.username || '?'}`);
            problems.forEach((p) => console.log(`    ${p}`));
        });
    }

    console.log(`\nScanned ${scanned} entries across ${Object.keys(COLLECTIONS).length} boards.`);
    console.log(`Offenders: ${offenders}`);

    if (offenders === 0) return;
    if (!APPLY) {
        console.log('\nDry run only. Re-run with --apply to delete the entries above.');
        return;
    }

    // Keep a copy of exactly what is about to be deleted so the operation is
    // reversible (admin/backups/ is gitignored).
    const backupDir = path.join(__dirname, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `removed-scores-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
    console.log(`\nBackup written to ${backupFile}`);

    for (const collection of Object.keys(doomed)) {
        const refs = doomed[collection];
        // Firestore batches are capped at 500 writes.
        for (let i = 0; i < refs.length; i += 400) {
            const batch = db.batch();
            refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
            await batch.commit();
        }
        console.log(`Deleted ${refs.length} entr${refs.length === 1 ? 'y' : 'ies'} from ${collection}.`);
    }
}

main().catch((e) => {
    console.error('Cleanup failed:', e);
    process.exit(1);
});
