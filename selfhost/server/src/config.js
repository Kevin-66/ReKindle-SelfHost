import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

function bool(v, dflt) {
    if (v === undefined || v === '') return dflt;
    return /^(1|true|yes|on)$/i.test(String(v));
}

export const SERVER_DIR = path.resolve(here, '..');

export const config = {
    port: parseInt(env.PORT || '8080', 10),
    host: env.HOST || '0.0.0.0',

    // Where persistent data lives (SQLite database, uploaded files, keys).
    dataDir: path.resolve(env.DATA_DIR || path.join(SERVER_DIR, '..', 'data')),

    // Built site. Either the build output (main/, lite/, legacy/) or a plain source tree.
    siteDir: path.resolve(env.SITE_DIR || path.join(SERVER_DIR, '..', '..')),

    // Upstream backend code (workers/, functions/api/, firebase-functions/, rules files).
    upstreamDir: path.resolve(env.UPSTREAM_DIR || path.join(SERVER_DIR, '..', '..')),

    // Every signed-in user gets ReKindle+ features on this server.
    plusForAll: bool(env.PLUS_FOR_ALL, false),

    // Username of the server admin. Empty = the first account created becomes admin.
    adminUsername: (env.ADMIN_USERNAME || '').trim().toLowerCase(),

    // Let new people create accounts. The very first account can always be created.
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),

    // Trust X-Forwarded-For (set when running behind a reverse proxy).
    trustProxy: bool(env.TRUST_PROXY, true),

    maxUploadBytes: Math.round(parseFloat(env.MAX_UPLOAD_MB || '100') * 1024 * 1024),

    // Handwriting recognition (Quick ToDo). Gemini by default, or any OpenAI-compatible API.
    geminiApiKey: env.GEMINI_API_KEY || '',
    ocrModel: env.OCR_MODEL || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
    openaiApiKey: env.OPENAI_API_KEY || '',

    // Your own Google OAuth client for Google Tasks / Calendar / Contacts sync.
    googleClientId: (env.GOOGLE_CLIENT_ID || '').trim(),

    // Request log: on when run locally, off on the deployed server (owner's rule: logging
    // only locally; the Docker image sets NODE_ENV=production). LOG_REQUESTS overrides.
    logRequests: bool(env.LOG_REQUESTS, env.NODE_ENV !== 'production')
};

// The Firebase project ID baked into the ReKindle pages. Chat and online
// multiplayer are not offered on this server, so the pages' second ("social")
// project is folded into this one: there is a single data space.
export const NS_MAIN = 'rekindle-dd1fa';

export function normalizeNs() {
    return NS_MAIN;
}

// ReKindle turns usernames into pseudo e-mail addresses. Kept as-is so the
// pages work unchanged; nothing is ever sent to these addresses.
export const EMAIL_DOMAIN = 'rekindle.ink';
export const UPSTREAM_ADMIN_EMAIL = 'ukiyo@rekindle.ink';
export const UPSTREAM_GOOGLE_CLIENT_ID = '1000949048966-kkjtgmrsdonk3bm89rvlo0punc519vgj.apps.googleusercontent.com';
