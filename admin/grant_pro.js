const admin = require('firebase-admin');
const fs = require('fs');

// --- CONFIGURATION ---
const SERVICE_ACCOUNT_PATH = '../service-account.json';
const DATABASE_URL = 'https://rekindle-dd1fa-default-rtdb.firebaseio.com/';

// --- ARGS ---
const args = process.argv.slice(2);

function printUsage() {
    console.log('Usage:');
    console.log('  node grant_pro.js <email_or_username_or_uid> --days <N>');
    console.log('  node grant_pro.js <email_or_username_or_uid> --months <N>');
    console.log('  node grant_pro.js <email_or_username_or_uid> --years <N>');
    console.log('  node grant_pro.js <email_or_username_or_uid> --lifetime');
    console.log('  node grant_pro.js <email_or_username_or_uid> --revoke');
    console.log('');
    console.log('Optional: --stripe-customer <stripe_customer_id>  (links Stripe customer to account)');
    console.log('');
    console.log('Examples:');
    console.log('  node grant_pro.js user@example.com --days 30');
    console.log('  node grant_pro.js john --months 3');
    console.log('  node grant_pro.js user@example.com --lifetime');
    console.log('  node grant_pro.js user@example.com --lifetime --stripe-customer cus_ABC123');
    console.log('  node grant_pro.js user@example.com --revoke');
    process.exit(1);
}

if (args.length < 2) printUsage();

const TARGET = args[0];
const IS_REVOKE = args.includes('--revoke');
const IS_LIFETIME = args.includes('--lifetime');

const stripeCustomerIdx = args.indexOf('--stripe-customer');
const STRIPE_CUSTOMER_ID = stripeCustomerIdx !== -1 ? args[stripeCustomerIdx + 1] : null;

let durationDays = null;
let subscriptionType = 'manual';

if (IS_REVOKE) {
    // no duration needed
} else if (IS_LIFETIME) {
    durationDays = 36500; // 100 years
    subscriptionType = 'lifetime';
} else {
    const daysIdx = args.indexOf('--days');
    const monthsIdx = args.indexOf('--months');
    const yearsIdx = args.indexOf('--years');

    if (daysIdx !== -1 && args[daysIdx + 1]) {
        durationDays = parseInt(args[daysIdx + 1], 10);
    } else if (monthsIdx !== -1 && args[monthsIdx + 1]) {
        durationDays = Math.round(parseInt(args[monthsIdx + 1], 10) * 30.44);
    } else if (yearsIdx !== -1 && args[yearsIdx + 1]) {
        durationDays = parseInt(args[yearsIdx + 1], 10) * 365;
    } else {
        printUsage();
    }

    if (isNaN(durationDays) || durationDays <= 0) {
        console.error('Error: Duration must be a positive number.');
        process.exit(1);
    }
}

// --- INIT ---
if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error(`Error: Service account key not found at ${SERVICE_ACCOUNT_PATH}`);
    console.error('Please download it from Firebase Console -> Project Settings -> Service Accounts');
    process.exit(1);
}

const serviceAccount = require(SERVICE_ACCOUNT_PATH);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
});

const rtdb = admin.database();
const firestore = admin.firestore();

// --- RESOLVE USER ---
async function resolveUser(target) {
    // Try as email via Firebase Auth
    if (target.includes('@')) {
        try {
            const userRecord = await admin.auth().getUserByEmail(target);
            return {
                uid: userRecord.uid,
                name: userRecord.displayName || target.split('@')[0],
                email: userRecord.email
            };
        } catch (e) {
            // not found in Auth by email, fall through
        }
    }

    // Try as UID
    if (target.length > 20 && !target.includes(' ')) {
        try {
            const userRecord = await admin.auth().getUser(target);
            return {
                uid: userRecord.uid,
                name: userRecord.displayName || target,
                email: userRecord.email || ''
            };
        } catch (e) {
            // not a valid UID, fall through
        }
    }

    // Look up in users_public by displayName or email
    const snap = await rtdb.ref('users_public').once('value');
    const users = snap.val() || {};
    for (const [uid, data] of Object.entries(users)) {
        const name = (data.displayName || '').toLowerCase();
        const email = (data.email || '').toLowerCase();
        const t = target.toLowerCase();
        if (name === t || email === t || email.startsWith(t + '@') || uid === target) {
            return { uid, name: data.displayName || t, email: data.email || '' };
        }
    }

    return null;
}

// --- GRANT PRO ---
async function grantPro(uid, email, days, type, stripeCustomerId = null) {
    const expiresAt = new Date();
    if (type === 'lifetime') {
        expiresAt.setFullYear(2100, 0, 1);
    } else {
        expiresAt.setDate(expiresAt.getDate() + days);
    }

    // 1. Update Firestore users/{uid}
    const firestoreUpdate = {
        isPro: true,
        proExpiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
        subscriptionType: type
    };
    if (stripeCustomerId) {
        firestoreUpdate.stripeCustomerId = stripeCustomerId;
    }
    await firestore.collection('users').doc(uid).set(firestoreUpdate, { merge: true });
    if (stripeCustomerId) {
        console.log(`✓ Set isPro=true in Firestore users/${uid} (expires: ${expiresAt.toISOString()}, stripeCustomerId: ${stripeCustomerId})`);
    } else {
        console.log(`✓ Set isPro=true in Firestore users/${uid} (expires: ${expiresAt.toISOString()})`);
    }

    // 2. Update config/supporters
    if (email) {
        const supportersRef = firestore.collection('config').doc('supporters');
        await supportersRef.set({
            [email]: {
                expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                isLifetime: type === 'lifetime'
            }
        }, { merge: true });
        console.log(`✓ Added ${email} to config/supporters`);
    } else {
        console.log('  (no email found, skipping config/supporters update)');
    }

    // 3. Set Firebase custom claim (merge, so ageVerified/moderator survive)
    const userRecord = await admin.auth().getUser(uid);
    await admin.auth().setCustomUserClaims(uid, Object.assign({}, userRecord.customClaims || {}, { pro: true }));
    console.log(`✓ Set pro=true custom claim on Firebase Auth`);

    return expiresAt;
}

// --- REVOKE PRO ---
async function revokePro(uid, email) {
    const now = new Date();

    // 1. Update Firestore users/{uid}
    await firestore.collection('users').doc(uid).set({
        isPro: false,
        proExpiresAt: admin.firestore.Timestamp.fromDate(now)
    }, { merge: true });
    console.log(`✓ Set isPro=false in Firestore users/${uid}`);

    // 2. Remove from config/supporters
    if (email) {
        const supportersRef = firestore.collection('config').doc('supporters');
        await supportersRef.set({
            [email]: admin.firestore.FieldValue.delete()
        }, { merge: true });
        console.log(`✓ Removed ${email} from config/supporters`);
    }

    // 3. Revoke Firebase custom claim (merge, so ageVerified/moderator survive)
    const userRecord = await admin.auth().getUser(uid);
    await admin.auth().setCustomUserClaims(uid, Object.assign({}, userRecord.customClaims || {}, { pro: false }));
    console.log(`✓ Set pro=false custom claim on Firebase Auth`);
}

// --- MAIN ---
async function main() {
    console.log('\n=== ReKindle Pro Management ===');
    console.log(`Target:  ${TARGET}`);

    if (IS_REVOKE) {
        console.log('Action:  REVOKE pro status');
    } else if (IS_LIFETIME) {
        console.log('Action:  GRANT lifetime pro');
    } else {
        console.log(`Action:  GRANT pro for ${durationDays} days`);
    }
    if (STRIPE_CUSTOMER_ID) console.log(`Stripe:  ${STRIPE_CUSTOMER_ID}`);
    console.log('');

    try {
        const user = await resolveUser(TARGET);

        if (!user) {
            console.error(`Error: Could not resolve user "${TARGET}". Check the email, username, or UID and try again.`);
            process.exit(1);
        }

        console.log(`Resolved: ${user.name} (UID: ${user.uid}${user.email ? ', Email: ' + user.email : ''})`);
        console.log('');

        if (IS_REVOKE) {
            await revokePro(user.uid, user.email);
            console.log('');
            console.log(`Done. ${user.name} no longer has pro status.`);
        } else {
            const expiresAt = await grantPro(user.uid, user.email, durationDays, subscriptionType, STRIPE_CUSTOMER_ID);
            console.log('');
            console.log(`Done. ${user.name} now has pro status until ${expiresAt.toDateString()}.`);
            console.log('Note: They will need to sign out and back in for the custom claim to take effect.');
        }

        console.log('');
    } catch (err) {
        console.error('Error:', err.message || err);
        process.exit(1);
    }

    process.exit(0);
}

main();
