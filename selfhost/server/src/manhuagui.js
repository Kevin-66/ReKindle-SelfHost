// Manhuagui (漫画柜) source for the Manga app.
//
// Ported from the Mihon extension in keiyoushi/extensions-source
// (src/zh/manhuagui, Apache-2.0): same URLs, selectors, chapter-list order,
// rate limits and page-list decoding. The site's packed JavaScript is decoded
// here without running it.

import crypto from 'node:crypto';
import { parseHTML } from 'linkedom';
import LZString from 'lz-string';
import { metaGet, metaSet } from './db.js';

const BASE = (process.env.MANHUAGUI_URL || 'https://www.manhuagui.com').replace(/\/+$/, '');
const IMAGE_SERVER = 'https://i.hamreus.com';
const SHOW_R18 = /^(1|true|yes|on)$/i.test(process.env.MANHUAGUI_SHOW_R18 || '');
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: `${BASE}/`
};

export class SourceError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.code = 'unavailable';
        this.status = status;
    }
}

// ---------------------------------------------------------------- rate limits

// Same defaults as the extension: 10 requests per 10 s to the site, 4 per second to the image CDN.
function limiter(count, windowMs) {
    const stamps = [];
    let chain = Promise.resolve();
    return () => {
        chain = chain.then(async () => {
            for (;;) {
                const now = Date.now();
                while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
                if (stamps.length < count) { stamps.push(now); return; }
                await new Promise((r) => setTimeout(r, windowMs - (now - stamps[0]) + 5));
            }
        });
        return chain;
    };
}
const siteSlot = limiter(10, 10000);
const imageSlot = limiter(4, 1000);

// ---------------------------------------------------------------- fetching

const cache = new Map();
const CACHE_MAX = 300;

async function getHtml(path, ttlMs) {
    const url = path.startsWith('http') ? path : BASE + path;
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.html;
    await siteSlot();
    let res;
    try {
        res = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    } catch (e) {
        throw new SourceError(`Could not reach Manhuagui (${e.message})`);
    }
    if (res.status === 404) throw new SourceError('Not found on Manhuagui', 404);
    if (!res.ok) throw new SourceError(`Manhuagui returned HTTP ${res.status}`);
    const html = await res.text();
    cache.set(url, { html, expires: Date.now() + ttlMs });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return html;
}

function doc(html) {
    return parseHTML(html).document;
}

function absUrl(src) {
    if (!src) return null;
    if (src.startsWith('//')) return 'https:' + src;
    if (src.startsWith('/')) return BASE + src;
    return src;
}

// ---------------------------------------------------------------- signed image URLs

// Images are fetched through this server (they need a manhuagui.com Referer).
// URLs are signed so the endpoint only serves images this module handed out.
function signingKey() {
    let k = metaGet('manga_image_key');
    if (!k) {
        k = crypto.randomBytes(32).toString('hex');
        metaSet('manga_image_key', k);
    }
    return k;
}
const KEY = signingKey();

function sign(url) {
    return crypto.createHmac('sha256', KEY).update(url).digest('base64url').slice(0, 22);
}

export function imageUrl(url) {
    if (!url) return null;
    return `/__rk/manga/img?u=${encodeURIComponent(Buffer.from(url).toString('base64url'))}&k=${sign(url)}`;
}

export async function proxyImage(encoded, sig) {
    let url;
    try { url = Buffer.from(String(encoded || ''), 'base64url').toString('utf8'); } catch { url = ''; }
    const expected = sign(url);
    if (!url || !sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        throw new SourceError('Invalid image link', 403);
    }
    await imageSlot();
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new SourceError(`Image server returned HTTP ${res.status}`, res.status === 404 ? 404 : 502);
    return res;
}

// ---------------------------------------------------------------- lists

function parseMangaList(document) {
    const items = [];
    for (const li of document.querySelectorAll('ul#contList > li')) {
        const a = li.querySelector('a.bcover');
        if (!a) continue;
        const img = a.querySelector('img');
        const src = img ? (img.getAttribute('src') || img.getAttribute('data-src')) : null;
        const id = (a.getAttribute('href') || '').match(/\/comic\/(\d+)/);
        if (!id) continue;
        const update = li.querySelector('span.tt');
        items.push({ id: id[1], title: a.getAttribute('title') || '', cover: imageUrl(absUrl(src)), subtitle: update ? update.textContent.trim() : '' });
    }
    return items;
}

function parseSearchList(document) {
    const items = [];
    for (const li of document.querySelectorAll('div.book-result > ul > li')) {
        const a = li.querySelector('div.book-detail dl > dt > a');
        if (!a) continue;
        const id = (a.getAttribute('href') || '').match(/\/comic\/(\d+)/);
        if (!id) continue;
        const img = li.querySelector('div.book-cover > a.bcover > img');
        const status = li.querySelector('div.book-detail dd.tags.status span span');
        items.push({
            id: id[1],
            title: a.getAttribute('title') || a.textContent.trim(),
            cover: imageUrl(absUrl(img && (img.getAttribute('src') || img.getAttribute('data-src')))),
            subtitle: status ? status.textContent.trim() : ''
        });
    }
    return items;
}

export const SORTS = { view: '人气最旺', update: '最新更新', '': '最新发布', rate: '评分最高' };
export const GENRES = {
    '': '全部', rexue: '热血', maoxian: '冒险', mohuan: '魔幻', shengui: '神鬼', gaoxiao: '搞笑', mengxi: '萌系',
    aiqing: '爱情', kehuan: '科幻', mofa: '魔法', gedou: '格斗', wuxia: '武侠', jizhan: '机战', zhanzheng: '战争',
    jingji: '竞技', tiyu: '体育', xiaoyuan: '校园', shenghuo: '生活', lizhi: '励志', lishi: '历史', weiniang: '伪娘',
    zhainan: '宅男', funv: '腐女', danmei: '耽美', baihe: '百合', hougong: '后宫', zhiyu: '治愈', meishi: '美食',
    tuili: '推理', xuanyi: '悬疑', kongbu: '恐怖', sige: '四格', zhichang: '职场', zhentan: '侦探', shehui: '社会',
    yinyue: '音乐', wudao: '舞蹈', zazhi: '杂志', heidao: '黑道'
};

// page is 1-based.
export async function list({ q, sort, genre, page }) {
    page = Math.max(1, parseInt(page, 10) || 1);
    if (q) {
        const d = doc(await getHtml(`/s/${encodeURIComponent(q)}_p${page}.html`, 5 * 60000));
        return { items: parseSearchList(d), hasNext: !!d.querySelector('span.current + a') };
    }
    const s = Object.prototype.hasOwnProperty.call(SORTS, sort || '') ? (sort || '') : 'view';
    const g = Object.prototype.hasOwnProperty.call(GENRES, genre || '') ? (genre || '') : '';
    const path = `/list${g ? '/' + g : ''}/${s || 'index'}_p${page}.html`;
    const d = doc(await getHtml(path, 10 * 60000));
    return { items: parseMangaList(d), hasNext: !!d.querySelector('span.current + a') };
}

// ---------------------------------------------------------------- details & chapters

function textOfLinksAfterLabel(document, labels) {
    for (const span of document.querySelectorAll('span')) {
        const own = span.firstChild && span.firstChild.nodeType === 3 ? span.firstChild.textContent : '';
        if (labels.some((l) => own.includes(l) || (span.textContent || '').startsWith(l))) {
            const names = [...span.querySelectorAll('a')].map((a) => a.textContent.trim()).filter(Boolean);
            if (names.length) return names.join(', ');
        }
    }
    return '';
}

export async function details(id) {
    if (!/^\d+$/.test(String(id))) throw new SourceError('Invalid manga id', 400);
    const html = await getHtml(`/comic/${id}/`, 10 * 60000);
    const d = doc(html);

    const title = (d.querySelector('div.book-title > h1') || {}).textContent || '';
    const intro = d.querySelector('div#intro-all');
    const cover = d.querySelector('p.hcover > img');
    const statusText = ((d.querySelector('div.book-detail > ul.detail-list > li.status > span > span') || {}).textContent || '').trim();
    const status = ['连载中', '連載中'].includes(statusText) ? 'ongoing' : (['已完结', '已完結'].includes(statusText) ? 'completed' : 'unknown');

    // Adult titles hide their chapter list in an LZString-compressed field.
    const hidden = d.querySelector('#__VIEWSTATE');
    let chapterDoc = d;
    if (hidden) {
        if (!SHOW_R18) throw new SourceError('This title is marked R18 on Manhuagui and is hidden on this server (set MANHUAGUI_SHOW_R18=true to allow).', 403);
        const decoded = LZString.decompressFromBase64(hidden.getAttribute('value') || '') || '';
        chapterDoc = doc(`<html><body>${html}${decoded}</body></html>`);
    }

    // Each section (单行本 / 单话 / 番外篇) is a #chapter-list-N with several <ul>
    // blocks in ascending order, each listing its chapters newest-first.
    const chapters = [];
    const sections = [...chapterDoc.querySelectorAll('[id^=chapter-list-]')];
    for (const section of sections) {
        let label = '';
        for (let el = section.previousElementSibling; el; el = el.previousElementSibling) {
            if (el.tagName === 'H4') { label = el.textContent.trim(); break; }
        }
        for (const ul of section.querySelectorAll('ul')) {
            const links = [...ul.querySelectorAll('li > a.status0')].reverse();
            for (const a of links) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/\/comic\/(\d+)\/(\d+)\.html/);
                if (!m) continue;
                const span = a.querySelector('span');
                const name = a.getAttribute('title') || (span ? span.firstChild.textContent : a.textContent).trim();
                const pages = span && span.querySelector('i') ? parseInt(span.querySelector('i').textContent, 10) || null : null;
                chapters.push({ id: `${m[1]}/${m[2]}`, name, section: sections.length > 1 ? label : '', pages });
            }
        }
    }

    return {
        id: String(id),
        title: title.trim(),
        cover: imageUrl(absUrl(cover && cover.getAttribute('src'))),
        author: textOfLinksAfterLabel(d, ['漫画作者', '漫畫作者']),
        genres: textOfLinksAfterLabel(d, ['漫画剧情', '漫畫劇情']),
        description: intro ? intro.textContent.trim() : '',
        status,
        url: `${BASE}/comic/${id}/`,
        chapters
    };
}

// ---------------------------------------------------------------- pages

// Dean Edwards "p,a,c,k,e,d" unpacker, without eval.
function unbase(word, radix) {
    const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (radix <= 36) return parseInt(word, radix);
    let n = 0;
    for (const ch of word) {
        const v = ALPHA.indexOf(ch);
        if (v < 0 || v >= radix) return NaN;
        n = n * radix + v;
    }
    return n;
}

export function unpack(code) {
    const m = code.match(/\}\s*\(\s*'([\s\S]*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*?)'\.split\('\|'\)/);
    if (!m) throw new SourceError('Could not decode the chapter (unexpected page format)');
    const payload = m[1];
    const radix = parseInt(m[2], 10);
    const symtab = m[4].split('|');
    return payload.replace(/\b\w+\b/g, (w) => {
        const i = unbase(w, radix);
        return Number.isFinite(i) && i < symtab.length && symtab[i] ? symtab[i] : w;
    });
}

export function decodePageList(html) {
    const packed = html.match(/window\[".*?"\](\(.*\)\s*\{[\s\S]+\}\s*\(.*\))/);
    if (!packed) throw new SourceError('Could not find the image list on this chapter page');
    const code = packed[1].replace(/['"]([0-9A-Za-z+/=]+)['"]\[['"].*?['"]\]\(['"].*?['"]\)/g, (_, lzs) => {
        const decoded = LZString.decompressFromBase64(lzs) || '';
        return `'${decoded}'.split('|')`;
    });
    const unpacked = unpack(code.replace(/\\'/g, '-'));
    const json = unpacked.match(/\{.*\}/);
    if (!json) throw new SourceError('Could not read the image list for this chapter');
    const comic = JSON.parse(json[0]);
    const sl = comic.sl || {};
    return (comic.files || []).map((f) => `${IMAGE_SERVER}${comic.path || ''}${f}?e=${sl.e}&m=${sl.m}`);
}

export async function pages(chapterId) {
    const m = String(chapterId || '').match(/^(\d+)\/(\d+)$/);
    if (!m) throw new SourceError('Invalid chapter id', 400);
    // Image links carry a short-lived signature, so cache only briefly.
    const html = await getHtml(`/comic/${m[1]}/${m[2]}.html`, 5 * 60000);
    if (!SHOW_R18 && /id=['"]erroraudit_show['"]/.test(html)) {
        throw new SourceError('This chapter is marked R18 on Manhuagui and is hidden on this server.', 403);
    }
    return { pages: decodePageList(html).map(imageUrl) };
}
