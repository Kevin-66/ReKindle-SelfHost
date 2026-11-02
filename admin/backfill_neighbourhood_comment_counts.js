/*
 * Backfill `commentCount` on neighbourhood_posts.
 *
 * Neighbourhood used to show a comment count only after a post's comments had
 * been loaded, and then only from the size of that snapshot — nothing was
 * stored on the post. The count now lives on the post document so the feed can
 * render "Comments (3)" with no extra reads, which means every existing post
 * needs the field populated once.
 *
 * Run from the repo root:
 *     node admin/backfill_neighbourhood_comment_counts.js            # dry run
 *     node admin/backfill_neighbourhood_comment_counts.js --apply    # write
 *
 * Counting uses a Firestore aggregation query, so the whole run costs roughly
 * one indexed entry read per comment rather than one document read per post.
 * Safe to re-run: it only writes documents whose stored count is wrong.
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const SOCIAL_SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'service-account-social.json');
const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 200;

if (!fs.existsSync(SOCIAL_SERVICE_ACCOUNT_PATH)) {
    console.error(`Error: social service account key not found at ${SOCIAL_SERVICE_ACCOUNT_PATH}`);
    process.exit(1);
}

const socialServiceAccount = require(SOCIAL_SERVICE_ACCOUNT_PATH);

const socialApp = admin.initializeApp({
    credential: admin.credential.cert(socialServiceAccount),
    projectId: socialServiceAccount.project_id
}, 'neighbourhood-count-backfill');

const socialDb = socialApp.firestore();

function storedCount(data) {
    const raw = data.commentCount;
    if (typeof raw === 'number') return raw;
    // Firestore can hand back a numeric string if something wrote a string.
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

async function main() {
    console.log(`Mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN (no writes) — pass --apply to write'}`);
    console.log('Counting neighbourhood_posts/*/comments …\n');

    let lastDoc = null;
    let scanned = 0;
    let drifted = 0;
    let fixed = 0;
    let failed = 0;

    for (;;) {
        let query = socialDb.collection('neighbourhood_posts')
            .orderBy(admin.firestore.FieldPath.documentId())
            .limit(PAGE_SIZE);
        if (lastDoc) query = query.startAfter(lastDoc);

        const page = await query.get();
        if (page.empty) break;
        lastDoc = page.docs[page.docs.length - 1];

        for (const doc of page.docs) {
            scanned++;
            const data = doc.data() || {};
            let actual;
            try {
                const agg = await doc.ref.collection('comments').count().get();
                actual = agg.data().count;
            } catch (e) {
                failed++;
                console.error(`  ${doc.id}: could not count comments (${e.message})`);
                continue;
            }

            const stored = storedCount(data);
            if (stored === actual) continue;

            drifted++;
            process.stdout.write(
                `  ${doc.id}: ${stored === null ? '(missing)' : stored} -> ${actual}` +
                (APPLY ? ' … ' : '\n')
            );

            if (APPLY) {
                try {
                    await doc.ref.update({ commentCount: actual });
                    fixed++;
                    console.log('written');
                } catch (e) {
                    failed++;
                    console.log(`FAILED (${e.message})`);
                }
            }
        }

        console.log(`  … scanned ${scanned} posts so far`);
        if (page.size < PAGE_SIZE) break;
    }

    console.log('\nDone.');
    console.log(`  posts scanned : ${scanned}`);
    console.log(`  counts drifted: ${drifted}`);
    if (APPLY) console.log(`  counts written: ${fixed}`);
    else if (drifted) console.log('  re-run with --apply to write these values');
    if (failed) console.log(`  failures      : ${failed}`);
}

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.error('Backfill failed:', e);
        process.exit(1);
    });
