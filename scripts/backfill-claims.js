/*
 * One-off Pro + ageVerified claim backfill (2026-10-20).
 *
 * The old Pro flow replaced the whole custom-claims object, deleting
 * ageVerified and moderator. This script:
 *   - computes current Pro status from users/{uid}.proExpiresAt and
 *     config/supporters (preserving legacy manual grants with no expiry)
 *   - restores ageVerified from users/{uid}/ageVerification/latest
 *   - merges claims instead of replacing them
 *
 * Defaults to dry-run. Run:
 *   node scripts/backfill-claims.js
 *   node scripts/backfill-claims.js --apply
 *
 * Requires service-account.json (gitignored) with Firebase Auth admin access.
 */
const path = require('path');
const admin = require('firebase-admin');
const sa = require(path.join(__dirname, '..', 'service-account.json'));
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();
const auth = admin.auth();
const APPLY = process.argv.includes('--apply');
const DEV_EMAIL = 'ukiyo@rekindle.ink';

function ms(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  return 0;
}

(async () => {
  const now = Date.now();

  const supporters = {};
  const suppSnap = await db.collection('config').doc('supporters').get();
  if (suppSnap.exists) {
    for (const [email, entry] of Object.entries(suppSnap.data() || {})) {
      if (entry && ms(entry.expiresAt) > now) supporters[email] = true;
    }
  }

  // uid -> { exp: number }
  const docs = {};
  let last = null;
  while (true) {
    let query = db.collection('users').orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) break;
    snap.docs.forEach(d => {
      const data = d.data() || {};
      docs[d.id] = { exp: ms(data.proExpiresAt), hasExpiry: data.proExpiresAt != null };
    });
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  // Read each user's ageVerification/latest doc (only 7.2k total) so we can
  // restore ageVerified claims that the old Pro flow deleted.
  const ageVerified = {};
  const ageUids = Object.keys(docs);
  for (let i = 0; i < ageUids.length; i += 300) {
    const refs = ageUids.slice(i, i + 300).map(uid => db.collection('users').doc(uid).collection('ageVerification').doc('latest'));
    const snaps = await db.getAll.apply(db, refs);
    for (const snap of snaps) {
      if (!snap.exists) continue;
      const data = snap.data() || {};
      if (data.verified === true) {
        const parts = snap.ref.path.split('/');
        ageVerified[parts[1]] = true;
      }
    }
  }

  let pageToken, total = 0, changed = 0, toTrue = 0, toFalse = 0, ageRestored = 0, preservedNoDoc = 0, errors = 0;
  const changes = [];
  do {
    const res = await auth.listUsers(1000, pageToken);
    for (const user of res.users) {
      total++;
      const claims = user.customClaims || {};
      const email = user.email || '';
      let desired;
      if (email === DEV_EMAIL) {
        desired = true;
      } else {
        const doc = docs[user.uid];
        if (doc) {
          if (doc.exp > now || supporters[email] === true) {
            desired = true;
          } else if (doc.hasExpiry) {
            desired = false;
          } else {
            // Legacy manual grant with no expiry record: preserve it.
            preservedNoDoc++;
            desired = claims.pro === true;
          }
        } else if (supporters[email] === true) {
          desired = true;
        } else {
          // No Firestore profile and no supporter record: preserve any manual
          // pro grant rather than revoking it blindly.
          preservedNoDoc++;
          desired = claims.pro === true;
        }
      }

      // Only touch claims that actually need changing. Do not stamp
      // `pro: false` onto the ~35k users who never had a Pro claim at all.
      const needsTrue = desired === true && claims.pro !== true;
      const needsFalse = desired === false && claims.pro === true;
      const needsAge = ageVerified[user.uid] === true && claims.ageVerified !== true;
      if (!needsTrue && !needsFalse && !needsAge) continue;
      changed++;
      if (needsTrue) toTrue++;
      if (needsFalse) toFalse++;
      if (needsAge) ageRestored++;
      const nextClaims = Object.assign({}, claims, { pro: desired });
      if (needsAge) nextClaims.ageVerified = true;
      changes.push({ uid: user.uid, email: user.email || '', from: claims.pro, to: desired, age: needsAge, exp: docs[user.uid] ? new Date(docs[user.uid].exp).toISOString() : null, hasExpiry: docs[user.uid] ? docs[user.uid].hasExpiry : null });
      if (APPLY) {
        try {
          await auth.setCustomUserClaims(user.uid, nextClaims);
        } catch (e) {
          errors++;
          console.error('write failed', user.uid, e.message);
        }
      }
    }
    pageToken = res.pageToken;
  } while (pageToken);

  console.log(JSON.stringify({
    mode: APPLY ? 'apply' : 'dry-run',
    authUsers: total,
    userDocs: Object.keys(docs).length,
    supporters: Object.keys(supporters).length,
    changed,
    toTrue,
    toFalse,
    ageRestored,
    preservedNoDoc,
    errors,
    sample: changes.slice(0, 10)
  }, null, 2));
  if (!APPLY) console.log('No writes performed. Re-run with --apply.');
})().catch(e => { console.error(e); process.exit(1); });
