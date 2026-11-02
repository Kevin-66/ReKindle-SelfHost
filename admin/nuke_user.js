const admin = require('firebase-admin');
const fs = require('fs');

// --- CONFIGURATION ---
const SERVICE_ACCOUNT_PATH = '../service-account.json';
const SOCIAL_SERVICE_ACCOUNT_PATH = '../service-account-social.json';
const DATABASE_URL = 'https://rekindle-dd1fa-default-rtdb.firebaseio.com/';
const SOCIAL_DATABASE_URL = 'https://rekindle-socials-default-rtdb.firebaseio.com/';

// --- ARGS ---
const args = process.argv.slice(2);
if (args.length === 0) {
    console.error('Usage: node nuke_user.js <username_or_uid> [--force]');
    console.error('This script will disable the user, ban their IP, and delete their content.');
    process.exit(1);
}

const TARGET_USERNAME = args[0];
const FORCE_MODE = args.includes('--force');

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

// Initialize secondary app for social project (optional — falls back to main if key missing)
let socialRtdb = admin.database();
let socialDb = null;
let hasSocialAdmin = false;
try {
    if (fs.existsSync(SOCIAL_SERVICE_ACCOUNT_PATH)) {
        const socialServiceAccount = require(SOCIAL_SERVICE_ACCOUNT_PATH);
        const socialApp = admin.initializeApp({
            credential: admin.credential.cert(socialServiceAccount),
            databaseURL: SOCIAL_DATABASE_URL
        }, 'social-admin');
        socialRtdb = socialApp.database();
        socialDb = socialApp.firestore();
        hasSocialAdmin = true;
        console.log('Social admin app initialized.');
    } else {
        console.warn('Social service account not found at ' + SOCIAL_SERVICE_ACCOUNT_PATH + ' — using main project for social data.');
    }
} catch (e) {
    console.warn('Failed to initialize social admin app:', e.message);
}

const db = admin.firestore();
const rtdb = admin.database();

// --- STATE ---
let targetUid = null;
let targetUsername = null; // The KindleChat/email-handle name used in message records
let targetDisplayName = null;
let deletionTasks = [];

function formatIpKey(ip) {
    return ip.replace(/\./g, '-').replace(/:/g, '_');
}

function safeFirebaseKey(value) {
    return String(value || 'unknown').replace(/[.#$\[\]\/]/g, '_');
}

function buildBannedUserEntry(user, addedBy, addedAt) {
    const entry = {
        uid: user.uid,
        username: user.username || user.uid,
        addedBy
    };
    if (addedAt) {
        entry.addedAt = addedAt;
    } else {
        entry.addedAt = admin.database.ServerValue.TIMESTAMP;
    }
    return entry;
}

async function upsertBannedIpForUser(ip) {
    const formattedIp = formatIpKey(ip);
    const ref = rtdb.ref(`banned_ips/${formattedIp}`);
    const snap = await ref.once('value');
    const existing = snap.val() || {};
    const timestamp = admin.database.ServerValue.TIMESTAMP;
    const bannedBy = 'nuke_user_script';
    const user = {
        uid: targetUid,
        username: targetDisplayName || targetUsername || targetUid
    };
    const updates = {
        ip,
        lastUpdatedAt: timestamp,
        lastUpdatedBy: bannedBy
    };

    if (!existing.bannedAt) updates.bannedAt = existing.timestamp || timestamp;
    if (!existing.timestamp) updates.timestamp = existing.bannedAt || timestamp;
    if (!existing.bannedBy) updates.bannedBy = bannedBy;
    if (!existing.bannedUid) updates.bannedUid = user.uid;
    if (!existing.bannedUsername) updates.bannedUsername = user.username;

    const existingUsers = existing.bannedUsers || {};
    const userKey = safeFirebaseKey(user.uid);
    const userAlreadyAttached = existing.bannedUid === user.uid || !!existingUsers[userKey];
    if (existing.bannedUid && !existingUsers[safeFirebaseKey(existing.bannedUid)]) {
        const existingUser = {
            uid: existing.bannedUid,
            username: existing.bannedUsername || existing.username || existing.bannedUid
        };
        updates[`bannedUsers/${safeFirebaseKey(existing.bannedUid)}`] = buildBannedUserEntry(
            existingUser,
            existing.bannedBy || bannedBy,
            existing.bannedAt || existing.timestamp
        );
    }

    updates[`bannedUsers/${userKey}`] = buildBannedUserEntry(user, bannedBy);

    await ref.update(updates);
    return {
        alreadyBanned: snap.exists(),
        attachedDifferentUser: snap.exists() && !userAlreadyAttached
    };
}

async function main() {
    console.log(`\n=== ReKindle User NUKE Tool ===`);
    console.log(`Target: ${TARGET_USERNAME}`);
    console.log(`Mode: ${FORCE_MODE ? 'WET RUN (DELETING FOR REAL)' : 'DRY RUN (READ ONLY)'}\n`);

    try {
        await resolveUser();
        if (!targetUid) {
            console.error("Could not resolve user. Exiting.");
            process.exit(1);
        }

        console.log(`Resolved User: ${targetUsername} (UID: ${targetUid})`);

        // Execute Ban & IP Block
        await banUserAndIP();

        // 1. Scan KindleChat RTDB
        await scanKindleChatRTDB();

        // 1b. Scan KindleChat direct messages (social RTDB)
        await scanKindleChatDMs();

        // 2. Scan KindleChat Firestore
        await scanKindleChatFirestore();

        // 3. Scan Topics
        await scanTopics();

        // 4. Scan Neighbourhood
        await scanNeighbourhood();

        console.log(`\n=== Summary ===`);
        console.log(`Total items found for deletion: ${deletionTasks.length}`);

        if (deletionTasks.length > 0) {
            if (FORCE_MODE) {
                await executeDeletions();
            } else {
                console.log(`\n[DRY RUN] No changes made. Run with --force to execute bans and deletions.`);
            }
        } else {
            console.log(`\nNo content found to delete.`);
        }

    } catch (e) {
        console.error("Fatal Error:", e);
    } finally {
        process.exit(0);
    }
}

// --- BAN USER & IP ---
async function banUserAndIP() {
    console.log("\n--- Banning User and IP ---");
    try {
        const snap = await rtdb.ref(`users_private/${targetUid}/ipAddress`).once('value');
        const ip = snap.val();
        
        if (ip) {
            console.log(`Found associated IP address: ${ip}`);
            if (FORCE_MODE) {
                const banResult = await upsertBannedIpForUser(ip);
                if (banResult.alreadyBanned) {
                    const verb = banResult.attachedDifferentUser ? 'appended' : 'refreshed';
                    console.log(`[SUCCESS] IP ${ip} was already banned; ${verb} ${targetDisplayName || targetUsername || targetUid} in the banned user list.`);
                } else {
                    console.log(`[SUCCESS] IP ${ip} has been added to banned_ips list.`);
                }
            }
        } else {
            console.log(`No IP address found for this user in users_private.`);
        }
        
        console.log(`Disabling Firebase Auth account for UID: ${targetUid}...`);
        if (FORCE_MODE) {
            await admin.auth().updateUser(targetUid, { disabled: true });
            console.log(`[SUCCESS] Account is now permanently disabled.`);
        }
    } catch (e) {
        console.error("Error during ban execution:", e);
    }
    console.log("----------------------------\n");
}

// --- RESOLVE USER ---
async function resolveUser() {
    console.log("Resolving user...");

    // Check if input is already a UID (simple heuristic)
    if (TARGET_USERNAME.length > 20 && !TARGET_USERNAME.includes(' ')) {
        // Verify existence
        try {
            const userRecord = await admin.auth().getUser(TARGET_USERNAME);
            targetUid = userRecord.uid;
            // For KindleChat, we need the email handle, NOT the display name
            const email = userRecord.email || '';
            targetUsername = email.split('@')[0] || userRecord.displayName || 'Unknown';
            const publicSnap = await rtdb.ref(`users_public/${targetUid}`).once('value');
            const publicData = publicSnap.val() || {};
            targetDisplayName = publicData.displayName || publicData.username || userRecord.displayName || targetUsername;
            return;
        } catch (e) {
            // Not a valid Auth UID, treat as username
        }
    }

    // Lookup in users_public
    const snap = await rtdb.ref('users_public').once('value');
    const users = snap.val() || {};

    // Search by displayName or Email or raw UID
    for (const [uid, data] of Object.entries(users)) {
        const name = (data.displayName || '').toLowerCase();
        const email = (data.email || '').toLowerCase();
        const target = TARGET_USERNAME.toLowerCase();

        if (name === target || email.startsWith(target + '@') || uid === TARGET_USERNAME) {
            targetUid = uid;

            // Fetch the auth record to be sure of the email handle which is used for kindlechat
            try {
                const userRecord = await admin.auth().getUser(uid);
                const authEmail = userRecord.email || '';
                targetUsername = authEmail.split('@')[0] || data.displayName;
                targetDisplayName = data.displayName || data.username || targetUsername;
                console.log(`Resolved Identity: Display="${data.displayName}", KindleChatUser="${targetUsername}"`);
            } catch (e) {
                console.warn("Could not fetch Auth record, falling back to DisplayName:", e);
                targetUsername = data.displayName || 'Unknown';
                targetDisplayName = data.displayName || data.username || targetUsername;
            }
            return;
        }
    }

    console.warn(`Warning: Could not find strict UID mapping for '${TARGET_USERNAME}'.`);
    console.warn(`Assuming '${TARGET_USERNAME}' is the raw KindleChat username.`);
    targetUsername = TARGET_USERNAME;
    targetDisplayName = TARGET_USERNAME;
}

// --- SCANNING ---
async function scanKindleChatRTDB() {
    console.log(`Scanning KindleChat (RTDB) for user='${targetUsername}' / uid='${targetUid}'...`);
    const ref = socialRtdb.ref('kindlechat/messages');

    // Messages may use old-style 'user' (email handle) or new-style 'uid' (Firebase UID)
    const queries = [];
    if (targetUsername) queries.push(ref.orderByChild('user').equalTo(targetUsername).once('value'));
    if (targetUid)      queries.push(ref.orderByChild('uid').equalTo(targetUid).once('value'));

    const snaps = await Promise.all(queries);
    const seen = new Set();
    snaps.forEach(snap => {
        if (!snap.exists()) return;
        snap.forEach(child => {
            if (seen.has(child.key)) return;
            seen.add(child.key);
            deletionTasks.push({
                type: 'KindleChat (General)',
                id: child.key,
                summary: (child.val().text || '').substring(0, 50),
                action: () => child.ref.remove()
            });
        });
    });
}

async function scanKindleChatDMs() {
    if (!hasSocialAdmin) {
        console.error("Skipping KindleChat DMs: the social service account is required (DM data must never be touched in the primary RTDB).");
        return;
    }
    if (!targetUid) {
        console.log("Skipping KindleChat DMs (No UID resolved)");
        return;
    }
    console.log("Scanning KindleChat DMs (social RTDB)...");

    const threadIds = new Set();
    const inboxSnap = await socialRtdb.ref(`kindlechat/dm_user_threads/${targetUid}`).once('value');
    inboxSnap.forEach(child => threadIds.add(child.key));

    const allThreadsSnap = await socialRtdb.ref('kindlechat/dm_threads').once('value');
    allThreadsSnap.forEach(child => {
        const thread = child.val();
        if (thread && thread.participants && thread.participants[targetUid] === true) {
            threadIds.add(child.key);
        }
    });

    for (const threadId of threadIds) {
        const threadSnap = await socialRtdb.ref(`kindlechat/dm_threads/${threadId}`).once('value');
        const thread = threadSnap.val() || {};

        const messagesSnap = await socialRtdb.ref(`kindlechat/dm_messages/${threadId}`).once('value');
        messagesSnap.forEach(msg => {
            deletionTasks.push({
                type: `KindleChat DM (${threadId})`,
                id: msg.key,
                summary: (msg.val().text || '').substring(0, 50),
                action: () => msg.ref.remove()
            });
        });

        deletionTasks.push({
            type: 'KindleChat DM Thread',
            id: threadId,
            summary: 'thread',
            action: () => socialRtdb.ref(`kindlechat/dm_threads/${threadId}`).remove()
        });
        deletionTasks.push({
            type: 'KindleChat DM Inbox',
            id: `${targetUid}/${threadId}`,
            summary: 'inbox row',
            action: () => socialRtdb.ref(`kindlechat/dm_user_threads/${targetUid}/${threadId}`).remove()
        });

        Object.keys(thread.participants || {}).forEach(participant => {
            if (participant === targetUid) return;
            deletionTasks.push({
                type: 'KindleChat DM Inbox',
                id: `${participant}/${threadId}`,
                summary: 'peer inbox row',
                action: () => socialRtdb.ref(`kindlechat/dm_user_threads/${participant}/${threadId}`).remove()
            });
        });
    }

    deletionTasks.push({
        type: 'KindleChat DM Prefs',
        id: targetUid,
        summary: 'request preference',
        action: () => socialRtdb.ref(`kindlechat/dm_prefs/${targetUid}`).remove()
    });

    const blocksSnap = await socialRtdb.ref('kindlechat/dm_blocks').once('value');
    blocksSnap.forEach(userNode => {
        userNode.forEach(targetNode => {
            if (userNode.key !== targetUid && targetNode.key !== targetUid) return;
            deletionTasks.push({
                type: 'KindleChat DM Block',
                id: `${userNode.key}/${targetNode.key}`,
                summary: 'block',
                action: () => targetNode.ref.remove()
            });
        });
    });
}

async function scanKindleChatFirestore() {
    console.log("Scanning KindleChat (Firestore)...");
    try {
        const roomsSnap = await db.collection('rooms')
            .where('participants', 'array-contains', targetUsername)
            .get();

        console.log(`Found ${roomsSnap.size} rooms to scan.`);

        for (const roomDoc of roomsSnap.docs) {
            const seen = new Set();
            const addMsg = doc => {
                if (seen.has(doc.id)) return;
                seen.add(doc.id);
                deletionTasks.push({
                    type: `KindleChat (DM/Room: ${roomDoc.id})`,
                    id: doc.id,
                    summary: (doc.data().text || '').substring(0, 50),
                    action: () => doc.ref.delete()
                });
            };

            // Old-style messages stored by email handle
            if (targetUsername) {
                const byHandle = await roomDoc.ref.collection('messages').where('user', '==', targetUsername).get();
                byHandle.forEach(addMsg);
            }
            // New-style messages stored by UID
            if (targetUid) {
                const byUid = await roomDoc.ref.collection('messages').where('uid', '==', targetUid).get();
                byUid.forEach(addMsg);
            }
        }
    } catch (e) {
        console.error("Error scanning Firestore rooms:", e);
        if (e.code === 9) {
            console.error("Tip: Ensure 'rooms' collection has an index for 'participants' array-contains.");
        }
    }
}

async function scanTopics() {
    if (!targetUid) {
        console.log("Skipping Topics (No UID resolved)");
        return;
    }
    console.log("Scanning Topics...");

    // 1. Topics created by user
    const topicsSnap = await socialDb.collection('topics').where('authorId', '==', targetUid).get();
    for (const doc of topicsSnap.docs) {
        const topicId = doc.id;
        deletionTasks.push({
            type: 'Topic',
            id: topicId,
            summary: (doc.data().title || '').substring(0, 50),
            action: async () => {
                const commentsSnap = await socialDb.collection('topics').doc(topicId).collection('comments').get();
                const batch = socialDb.batch();
                commentsSnap.docs.forEach(c => batch.delete(c.ref));
                if (commentsSnap.docs.length > 0) await batch.commit();
                await socialDb.collection('topics').doc(topicId).delete();
            }
        });
    }

    // 2. Comments on other users' topics
    const allTopicsSnap = await socialDb.collection('topics').get();
    for (const topicDoc of allTopicsSnap.docs) {
        const commentsSnap = await topicDoc.ref.collection('comments').where('authorId', '==', targetUid).get();
        for (const commentDoc of commentsSnap.docs) {
            deletionTasks.push({
                type: 'Topic Comment',
                id: commentDoc.id,
                summary: (commentDoc.data().text || '').substring(0, 50),
                action: () => commentDoc.ref.delete()
            });
        }
    }
}

async function scanNeighbourhood() {
    if (!targetUid) {
        console.log("Skipping Neighbourhood (No UID resolved)");
        return;
    }
    console.log("Scanning Neighbourhood...");

    // 1. Posts
    const postsSnap = await socialDb.collection('neighbourhood_posts').where('uid', '==', targetUid).get();
    for (const doc of postsSnap.docs) {
        const postId = doc.id;
        deletionTasks.push({
            type: 'Neighbourhood Post',
            id: postId,
            summary: (doc.data().text || '').substring(0, 50),
            action: async () => {
                const commentsSnap = await socialDb.collection('neighbourhood_posts').doc(postId).collection('comments').get();
                const batch = socialDb.batch();
                commentsSnap.docs.forEach(c => batch.delete(c.ref));
                if (commentsSnap.docs.length > 0) await batch.commit();
                await socialDb.collection('neighbourhood_posts').doc(postId).delete();
            }
        });
    }

    // 2. Comments on other users' posts
    const allPostsSnap = await socialDb.collection('neighbourhood_posts').get();
    for (const postDoc of allPostsSnap.docs) {
        const commentsSnap = await postDoc.ref.collection('comments').where('uid', '==', targetUid).get();
        for (const commentDoc of commentsSnap.docs) {
            deletionTasks.push({
                type: 'Neighbourhood Comment',
                id: commentDoc.id,
                summary: (commentDoc.data().text || '').substring(0, 50),
                action: () => commentDoc.ref.delete()
            });
        }
    }
}

// --- EXECUTION ---
async function executeDeletions() {
    console.log(`\nExecuting ${deletionTasks.length} deletions...`);

    let deletedCount = 0;
    let errors = 0;

    for (const task of deletionTasks) {
        try {
            process.stdout.write(`Deleting ${task.type} (${task.id})... `);
            await task.action();
            process.stdout.write("DONE\n");
            deletedCount++;
        } catch (e) {
            process.stdout.write("FAILED\n");
            console.error(e.message);
            errors++;
        }
    }

    console.log(`\nOperation Complete.`);
    console.log(`Deleted content chunks: ${deletedCount}`);
    console.log(`Errors: ${errors}`);
}

main();
