// The Manga app's link to the reader's own Manhuagui (漫画柜) account: the account's
// bookshelf (书架, /user/book/shelf) and the Manga library are kept the same, both ways,
// and so is each title's last-read chapter (最近阅读; runRead and the lastRead part of
// runSync).
//
// Signing in: the reader types their Manhuagui username and password in the Manga app.
// They are passed once to Manhuagui's own login (the site's login form posts to
// /tools/submit_ajax.ashx?action=user_login) and not kept; only the session cookie
// Manhuagui answers with (`my=...`) is stored, per ReKindle account (mhg_accounts), and
// only ever sent to Manhuagui. When Manhuagui ends the session (the shelf redirects to
// /user/login), the cookie is cleared and the app asks the reader to sign in again.
//
// Sync (planSync): the app sends the Manhuagui ids in its library and the ids the reader
// removed from it since the last sync. `synced` holds the ids that were on both sides
// after the last sync, so an id on one side only can be told apart as new or removed:
//   removed in the app             -> deleted from the shelf (the ONLY way the shelf
//                                     loses a title)
//   library only, not synced       -> added to the shelf
//   library only, synced           -> removed on Manhuagui: dropped from the library
//   shelf only (synced or not)     -> added to the library. A synced id missing from
//                                     the library without the reader removing it (a
//                                     stale copy of the library on another device) is
//                                     added back rather than deleted from the shelf.
// The app applies the library side itself, through its normal library saves, so
// changes the reader makes while a sync runs are not overwritten. A full sync reads the
// whole shelf (20 titles per page; 143 titles took 8 requests), so the app runs one when
// the library opens (at most every 10 minutes) and on "Sync now"; a title the reader adds
// or removes is changed on the shelf directly (change(), no shelf read).
//
// Endpoint shapes are those of the site's own scripts (main_*.js: user_check_login,
// user_book_shelf_check/_add/_delete) and of other readers that sync the shelf
// (venera-app/venera-configs manhuagui.js, RSSHub's manhuagui/subscribe route).

import { parseHTML } from 'linkedom';
import { db } from './db.js';
import { BASE, HEADERS, siteSlot, absUrl, imageUrl } from './manhuagui.js';

const MAX_IDS = 5000;
const SHELF_PAGE_SIZE = 20;
const SHELF_MAX_PAGES = 100;
// Shelf additions/deletions per sync. All requests share manhuagui.js's 10-per-10-s
// limit, so this keeps one sync to about 15 s; the app syncs again while `more` is set.
const OPS_PER_SYNC = 12;
const SIGNED_OUT_RE = /尚未登录|已超时/;

const getRow = db.prepare('SELECT username, cookie, synced, last_read, last_sync FROM mhg_accounts WHERE uid = ?');
// A new sign-in keeps `synced` only when it is the same Manhuagui account.
const putAccount = db.prepare(`INSERT INTO mhg_accounts(uid, username, cookie, synced, updated) VALUES(?, ?, ?, '[]', ?)
    ON CONFLICT(uid) DO UPDATE SET cookie = excluded.cookie, updated = excluded.updated,
    synced = CASE WHEN mhg_accounts.username = excluded.username THEN mhg_accounts.synced ELSE '[]' END,
    last_read = CASE WHEN mhg_accounts.username = excluded.username THEN mhg_accounts.last_read ELSE '{}' END,
    last_sync = CASE WHEN mhg_accounts.username = excluded.username THEN mhg_accounts.last_sync ELSE NULL END,
    username = excluded.username`);
const putCookie = db.prepare('UPDATE mhg_accounts SET cookie = ?, updated = ? WHERE uid = ?');
const putSynced = db.prepare('UPDATE mhg_accounts SET synced = ?, last_read = ?, last_sync = ?, cookie = ?, updated = ? WHERE uid = ?');
const putLastRead = db.prepare('UPDATE mhg_accounts SET last_read = ?, cookie = ?, updated = ? WHERE uid = ?');
const delRow = db.prepare('DELETE FROM mhg_accounts WHERE uid = ?');

function fail(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code });
}

function signedOut() {
    return fail('Manhuagui has signed you out. Sign in again under Store, Manhuagui.', 403, 'manhuagui/signed-out');
}

// ------------------------------------------------------------------ cookies

function cookieMap(text) {
    const map = new Map();
    for (const part of String(text || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) map.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    return map;
}

// The cookie with a response's Set-Cookie lines applied (expired or emptied ones removed).
export function mergeCookies(cookie, setCookies) {
    const map = cookieMap(cookie);
    for (const line of setCookies || []) {
        const [pair, ...attrs] = String(line).split(';');
        const i = pair.indexOf('=');
        if (i <= 0) continue;
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        const expired = !value || attrs.some((a) => {
            const j = a.indexOf('=');
            const key = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
            const v = j < 0 ? '' : a.slice(j + 1).trim();
            if (key === 'max-age') return Number(v) <= 0;
            if (key === 'expires') { const t = Date.parse(v); return Number.isFinite(t) && t < Date.now(); }
            return false;
        });
        if (expired) map.delete(name); else map.set(name, value);
    }
    return [...map].map(([k, v]) => k + '=' + v).join('; ');
}

// ------------------------------------------------------------------ requests

// One request to Manhuagui as the reader; session.cookie is updated from the answer.
// Redirects are not followed: a signed-out session gets a redirect to /user/login.
async function request(session, path, { form, ajax, referer } = {}, fetcher = fetch) {
    await siteSlot();
    const headers = { ...HEADERS, Referer: referer || `${BASE}/` };
    if (session.cookie) headers.Cookie = session.cookie;
    if (ajax) {
        headers['X-Requested-With'] = 'XMLHttpRequest';
        headers.Accept = 'application/json, text/javascript, */*; q=0.01';
    }
    let body;
    if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        headers.Origin = BASE;
        body = new URLSearchParams(form).toString();
    }
    let res;
    try {
        res = await fetcher(BASE + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    } catch (e) {
        throw fail(`Could not reach Manhuagui (${e.message})`, 502, 'unavailable');
    }
    session.cookie = mergeCookies(session.cookie, typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []);
    return res;
}

const isRedirect = (res) => res.status >= 300 && res.status < 400;

async function json(res) {
    if (isRedirect(res)) throw signedOut();
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || typeof data !== 'object') throw fail(`Manhuagui gave an unexpected answer (HTTP ${res.status}).`, 502, 'unavailable');
    if (Number(data.status) !== 1 && SIGNED_OUT_RE.test(String(data.msg || ''))) throw signedOut();
    return data;
}

// The site's answers say ok as status: 1 (login, check) or state: true (shelf changes).
const ok = (data) => Number(data.status) === 1 || data.state === true || Number(data.state) === 1;

function decodeName(name) {
    try { return decodeURIComponent(String(name || '')); } catch { return String(name || ''); }
}

// ------------------------------------------------------------------ account

export function accountStatus(uid) {
    const row = getRow.get(uid);
    if (!row) return { connected: false };
    return { connected: !!row.cookie, expired: !row.cookie, username: row.username, lastSync: row.last_sync || null };
}

export async function signIn(uid, username, password, fetcher = fetch) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) throw fail('Enter your Manhuagui username (or email) and password.');
    if (username.length > 100 || password.length > 200) throw fail('That username or password is too long.');
    const session = { cookie: '' };
    const res = await request(session, '/tools/submit_ajax.ashx?action=user_login', {
        form: { txtUserName: username, txtPassword: password, chkRemember: 'checked' },
        ajax: true,
        referer: `${BASE}/user/login`
    }, fetcher);
    const answer = await json(res);
    if (!ok(answer)) throw fail(answer.msg ? `Manhuagui: ${answer.msg}` : 'Manhuagui did not accept that username and password.', 400, 'manhuagui/login-failed');
    const check = await json(await request(session, '/tools/submit_ajax.ashx?action=user_check_login', { form: {}, ajax: true }, fetcher));
    if (!ok(check)) throw fail('Manhuagui accepted the password but did not keep you signed in. Try again.', 502, 'manhuagui/login-failed');
    putAccount.run(uid, decodeName(check.username) || username, session.cookie, Date.now());
    return accountStatus(uid);
}

export function removeAccount(uid) {
    delRow.run(uid);
    return { connected: false };
}

// ------------------------------------------------------------------ shelf

// When the shelf says a title was last read, as the EARLIEST moment it can mean (ms):
// "N分钟前" -> N+1 minutes ago, "2026-05-19" -> that day's start in China (UTC+8). An
// early estimate only lets a Manhuagui read win when it is clearly the newer one.
export function readTime(text, now = Date.now()) {
    const t = String(text || '').trim();
    const ago = t.match(/(\d+)\s*(秒|分钟|小时|天)前/);
    if (ago) return now - (parseInt(ago[1], 10) + 1) * { 秒: 1000, 分钟: 60000, 小时: 3600000, 天: 86400000 }[ago[2]];
    const CHINA = 8 * 3600000;
    const dayStart = (ms) => Math.floor((ms + CHINA) / 86400000) * 86400000 - CHINA;
    if (/^今天/.test(t)) return dayStart(now);
    if (/^昨天/.test(t)) return dayStart(now) - 86400000;
    if (/^前天/.test(t)) return dayStart(now) - 2 * 86400000;
    const date = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (date) return Date.UTC(+date[1], +date[2] - 1, +date[3]) - CHINA;
    return null;
}

// One shelf page: { books: [{ id, title, cover, lastRead }], pages } (pages from
// "共N记录"). lastRead ("最近阅读", set by /tools/count.ashx when a chapter opens):
// { chapter: 'bookId/chapterId', name, time } or null.
export function parseShelf(html, now = Date.now()) {
    const { document } = parseHTML(html);
    const books = [];
    for (const li of document.querySelectorAll('.dy_content_li')) {
        const a = li.querySelector('.dy_img a') || li.querySelector('a[href*="/comic/"]');
        const m = a && (a.getAttribute('href') || '').match(/\/comic\/(\d+)/);
        if (!m) continue;
        const img = a.querySelector('img');
        const h3 = li.querySelector('.dy_r h3 a');
        const title = (h3 && h3.textContent.trim()) || (img && img.getAttribute('alt')) || a.getAttribute('title') || '';
        const src = img && (img.getAttribute('src') || img.getAttribute('data-src'));
        let lastRead = null;
        for (const para of li.querySelectorAll('.dy_r p')) {
            if (!para.textContent.includes('最近阅读')) continue;
            const link = para.querySelector('a[href]');
            const ch = link && (link.getAttribute('href') || '').match(/\/comic\/(\d+)\/(\d+)\.html/);
            const when = para.querySelectorAll('em');
            if (ch) lastRead = { chapter: `${ch[1]}/${ch[2]}`, name: link.textContent.trim(), time: readTime(when.length > 1 ? when[when.length - 1].textContent : '', now) };
        }
        // The shelf shows small covers (/cpic/s/, 88x118); search results use /cpic/b/.
        books.push({ id: m[1], title: title.trim(), cover: imageUrl(absUrl(src && src.replace('/cpic/s/', '/cpic/b/'))), lastRead });
    }
    let pages = 1;
    const count = (document.querySelector('.flickr.right span') || {}).textContent || '';
    const total = count.match(/共\s*(\d+)\s*记录/);
    if (total) pages = Math.ceil(parseInt(total[1], 10) / SHELF_PAGE_SIZE) || 1;
    else {
        for (const btn of document.querySelectorAll('.page-btns a')) {
            const n = parseInt(btn.textContent.trim(), 10);
            if (n > pages) pages = n;
        }
    }
    return { books, pages };
}

// Every title on the shelf, as a Map id -> { id, title, cover }.
async function fetchShelf(session, fetcher) {
    const shelf = new Map();
    let pages = 1;
    for (let page = 1; page <= pages && page <= SHELF_MAX_PAGES; page++) {
        const res = await request(session, `/user/book/shelf/${page}`, {}, fetcher);
        if (isRedirect(res)) throw signedOut();
        if (!res.ok) throw fail(`Manhuagui returned HTTP ${res.status} for your bookshelf.`, 502, 'unavailable');
        const html = await res.text();
        const data = parseShelf(html);
        // A page without the account area is not the shelf (a block or error page).
        if (!data.books.length && !/dy_content|avatar-box/.test(html)) throw fail('Manhuagui did not show your bookshelf. Try again later.', 502, 'unavailable');
        for (const b of data.books) if (!shelf.has(b.id)) shelf.set(b.id, b);
        if (page === 1) pages = data.pages;
    }
    return shelf;
}

// Adds a title to the shelf or deletes it; true when the shelf ends up that way.
async function shelfChange(session, action, id, fetcher) {
    const referer = `${BASE}/comic/${id}/`;
    const answer = await json(await request(session, `/tools/submit_ajax.ashx?action=user_book_shelf_${action}`, { form: { book_id: id }, ajax: true, referer }, fetcher));
    if (ok(answer)) return true;
    // "Already on the shelf" and the like: ask where it stands now.
    const check = await json(await request(session, `/tools/submit_ajax.ashx?action=user_book_shelf_check&book_id=${id}`, { ajax: true, referer }, fetcher));
    return (Number(check.status) === 1) === (action === 'add');
}

// ------------------------------------------------------------------ sync

// What a sync changes, from id lists: library (the app's Manhuagui titles), shelf,
// synced (on both sides after the last sync) and removed (removed in the app since).
export function planSync({ library, shelf, synced, removed }) {
    const inLibrary = new Set(library);
    const onShelf = new Set(shelf);
    const wasSynced = new Set(synced);
    const wasRemoved = new Set(removed);
    const plan = { shelfAdd: [], shelfDelete: [], libraryAdd: [], libraryRemove: [] };
    for (const id of wasRemoved) if (onShelf.has(id) && !inLibrary.has(id)) plan.shelfDelete.push(id);
    for (const id of inLibrary) {
        if (onShelf.has(id)) continue;
        (wasSynced.has(id) ? plan.libraryRemove : plan.shelfAdd).push(id);
    }
    for (const id of onShelf) if (!inLibrary.has(id) && !wasRemoved.has(id)) plan.libraryAdd.push(id);
    return plan;
}

function idList(value, name) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_IDS) throw fail(`${name} must be a list of Manhuagui ids.`);
    const out = new Set();
    for (const v of value) {
        const id = String(v).replace(/^mhg:/, '');
        if (!/^\d{1,10}$/.test(id)) throw fail(`Not a Manhuagui id: ${String(v).slice(0, 20)}`);
        out.add(id);
    }
    return [...out];
}

// Deletions first (they are what the reader just did), then additions, at most
// OPS_PER_SYNC in all; `more` when some were left for the next call.
async function changeShelf(session, deletes, adds, fetcher) {
    const out = { added: [], deleted: [], failed: [], signedOut: false, more: false };
    let budget = OPS_PER_SYNC;
    const run = async (ids, action, done) => {
        for (const id of ids) {
            if (out.signedOut) return;
            if (budget <= 0) { out.more = true; return; }
            budget--;
            try {
                (await shelfChange(session, action, id, fetcher) ? done : out.failed).push(id);
            } catch (e) {
                if (e.code === 'manhuagui/signed-out') out.signedOut = true;
                out.failed.push(id);
            }
        }
    };
    await run(deletes, 'delete', out.deleted);
    await run(adds, 'add', out.added);
    if (out.signedOut) out.more = false;
    return out;
}

function sessionFor(uid) {
    const row = getRow.get(uid);
    if (!row) return { answer: { connected: false } };
    if (!row.cookie) return { answer: { connected: false, expired: true, username: row.username } };
    return { row, session: { cookie: row.cookie } };
}

function shelfSummary(row, ops, removed, pendingDeletes) {
    return {
        connected: !ops.signedOut,
        expired: ops.signedOut || undefined,
        username: row.username,
        // Removals the app no longer needs to send (deleted, or not on the shelf anyway).
        removedDone: removed.filter((id) => !pendingDeletes.has(id)),
        shelf: { added: ops.added.length, deleted: ops.deleted.length, failed: ops.failed.length },
        more: ops.more
    };
}

// The full sync: reads the whole shelf (one request per 20 titles) and plans both sides.
async function runSync(uid, body, fetcher) {
    const { row, session, answer } = sessionFor(uid);
    if (answer) return answer;
    const library = idList(body.library, 'library');
    const removed = idList(body.removed, 'removed');
    let shelf;
    try {
        shelf = await fetchShelf(session, fetcher);
    } catch (e) {
        putCookie.run(e.code === 'manhuagui/signed-out' ? null : session.cookie, Date.now(), uid);
        throw e;
    }
    const plan = planSync({ library, shelf: [...shelf.keys()], synced: JSON.parse(row.synced || '[]'), removed });
    const ops = await changeShelf(session, plan.shelfDelete, plan.shelfAdd, fetcher);

    // On both sides afterwards: kept as they were, plus what was added on either side.
    const synced = new Set(ops.added);
    for (const id of library) if (shelf.has(id)) synced.add(id);
    for (const id of plan.libraryAdd) synced.add(id);

    // Last read: titles in the library whose 最近阅读 changed since Manhuagui last showed
    // (or this server last told it) a chapter, i.e. read on Manhuagui itself. The app
    // decides whether that is newer than its own progress (previousSync, time).
    const seen = JSON.parse(row.last_read || '{}');
    const nextSeen = {};
    const lastRead = [];
    for (const [id, book] of shelf) {
        if (!book.lastRead || !(library.includes(id) || plan.libraryAdd.includes(id))) continue;
        nextSeen[id] = book.lastRead.chapter;
        if (seen[id] !== book.lastRead.chapter) lastRead.push({ id, ...book.lastRead });
    }
    const now = Date.now();
    putSynced.run(JSON.stringify([...synced]), JSON.stringify(nextSeen), now, ops.signedOut ? null : session.cookie, now, uid);

    const pendingDeletes = new Set(plan.shelfDelete.filter((id) => !ops.deleted.includes(id)));
    return {
        ...shelfSummary(row, ops, removed, pendingDeletes),
        add: plan.libraryAdd.map((id) => { const { lastRead: _, ...book } = shelf.get(id); return book; }),
        remove: plan.libraryRemove,
        lastRead,
        previousSync: row.last_sync || null
    };
}

// Titles the reader just added to or removed from the library, changed on the shelf
// directly (no shelf read). Whatever fails here, the next full sync catches.
async function runChange(uid, body, fetcher) {
    const { row, session, answer } = sessionFor(uid);
    if (answer) return answer;
    const adds = idList(body.add, 'add');
    const removed = idList(body.remove, 'remove').filter((id) => !adds.includes(id));
    const ops = await changeShelf(session, removed, adds, fetcher);
    const synced = new Set(JSON.parse(row.synced || '[]'));
    for (const id of ops.added) synced.add(id);
    for (const id of ops.deleted) synced.delete(id);
    putSynced.run(JSON.stringify([...synced]), row.last_read, row.last_sync, ops.signedOut ? null : session.cookie, Date.now(), uid);
    return shelfSummary(row, ops, removed, new Set(removed.filter((id) => !ops.deleted.includes(id))));
}

// A chapter opened in the app's reader, reported to Manhuagui the way its own reader does
// (GET /tools/count.ashx?bookId=&chapterId= once per chapter; with the session cookie it
// becomes the title's 最近阅读, checked on the owner's shelf 2026-10-10).
async function runRead(uid, body, fetcher) {
    const { row, session, answer } = sessionFor(uid);
    if (answer) return answer;
    const m = String(body.chapter || '').match(/^(\d{1,10})\/(\d{1,12})$/);
    if (!m) throw fail('chapter must be "bookId/chapterId".');
    const res = await request(session, `/tools/count.ashx?bookId=${m[1]}&chapterId=${m[2]}`, { ajax: true, referer: `${BASE}/comic/${m[1]}/${m[2]}.html` }, fetcher);
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) throw fail(`Manhuagui returned HTTP ${res.status} for the reading record.`, 502, 'unavailable');
    // So the next sync does not take this read for one made on Manhuagui.
    const seen = JSON.parse(row.last_read || '{}');
    seen[m[1]] = `${m[1]}/${m[2]}`;
    putLastRead.run(JSON.stringify(seen), session.cookie, Date.now(), uid);
    return { connected: true, username: row.username };
}

// One Manhuagui job at a time per account (two open Manga pages would otherwise race).
const running = new Map();

function queued(uid, job) {
    const previous = running.get(uid) || Promise.resolve();
    const next = previous.catch(() => {}).then(job);
    running.set(uid, next);
    next.finally(() => { if (running.get(uid) === next) running.delete(uid); }).catch(() => {});
    return next;
}

export function sync(uid, body, fetcher = fetch) {
    return queued(uid, () => runSync(uid, body || {}, fetcher));
}

export function change(uid, body, fetcher = fetch) {
    return queued(uid, () => runChange(uid, body || {}, fetcher));
}

export function read(uid, body, fetcher = fetch) {
    return queued(uid, () => runRead(uid, body || {}, fetcher));
}
