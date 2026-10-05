// The Manga app's library and reading progress, kept per account. manga.html keeps
// them only in the browser (localforage), which the Kindle can wipe; the add-on
// script (selfhost/site/js/rk-manga-sources.js) loads this copy when Manga opens and
// sends every change here: GET / PUT /__rk/manga/state (api.js).

import { db } from './db.js';

const MAX_ITEMS = 5000;

const getRow = db.prepare('SELECT library, progress, library_updated FROM manga_state WHERE uid = ?');
const putRow = db.prepare(`INSERT INTO manga_state(uid, library, progress, library_updated, updated) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET library = excluded.library, progress = excluded.progress,
    library_updated = excluded.library_updated, updated = excluded.updated`);

function badRequest(message) {
    return Object.assign(new Error(message), { status: 400, code: 'invalid-argument' });
}

// { library: [...] or null (never saved), progress: { mangaId: entry }, libraryUpdated }
export function getState(uid) {
    const row = getRow.get(uid);
    if (!row) return { library: null, progress: {}, libraryUpdated: null };
    return {
        library: row.library ? JSON.parse(row.library) : null,
        progress: JSON.parse(row.progress || '{}'),
        libraryUpdated: row.library_updated
    };
}

// body: { library?: [...], progress?: { mangaId: entry } }. A library replaces the
// stored one. Progress entries are merged per manga, the newest (entry.t, a time in
// ms set by the app) winning, so two devices can't undo each other's reading.
export function putState(uid, body) {
    const state = getState(uid);
    const now = Date.now();
    if (body.library !== undefined) {
        if (!Array.isArray(body.library)) throw badRequest('library must be a list');
        state.library = body.library.filter((item) => item && typeof item === 'object' && item.id != null).slice(0, MAX_ITEMS);
        state.libraryUpdated = now;
    }
    if (body.progress !== undefined) {
        if (!body.progress || typeof body.progress !== 'object' || Array.isArray(body.progress)) throw badRequest('progress must be an object');
        for (const [id, entry] of Object.entries(body.progress)) {
            if (!entry || typeof entry !== 'object') continue;
            const old = state.progress[id];
            if (!old || (Number(entry.t) || 0) >= (Number(old.t) || 0)) state.progress[id] = entry;
        }
        const ids = Object.keys(state.progress);
        if (ids.length > MAX_ITEMS) {
            ids.sort((a, b) => (Number(state.progress[a].t) || 0) - (Number(state.progress[b].t) || 0));
            for (const id of ids.slice(0, ids.length - MAX_ITEMS)) delete state.progress[id];
        }
    }
    putRow.run(uid, state.library ? JSON.stringify(state.library) : null, JSON.stringify(state.progress), state.libraryUpdated, now);
    return { libraryUpdated: state.libraryUpdated, updated: now };
}
