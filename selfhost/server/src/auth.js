import crypto from 'node:crypto';
import { db } from './db.js';
import { config, EMAIL_DOMAIN, NS_MAIN, normalizeNs } from './config.js';
import { signJwt, verifyJwt, randomToken, sha256 } from './jwt.js';

const ID_TOKEN_TTL = 3600;

export class AuthError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

export function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

// ---------------------------------------------------------------- passwords

function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pw), salt, 64);
    return 'scrypt$' + salt.toString('base64') + '$' + hash.toString('base64');
}

function checkPassword(pw, stored) {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, saltB64, hashB64] = stored.split('$');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltB64, 'base64'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------- users

export function getUser(uid) {
    return db.prepare('SELECT * FROM users WHERE uid = ?').get(String(uid)) || null;
}

export function getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) || null;
}

export function userCount() {
    return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function listUsers(limit = 1000, offset = 0) {
    return db.prepare('SELECT * FROM users ORDER BY created ASC LIMIT ? OFFSET ?').all(limit, offset);
}

let adminCache = null;
export function adminEmail() {
    if (config.adminUsername) return `${config.adminUsername}@${EMAIL_DOMAIN}`;
    if (adminCache) return adminCache;
    const row = db.prepare('SELECT email FROM users ORDER BY created ASC, rowid ASC LIMIT 1').get();
    if (row) adminCache = row.email;
    return row ? row.email : `admin-not-set@${EMAIL_DOMAIN}.invalid`;
}

export function isAdminEmail(email) {
    return !!email && normalizeEmail(email) === adminEmail();
}

// While ADMIN_USERNAME is set and that account does not exist yet, it is the only
// account that can be created, so nobody else can claim it on a public server.
export function canRegister(username) {
    if (config.adminUsername && !getUserByEmail(adminEmail())) {
        return String(username || '').trim().toLowerCase() === config.adminUsername;
    }
    return config.allowRegistration || userCount() === 0;
}

export function registrationClosedMessage() {
    if (config.adminUsername && !getUserByEmail(adminEmail())) {
        return 'This server is waiting for its admin account to be created first.';
    }
    return 'New accounts are turned off on this server. Ask the server admin.';
}

function validatePassword(pw) {
    if (typeof pw !== 'string' || pw.length < 6) {
        throw new AuthError('auth/weak-password', 'Password should be at least 6 characters (auth/weak-password).');
    }
}

export function createUser({ uid, email, password, displayName, photoURL, disabled } = {}) {
    email = normalizeEmail(email);
    if (!email || !email.includes('@')) throw new AuthError('auth/invalid-email', 'The email address is badly formatted (auth/invalid-email).');
    if (password !== undefined) validatePassword(password);
    if (getUserByEmail(email)) throw new AuthError('auth/email-already-exists', 'The email address is already in use by another account (auth/email-already-in-use).');
    uid = uid ? String(uid) : randomToken(21).replace(/[^A-Za-z0-9]/g, '').slice(0, 28);
    if (getUser(uid)) throw new AuthError('auth/uid-already-exists', 'The user with the provided uid already exists.');
    const now = Date.now();
    db.prepare(`INSERT INTO users(uid, email, pass, display_name, photo_url, disabled, created, valid_since)
                VALUES(?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(uid, email, password !== undefined ? hashPassword(password) : null, displayName || null, photoURL || null, disabled ? 1 : 0, now);
    adminCache = null;
    return getUser(uid);
}

export function updateUser(uid, fields = {}) {
    const user = getUser(uid);
    if (!user) throw new AuthError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.', 404);
    if (fields.email !== undefined && fields.email !== null) {
        const email = normalizeEmail(fields.email);
        const other = getUserByEmail(email);
        if (other && other.uid !== uid) throw new AuthError('auth/email-already-exists', 'The email address is already in use by another account.');
        db.prepare('UPDATE users SET email = ? WHERE uid = ?').run(email, uid);
        adminCache = null;
    }
    if (fields.password !== undefined && fields.password !== null) {
        validatePassword(fields.password);
        db.prepare('UPDATE users SET pass = ? WHERE uid = ?').run(hashPassword(fields.password), uid);
    }
    if (fields.displayName !== undefined) db.prepare('UPDATE users SET display_name = ? WHERE uid = ?').run(fields.displayName || null, uid);
    if (fields.photoURL !== undefined) db.prepare('UPDATE users SET photo_url = ? WHERE uid = ?').run(fields.photoURL || null, uid);
    if (fields.disabled !== undefined) {
        db.prepare('UPDATE users SET disabled = ? WHERE uid = ?').run(fields.disabled ? 1 : 0, uid);
        if (fields.disabled) revokeSessions(uid);
    }
    return getUser(uid);
}

export function deleteUser(uid) {
    if (!getUser(uid)) throw new AuthError('auth/user-not-found', 'There is no user record corresponding to the provided identifier.', 404);
    db.prepare('DELETE FROM sessions WHERE uid = ?').run(uid);
    db.prepare('DELETE FROM user_claims WHERE uid = ?').run(uid);
    db.prepare('DELETE FROM manga_state WHERE uid = ?').run(uid);
    db.prepare('DELETE FROM zlib_accounts WHERE uid = ?').run(uid);
    db.prepare('DELETE FROM notes_agent WHERE uid = ?').run(uid);
    db.prepare('DELETE FROM users WHERE uid = ?').run(uid);
    adminCache = null;
}

export function getClaims(uid, ns) {
    const row = db.prepare('SELECT claims FROM user_claims WHERE uid = ? AND ns = ?').get(uid, normalizeNs(ns));
    return row ? JSON.parse(row.claims) : {};
}

export function setClaims(uid, ns, claims) {
    db.prepare('INSERT INTO user_claims(uid, ns, claims) VALUES(?, ?, ?) ON CONFLICT(uid, ns) DO UPDATE SET claims = excluded.claims')
        .run(uid, normalizeNs(ns), JSON.stringify(claims || {}));
}

export function revokeSessions(uid) {
    // Token iat has 1 s resolution; round down so a token minted right after still counts.
    db.prepare('UPDATE users SET valid_since = ? WHERE uid = ?').run(Math.floor(Date.now() / 1000) * 1000, uid);
    db.prepare('DELETE FROM sessions WHERE uid = ?').run(uid);
}

export function publicUser(u) {
    return {
        uid: u.uid,
        email: u.email,
        displayName: u.display_name,
        photoURL: u.photo_url,
        createdAt: u.created,
        lastLoginAt: u.last_login,
        disabled: !!u.disabled
    };
}

// ---------------------------------------------------------------- tokens

export function effectiveClaims(user, ns, sessionClaims) {
    const claims = { ...getClaims(user.uid, ns), ...(sessionClaims || {}) };
    if (config.plusForAll) claims.pro = true;
    if (isAdminEmail(user.email)) {
        claims.admin = true;
        claims.pro = true;
    }
    return claims;
}

export function mintIdToken(user, ns, provider, sessionClaims) {
    ns = normalizeNs(ns);
    const now = Math.floor(Date.now() / 1000);
    const claims = effectiveClaims(user, ns, sessionClaims);
    delete claims.email;
    const payload = {
        ...claims,
        iss: `https://securetoken.google.com/${ns}`,
        aud: ns,
        auth_time: now,
        user_id: user.uid,
        sub: user.uid,
        iat: now,
        exp: now + ID_TOKEN_TTL,
        email: user.email,
        email_verified: true,
        firebase: { identities: { email: [user.email] }, sign_in_provider: provider || 'password' }
    };
    return signJwt(payload);
}

// Returns the decoded token (with `uid`) or null.
export function verifyIdToken(token) {
    const p = verifyJwt(token);
    if (!p || !p.sub || !p.iss || !String(p.iss).startsWith('https://securetoken.google.com/')) return null;
    if (p.aud !== NS_MAIN) return null;
    const user = getUser(p.sub);
    if (!user || user.disabled) return null;
    if (p.iat * 1000 < user.valid_since) return null;
    return { ...p, uid: p.sub };
}

function newSession(user, ns, provider, claims) {
    const refreshToken = randomToken(40);
    const now = Date.now();
    db.prepare('INSERT INTO sessions(id, uid, ns, provider, claims, created, last_used) VALUES(?, ?, ?, ?, ?, ?, ?)')
        .run(sha256(refreshToken), user.uid, normalizeNs(ns), provider, claims ? JSON.stringify(claims) : null, now, now);
    db.prepare('UPDATE users SET last_login = ? WHERE uid = ?').run(now, user.uid);
    const fresh = getUser(user.uid);
    return {
        idToken: mintIdToken(fresh, ns, provider, claims),
        refreshToken,
        user: publicUser(fresh)
    };
}

export function signInWithPassword(email, password, ns) {
    const user = getUserByEmail(email);
    if (!user || !user.pass) throw new AuthError('auth/user-not-found', 'There is no user record corresponding to this identifier. The user may have been deleted. (auth/user-not-found).');
    if (!checkPassword(password, user.pass)) throw new AuthError('auth/wrong-password', 'The password is invalid or the user does not have a password. (auth/wrong-password).');
    if (user.disabled) throw new AuthError('auth/user-disabled', 'The user account has been disabled by an administrator. (auth/user-disabled).', 403);
    return newSession(user, ns, 'password', null);
}

export function createCustomToken(uid, claims) {
    const now = Math.floor(Date.now() / 1000);
    return signJwt({
        iss: 'rekindle-selfhost',
        aud: 'rekindle-selfhost/custom-token',
        sub: 'rekindle-selfhost',
        uid: String(uid),
        claims: claims || undefined,
        iat: now,
        exp: now + 3600
    });
}

export function signInWithCustomToken(token, ns) {
    const p = verifyJwt(token);
    if (!p || p.aud !== 'rekindle-selfhost/custom-token' || !p.uid) {
        throw new AuthError('auth/invalid-custom-token', 'The custom token format is incorrect. (auth/invalid-custom-token).');
    }
    const user = getUser(p.uid);
    if (!user) throw new AuthError('auth/user-not-found', 'There is no user record corresponding to this identifier. (auth/user-not-found).');
    if (user.disabled) throw new AuthError('auth/user-disabled', 'The user account has been disabled by an administrator. (auth/user-disabled).', 403);
    const claims = p.claims ? { ...p.claims } : null;
    if (claims) delete claims.email;
    return newSession(user, ns, 'custom', claims);
}

export function refreshSession(refreshToken) {
    const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sha256(String(refreshToken || '')));
    if (!sess) throw new AuthError('auth/invalid-refresh-token', 'The user\'s credential is no longer valid. The user must sign in again. (auth/user-token-expired).', 401);
    const user = getUser(sess.uid);
    if (!user) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(sess.id);
        throw new AuthError('auth/user-not-found', 'There is no user record corresponding to this identifier. (auth/user-not-found).', 401);
    }
    if (user.disabled) throw new AuthError('auth/user-disabled', 'The user account has been disabled by an administrator. (auth/user-disabled).', 401);
    db.prepare('UPDATE sessions SET last_used = ? WHERE id = ?').run(Date.now(), sess.id);
    return {
        idToken: mintIdToken(user, sess.ns, sess.provider, sess.claims ? JSON.parse(sess.claims) : null),
        user: publicUser(user)
    };
}

export function signOut(refreshToken) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(String(refreshToken || '')));
}

// Forget sessions nobody has used for 6 months.
export function pruneSessions() {
    db.prepare('DELETE FROM sessions WHERE last_used < ?').run(Date.now() - 180 * 24 * 3600 * 1000);
}
