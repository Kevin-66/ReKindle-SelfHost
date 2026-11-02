/*
 * Flip the KindleChat direct-message kill switch.
 *
 * Run:
 *   node scripts/set-dm-flag.js --status
 *   node scripts/set-dm-flag.js --env=beta --enabled=true
 *   node scripts/set-dm-flag.js --env=prod --enabled=false
 *
 * Both flags live in the SOCIAL project RTDB:
 *   kindlechat/config/dm_enabled       production (rekindle.ink, lite, legacy)
 *   kindlechat/config/dm_beta_enabled  beta.rekindle.ink only
 *
 * DM content is written only to the social RTDB by the rekindle-moderate
 * worker; this script must never be pointed at the primary project.
 */
const path = require('path');
const admin = require('firebase-admin');

const SOCIAL_DB_URL = 'https://rekindle-socials-default-rtdb.firebaseio.com';
const CONFIG_PATH = 'kindlechat/config';

function parseArgs(argv) {
    const args = { env: '', enabled: null, status: false };
    for (const arg of argv.slice(2)) {
        if (arg === '--status') args.status = true;
        else if (arg.indexOf('--env=') === 0) args.env = arg.slice(6).trim().toLowerCase();
        else if (arg.indexOf('--enabled=') === 0) {
            const value = arg.slice(10).trim().toLowerCase();
            if (value === 'true' || value === '1' || value === 'on') args.enabled = true;
            else if (value === 'false' || value === '0' || value === 'off') args.enabled = false;
            else throw new Error('--enabled must be true or false');
        } else {
            throw new Error('Unknown argument: ' + arg);
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const serviceAccountPath = path.join(__dirname, '..', 'service-account-social.json');

    if (!admin.apps.length) {
        const serviceAccount = require(serviceAccountPath);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: SOCIAL_DB_URL
        });
    }
    const db = admin.database();

    if (args.status) {
        const snap = await db.ref(CONFIG_PATH).once('value');
        const config = snap.val() || {};
        console.log('Social RTDB DM flags (' + SOCIAL_DB_URL + '):');
        console.log('  dm_enabled      = ' + (config.dm_enabled === true));
        console.log('  dm_beta_enabled = ' + (config.dm_beta_enabled === true));
        return;
    }

    if (args.env !== 'beta' && args.env !== 'prod') {
        throw new Error('Use --env=beta or --env=prod (or --status).');
    }
    if (typeof args.enabled !== 'boolean') {
        throw new Error('Use --enabled=true or --enabled=false.');
    }

    const key = args.env === 'beta' ? 'dm_beta_enabled' : 'dm_enabled';
    await db.ref(CONFIG_PATH + '/' + key).set(args.enabled);
    console.log('Set ' + CONFIG_PATH + '/' + key + ' = ' + args.enabled);
    console.log('Worker flag cache expires within 60 seconds.');
}

main().then(function () {
    process.exit(0);
}).catch(function (err) {
    console.error('ERROR:', err && err.message ? err.message : err);
    process.exit(1);
});
