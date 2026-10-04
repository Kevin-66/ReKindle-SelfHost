import crypto from 'node:crypto';
import { metaGet, metaSet } from './db.js';

// One RSA key pair signs ID tokens and custom tokens, and doubles as the
// private key of the fake service account handed to the upstream workers.
function loadKeys() {
    let priv = metaGet('rsa_private_pem');
    let pub = metaGet('rsa_public_pem');
    if (!priv || !pub) {
        const pair = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
        });
        priv = pair.privateKey;
        pub = pair.publicKey;
        metaSet('rsa_private_pem', priv);
        metaSet('rsa_public_pem', pub);
    }
    const publicKey = crypto.createPublicKey(pub);
    const kid = crypto.createHash('sha256').update(pub).digest('hex').slice(0, 40);
    return { privatePem: priv, publicPem: pub, privateKey: crypto.createPrivateKey(priv), publicKey, kid };
}

export const keys = loadKeys();

export function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fromB64url(s) {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signJwt(payload) {
    const header = { alg: 'RS256', kid: keys.kid, typ: 'JWT' };
    const data = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(data), keys.privateKey);
    return data + '.' + b64url(sig);
}

export function verifyJwt(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
        if (header.alg !== 'RS256') return null;
        const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), keys.publicKey, fromB64url(parts[2]));
        if (!ok) return null;
        const payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
        if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

export function decodeJwtUnverified(token) {
    try {
        return JSON.parse(fromB64url(String(token).split('.')[1]).toString('utf8'));
    } catch {
        return null;
    }
}

export function publicJwk() {
    const jwk = keys.publicKey.export({ format: 'jwk' });
    return { ...jwk, kid: keys.kid, alg: 'RS256', use: 'sig' };
}

export function randomToken(bytes = 32) {
    return b64url(crypto.randomBytes(bytes));
}

export function sha256(s) {
    return crypto.createHash('sha256').update(s).digest('hex');
}
