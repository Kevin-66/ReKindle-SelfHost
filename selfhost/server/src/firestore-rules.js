// Access rules for the document store: a hand port of firestore.rules from the
// ReKindle repo, minus the online-multiplayer and community collections that
// this server does not offer. If several rules match a path, any one allowing
// the request is enough (same as Firestore). No match means no access.

import { config } from './config.js';
import { tsToMillis } from './fsvalues.js';

const RESERVED = /(ukiyo|rekindle|wantban|root|system|admin|administrator|mod|moderator|support)/i;

function isValidActionUsername(name, ctx) {
    return typeof name === 'string'
        && name.length > 0
        && name.length <= 40
        && /^[a-zA-Z0-9_.-]+$/.test(name)
        && (ctx.isAdmin || !RESERVED.test(name));
}

function isValidText(text) {
    return typeof text === 'string' && text.length > 0 && text.length <= 1000 && !/[<>]/.test(text);
}

const signedIn = (c) => !!c.auth;
const isOwner = (c) => !!c.auth && c.auth.uid === c.params.userId;
const always = () => true;

const rules = [];
function match(pattern, perms) {
    const p = { ...perms };
    if (p.write) { p.create = p.create || p.write; p.update = p.update || p.write; p.delete = p.delete || p.write; }
    rules.push({ segs: pattern.split('/'), perms: p });
}

// 1. The user's own profile document.
match('users/{userId}', {
    read: (c) => signedIn(c) && (c.auth.uid === c.params.userId || c.isAdmin),
    create: (c) => isOwner(c) && !['isPro', 'proExpiresAt', 'substack_sid'].some((k) => c.newKeys().includes(k)),
    update: (c) => signedIn(c) && (
        c.isAdmin || (
            isOwner(c)
            && !c.affected().some((k) => k === 'isPro' || k === 'proExpiresAt')
            && (!c.affected().includes('substack_sid') || c.isPro())
        )),
    delete: isOwner
});

// Everything under a user's document belongs to that user. (Upstream lists
// each app's subcollection by name; one owner rule keeps new apps working.)
match('users/{userId}/**', { read: isOwner, write: isOwner });

// ...except these, which upstream ties to ReKindle+.
match('users/{userId}/pro_data/{docId}', { read: (c) => isOwner(c) && c.isPro(), write: (c) => isOwner(c) && c.isPro() });
match('users/{userId}/rss_feeds/{docId}', {
    read: isOwner,
    delete: isOwner,
    update: (c) => isOwner(c) && (c.isPro() || c.data.category === 'Uncategorized'),
    create: (c) => isOwner(c) && c.isPro()
});

// 2. Leaderboards (one document per player).
match('{leaderboard}/{userId}', {
    read: (c) => c.params.leaderboard.startsWith('leaderboard_') && signedIn(c),
    write: (c) => c.params.leaderboard.startsWith('leaderboard_')
        && isOwner(c)
        && (c.data === null || c.data.username === undefined || isValidActionUsername(c.data.username, c))
});

// 3. AirType signalling between phone and e-reader.
match('freewrite_sessions/{sessionId}', { read: always, write: always });

// 4. Interactive fiction blacklist and shared uploads.
match('interactive_blacklist/{gameId}', { read: always, write: signedIn });
for (const coll of ['interactive_uploads', 'sheet_music_uploads']) {
    match(`${coll}/{uploadId}`, {
        read: always,
        create: (c) => signedIn(c) && c.data.uploaderUid === c.auth.uid && isValidText(c.data.title),
        delete: (c) => signedIn(c) && c.resource && c.resource.uploaderUid === c.auth.uid
    });
}

// 5. Server config documents.
match('config/supporters', { read: signedIn, write: (c) => c.isAdmin });
match('config/moderators', { read: signedIn, write: (c) => c.isAdmin });

function matchPath(segs, parts) {
    const params = {};
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        if (s === '**') {
            return parts.length > i ? params : null;
        }
        if (i >= parts.length) return null;
        if (s.startsWith('{') && s.endsWith('}')) params[s.slice(1, -1)] = parts[i];
        else if (s !== parts[i]) return null;
    }
    return parts.length === segs.length ? params : null;
}

// op: 'read' | 'create' | 'update' | 'delete'
export function allowed(op, path, ctxBase) {
    const parts = path.split('/');
    for (const r of rules) {
        const params = matchPath(r.segs, parts);
        if (!params) continue;
        const fn = r.perms[op];
        if (!fn) continue;
        try {
            if (fn({ ...ctxBase, params })) return true;
        } catch {
            // a failing expression denies, like in Firestore
        }
    }
    return false;
}

export function makeIsPro(getDoc, auth) {
    return () => {
        if (!auth) return false;
        if (config.plusForAll || auth.pro === true || auth.admin === true) return true;
        const user = getDoc(`users/${auth.uid}`);
        if (user && user.proExpiresAt && user.proExpiresAt.$ts && tsToMillis(user.proExpiresAt) > Date.now()) return true;
        const sup = getDoc('config/supporters');
        const entry = sup && auth.email ? sup[auth.email] : null;
        return !!(entry && entry.expiresAt && entry.expiresAt.$ts && tsToMillis(entry.expiresAt) > Date.now());
    };
}
