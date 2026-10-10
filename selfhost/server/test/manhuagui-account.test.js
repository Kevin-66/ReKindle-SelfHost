// node --test selfhost/server/test/manhuagui-account.test.js
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.js opens DATA_DIR/rekindle.db when imported: use a throwaway folder.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-mhg-'));
process.env.DATA_DIR = dataDir;
const { planSync, mergeCookies, parseShelf, readTime, signIn, sync, change, read, accountStatus, removeAccount } = await import('../src/manhuagui-account.js');
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const sorted = (plan) => Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, [...v].sort()]));

test('first sync joins both sides', () => {
    assert.deepEqual(sorted(planSync({ library: ['1', '2'], shelf: ['2', '3'], synced: [], removed: [] })),
        { shelfAdd: ['1'], shelfDelete: [], libraryAdd: ['3'], libraryRemove: [] });
});

test('a title removed on Manhuagui leaves the library', () => {
    assert.deepEqual(sorted(planSync({ library: ['1', '2'], shelf: ['2'], synced: ['1', '2'], removed: [] })),
        { shelfAdd: [], shelfDelete: [], libraryAdd: [], libraryRemove: ['1'] });
});

test('a title removed in the app is deleted from the shelf', () => {
    assert.deepEqual(sorted(planSync({ library: ['2'], shelf: ['1', '2'], synced: ['1', '2'], removed: ['1'] })),
        { shelfAdd: [], shelfDelete: ['1'], libraryAdd: [], libraryRemove: [] });
});

test('a library copy that lost a title without a removal never empties the shelf', () => {
    assert.deepEqual(sorted(planSync({ library: [], shelf: ['1', '2'], synced: ['1', '2'], removed: [] })),
        { shelfAdd: [], shelfDelete: [], libraryAdd: ['1', '2'], libraryRemove: [] });
});

test('removed and added again before the sync: nothing to do', () => {
    assert.deepEqual(sorted(planSync({ library: ['1'], shelf: ['1'], synced: ['1'], removed: ['1'] })),
        { shelfAdd: [], shelfDelete: [], libraryAdd: [], libraryRemove: [] });
});

test('cookies follow Set-Cookie: added, replaced and expired', () => {
    let c = mergeCookies('', ['my=abc; path=/; HttpOnly', 'country=TW; path=/']);
    assert.equal(c, 'my=abc; country=TW');
    c = mergeCookies(c, ['my=def; expires=Fri, 01 Jan 2100 00:00:00 GMT; path=/']);
    assert.equal(c, 'my=def; country=TW');
    assert.equal(mergeCookies(c, ['country=; path=/']), 'my=def');
    assert.equal(mergeCookies(c, ['my=x; Max-Age=0']), 'country=TW');
    assert.equal(mergeCookies(c, ['my=x; expires=Thu, 01 Jan 1970 00:00:00 GMT']), 'country=TW');
});

// The shelf page as Manhuagui served it on 2026-10-10 (structure only).
function shelfPage(books, total) {
    const items = books.map(([id, title, readAt = '2026-05-19'], n) =>
        `<div class="dy_content_li"> <div class="dy_img"><a href="/comic/${id}/" target="_blank" onclick="update_read_status(${n + 100});"> ` +
        `<img src="//cf.mhgui.com/cpic/s/${id}_33.jpg" alt="${title}" width="88" height="118"></a></div> <div class="dy_r"> ` +
        `<h3><a href="/comic/${id}/" target="_blank">${title}</a></h3> <p>更新内容：<em class="co_1 c_space"><a href="/comic/${id}/913941.html">第29话</a></em> <em class="co_1">1天前</em><span class="new"></span> </p> ` +
        `<p>最近阅读：<em class="co_1 c_space"><a href="/comic/${id}/836643.html">第01卷</a></em> <em class="co_1">${readAt}</em></p> ` +
        `<input name="checkId" class="checkall" type="checkbox" value="${n + 100}"><label class="dy_check">选中</label> ` +
        `<a href="/comic/${id}/" target="_blank" class="begin">开始阅读 </a> <a href="javascript:;" class="qx" value="${n + 100}" onclick="ExecPostBack(${n + 100})">取消订阅</a> </div> </div>`).join('');
    return `<html><body><div class="avatar-box"><h3>reader</h3></div><div class="u-tab-content"><div class="dy_content autoHeight">${items}</div></div>` +
        `<div class="page-btns"><a href="javascript:;">全选</a><a href="javascript:;">删除</a></div>` +
        `<div class="flickr right"><span>共${total}记录</span><span class="disabled">«上一页</span><span class="current">1</span><a href="/user/book/shelf/2">2</a></div></body></html>`;
}

test('shelf pages: ids, titles, signed covers and page count', () => {
    const data = parseShelf(shelfPage([['19430', '鬼灭之刃'], ['1128', '海贼王']], 45));
    assert.equal(data.pages, 3);
    assert.deepEqual(data.books.map((b) => [b.id, b.title]), [['19430', '鬼灭之刃'], ['1128', '海贼王']]);
    assert.match(data.books[0].cover, /^\/__rk\/manga\/img\?u=[^&]+&k=[\w-]+$/);
    const coverUrl = Buffer.from(decodeURIComponent(data.books[0].cover.match(/u=([^&]+)/)[1]), 'base64url').toString();
    assert.equal(coverUrl, 'https://cf.mhgui.com/cpic/b/19430_33.jpg');   // the list size, not the shelf's small one
    assert.deepEqual(data.books[0].lastRead, { chapter: '19430/836643', name: '第01卷', time: Date.UTC(2026, 4, 19) - 8 * 3600000 });
    assert.deepEqual(parseShelf(shelfPage([], 0)), { books: [], pages: 1 });
});

test('last-read times are read as the earliest moment they can mean', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);   // 20:00 in China
    assert.equal(readTime('0分钟前', now), now - 60000);
    assert.equal(readTime('3小时前', now), now - 4 * 3600000);
    assert.equal(readTime('2天前', now), now - 3 * 86400000);
    assert.equal(readTime('今天', now), Date.UTC(2026, 9, 9, 16));   // 00:00 in China
    assert.equal(readTime('昨天 18:20', now), Date.UTC(2026, 9, 8, 16));
    assert.equal(readTime('2026-05-19', now), Date.UTC(2026, 4, 18, 16));
    assert.equal(readTime('', now), null);
});

// A stand-in for Manhuagui: answers by path, records what was asked.
function fakeSite(routes) {
    const calls = [];
    const fetcher = async (url, init) => {
        const u = new URL(url);
        const key = u.pathname + (u.searchParams.get('action') ? '?' + u.searchParams.get('action') : '');
        calls.push({ key, init, form: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null });
        const answer = routes[key];
        if (!answer) return new Response('not found', { status: 404 });
        const a = typeof answer === 'function' ? answer(init) : answer;
        const headers = { 'content-type': a.html ? 'text/html' : 'application/json', ...(a.headers || {}) };
        return new Response(a.html !== undefined ? a.html : JSON.stringify(a.json), { status: a.status || 200, headers });
    };
    return { fetcher, calls };
}

test('sign in keeps only the session cookie, then syncs both ways', async () => {
    const uid = 'reader-1';
    const site = fakeSite({
        '/tools/submit_ajax.ashx?user_login': { json: { status: 1, msg: '登录成功' }, headers: { 'set-cookie': 'my=session123; path=/; HttpOnly' } },
        '/tools/submit_ajax.ashx?user_check_login': (init) => ({ json: init.headers.Cookie === 'my=session123' ? { status: 1, username: '%E5%B0%8F%E6%98%8E', shelf: 2 } : { status: 0 } }),
        '/user/book/shelf/1': { html: shelfPage([['2', 'Two'], ['3', 'Three']], 2) },
        '/tools/submit_ajax.ashx?user_book_shelf_add': { json: { state: true, msg: '收藏成功' } }
    });
    const status = await signIn(uid, ' reader ', 'secret', site.fetcher);
    assert.deepEqual(status, { connected: true, expired: false, username: '小明', lastSync: null });
    assert.deepEqual(site.calls[0].form, { txtUserName: 'reader', txtPassword: 'secret', chkRemember: 'checked' });

    const result = await sync(uid, { library: ['mhg:1', '2'], removed: [] }, site.fetcher);
    assert.deepEqual(result.add.map((b) => b.id), ['3']);
    assert.deepEqual(result.remove, []);
    assert.deepEqual(result.shelf, { added: 1, deleted: 0, failed: 0 });
    assert.deepEqual(result.add[0].lastRead, undefined, 'last read goes in lastRead, not in the library item');
    assert.deepEqual(result.lastRead.map((r) => [r.id, r.chapter]), [['2', '2/836643'], ['3', '3/836643']]);
    assert.equal(result.previousSync, null);
    const add = site.calls.find((c) => c.key.endsWith('user_book_shelf_add'));
    assert.deepEqual(add.form, { book_id: '1' });
    assert.equal(add.init.headers.Cookie, 'my=session123');
    assert.ok(accountStatus(uid).lastSync);

    // Next time: 3 was removed in the app, 2 was removed on Manhuagui.
    const site2 = fakeSite({
        '/user/book/shelf/1': { html: shelfPage([['1', 'One'], ['3', 'Three']], 2) },
        '/tools/submit_ajax.ashx?user_book_shelf_delete': { json: { state: true } }
    });
    const second = await sync(uid, { library: ['1', '2'], removed: ['3'] }, site2.fetcher);
    assert.deepEqual(second.remove, ['2']);
    assert.deepEqual(second.add, []);
    assert.deepEqual(second.removedDone, ['3']);
    // Only titles in the library, and only last reads not seen before.
    assert.deepEqual(second.lastRead.map((r) => r.id), ['1']);
    assert.ok(second.previousSync);
    assert.deepEqual(site2.calls.find((c) => c.key.endsWith('user_book_shelf_delete')).form, { book_id: '3' });
    removeAccount(uid);
    assert.deepEqual(accountStatus(uid), { connected: false });
});

test('a session Manhuagui ended is reported and forgotten', async () => {
    const uid = 'reader-2';
    const login = fakeSite({
        '/tools/submit_ajax.ashx?user_login': { json: { status: 1 }, headers: { 'set-cookie': 'my=old; path=/' } },
        '/tools/submit_ajax.ashx?user_check_login': { json: { status: 1, username: 'r2' } }
    });
    await signIn(uid, 'r2', 'pw', login.fetcher);
    const site = fakeSite({ '/user/book/shelf/1': { status: 302, html: '', headers: { location: '/user/login' } } });
    await assert.rejects(sync(uid, { library: [] }, site.fetcher), { code: 'manhuagui/signed-out' });
    assert.deepEqual(accountStatus(uid), { connected: false, expired: true, username: 'r2', lastSync: null });
    assert.deepEqual(await sync(uid, { library: [] }, site.fetcher), { connected: false, expired: true, username: 'r2' });
});

test('a wrong password is Manhuagui\'s message, nothing stored', async () => {
    const site = fakeSite({ '/tools/submit_ajax.ashx?user_login': { json: { status: 0, msg: '用户名或密码错误' } } });
    await assert.rejects(signIn('reader-3', 'r3', 'bad', site.fetcher), { code: 'manhuagui/login-failed', message: 'Manhuagui: 用户名或密码错误' });
    assert.deepEqual(accountStatus('reader-3'), { connected: false });
});

test('titles added or removed in the app change the shelf directly, without reading it', async () => {
    const uid = 'reader-4';
    const login = fakeSite({
        '/tools/submit_ajax.ashx?user_login': { json: { status: 1 }, headers: { 'set-cookie': 'my=s4; path=/' } },
        '/tools/submit_ajax.ashx?user_check_login': { json: { status: 1, username: 'r4' } }
    });
    await signIn(uid, 'r4', 'pw', login.fetcher);
    const site = fakeSite({
        '/tools/submit_ajax.ashx?user_book_shelf_add': { json: { state: true } },
        // "Not on the shelf" answered as a failure: the check says it is gone, so it counts.
        '/tools/submit_ajax.ashx?user_book_shelf_delete': { json: { state: false, msg: '书架中不存在' } },
        '/tools/submit_ajax.ashx?user_book_shelf_check': { json: { status: 0, total: 5 } }
    });
    const r = await change(uid, { add: ['7'], remove: ['8'] }, site.fetcher);
    assert.deepEqual(r.shelf, { added: 1, deleted: 1, failed: 0 });
    assert.deepEqual(r.removedDone, ['8']);
    assert.ok(!site.calls.some((c) => c.key.startsWith('/user/book/shelf')), 'no shelf read');
    assert.deepEqual(site.calls.map((c) => c.key.split('?')[1]), ['user_book_shelf_delete', 'user_book_shelf_check', 'user_book_shelf_add']);

    // A chapter opened in the reader is reported like Manhuagui's own reader does it...
    const counter = fakeSite({ '/tools/count.ashx': { html: '' } });
    assert.deepEqual(await read(uid, { chapter: '7/123' }, counter.fetcher), { connected: true, username: 'r4' });
    const call = counter.calls[0];
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Referer, 'https://www.manhuagui.com/comic/7/123.html');
    await assert.rejects(read(uid, { chapter: '7' }, counter.fetcher), { code: 'invalid-argument' });
    // ...so the next sync does not hand that read back as one made on Manhuagui.
    const shelf = fakeSite({ '/user/book/shelf/1': { html: shelfPage([['7', 'Seven']], 1).replace('/comic/7/836643.html', '/comic/7/123.html') } });
    const after = await sync(uid, { library: ['7'] }, shelf.fetcher);
    assert.deepEqual(after.lastRead, []);
});
