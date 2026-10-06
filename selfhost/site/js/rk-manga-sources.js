/*
 * Self-hosted ReKindle: adds Manhuagui (漫画柜) as a second source to the Manga app,
 * and for both sources page/chapter preloading, a chapter picker and pages
 * prepared for e-ink (see "page display").
 *
 * manga.html itself is unchanged (MangaDex keeps working as before). This script
 * adds a "Source" picker to the Store tab and takes over the store, reader and
 * chapter loading only for Manhuagui titles, using this server's /__rk/manga API
 * (a port of the keiyoushi Mihon extension).
 *
 * Plain ES5 so the lite/legacy builds can run it.
 */
(function () {
    'use strict';

    if (typeof loadStore !== 'function' || typeof openReader !== 'function' || typeof loadChapter !== 'function') {
        if (window.console) console.warn('[manga] Manhuagui add-on: manga.html changed upstream; add-on disabled.');
        return;
    }

    var SOURCE_KEY = 'rk_manga_source';
    var PREFIX = 'mhg:';
    var mhgPage = 1;
    var mhgLoading = false;

    // ------------------------------------------------------------ server calls

    // The Manga page does not load the account library, so read the saved
    // ReKindle session directly (same storage the backend client uses).
    function getToken() {
        var raw = null;
        try { raw = localStorage.getItem('rk_auth:[DEFAULT]'); } catch (e) { raw = null; }
        if (!raw) return Promise.resolve(null);
        var s;
        try { s = JSON.parse(raw); } catch (e) { return Promise.resolve(null); }
        if (!s || !s.refreshToken) return Promise.resolve(null);
        if (s.idToken && s.exp && s.exp - 60000 > Date.now()) return Promise.resolve(s.idToken);
        return fetch('/__rk/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: s.refreshToken })
        }).then(function (r) { return r.json(); }).then(function (res) {
            if (!res || !res.idToken) return null;
            var payload = {};
            try { payload = JSON.parse(atob(res.idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { payload = {}; }
            s.idToken = res.idToken;
            s.exp = (payload.exp || 0) * 1000;
            if (res.user) s.user = res.user;
            try { localStorage.setItem('rk_auth:[DEFAULT]', JSON.stringify(s)); } catch (e) { }
            return res.idToken;
        }, function () { return null; });
    }

    function api(path) {
        return getToken().then(function (token) {
            if (!token) throw new Error('Sign in to ReKindle (Settings or the home screen) to use Manhuagui.');
            return fetch('/__rk/manga/manhuagui/' + path, { headers: { Authorization: 'Bearer ' + token } });
        }).then(function (r) {
            return r.json().then(function (data) {
                if (!r.ok || data.error) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
                return data;
            });
        });
    }

    function isMhg(item) {
        return !!item && (item.source === 'manhuagui' || String(item.id || '').indexOf(PREFIX) === 0);
    }

    function currentSource() {
        var sel = document.getElementById('rk-source-select');
        return sel ? sel.value : 'mangadex';
    }

    // ------------------------------------------------------------ store controls

    function el(tag, attrs, text) {
        var e = document.createElement(tag);
        for (var k in attrs) if (attrs.hasOwnProperty(k)) e.setAttribute(k, attrs[k]);
        if (text !== undefined) e.appendChild(document.createTextNode(text));
        return e;
    }

    var SELECT_STYLE = 'border: 2px solid black; padding: 4px 6px; font-family: inherit; font-size: 0.8rem; background: white; outline: none;';

    // Styles for the source buttons and the chapter picker (scoped ids/classes;
    // no flex gap, no transitions: Kindle rules in AGENTS.md).
    function addStyle() {
        if (document.getElementById('rk-manga-style')) return;
        var css =
            '.rk-source-btn{min-height:48px;border:2px solid #000;background:#fff;color:#000;box-shadow:2px 2px 0 #000;' +
            'font-family:inherit;font-size:0.95rem;font-weight:bold;cursor:pointer;padding:6px 8px;}' +
            '.rk-source-btn.active{background:#000;color:#fff;box-shadow:none;}' +
            '#chapter-select-wrapper .custom-select-container,#chapter-select-wrapper select{display:none !important;}' +
            '#rk-ch-btn{border:2px solid #000;background:#fff;color:#000;box-shadow:1px 1px 0 #000;font-family:inherit;' +
            'font-size:0.75rem;font-weight:bold;padding:3px 8px;max-width:180px;overflow:hidden;white-space:nowrap;' +
            'text-overflow:ellipsis;cursor:pointer;vertical-align:middle;}' +
            '#rk-ch-btn.open{background:#000;color:#fff;}' +
            '#rk-mobi-btn{border:2px solid #000;background:#fff;color:#000;box-shadow:1px 1px 0 #000;font-family:inherit;' +
            'font-size:0.75rem;font-weight:bold;padding:3px 6px;margin-left:6px;cursor:pointer;vertical-align:middle;}' +
            '#rk-mobi-btn[disabled]{color:#999;border-color:#999;box-shadow:none;cursor:default;}' +
            '#rk-ch-panel{position:absolute;top:0;left:0;right:0;bottom:0;z-index:50;background:#fff;display:flex;flex-direction:column;}' +
            '#rk-ch-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:2px solid #000;flex-shrink:0;font-weight:bold;}' +
            '#rk-ch-close{min-width:48px;min-height:40px;border:2px solid #000;background:#fff;box-shadow:2px 2px 0 #000;font-family:inherit;font-weight:bold;cursor:pointer;}' +
            '#rk-ch-cols{flex:1 1 auto;min-height:0;display:grid;grid-template-rows:minmax(0,1fr);}' +
            '.rk-ch-col{display:flex;flex-direction:column;min-height:0;}' +
            '.rk-ch-col+.rk-ch-col{border-left:2px solid #000;}' +
            '.rk-ch-col-title{padding:6px 10px;border-bottom:1px solid #000;font-weight:bold;background:#eee;flex-shrink:0;}' +
            '.rk-ch-list{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;}' +
            '.rk-ch-item{padding:12px 10px;border-bottom:1px solid #000;cursor:pointer;font-size:0.95rem;line-height:1.3;}' +
            '.rk-ch-item.current{background:#000;color:#fff;font-weight:bold;}' +
            // Pure white behind pages.
            '#reader-content{background:#fff;}';
        var style = el('style', { id: 'rk-manga-style' });
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
    }

    function buildControls() {
        var controls = document.getElementById('store-controls');
        if (!controls || document.getElementById('rk-source-select')) return;
        addStyle();

        // Two large buttons instead of a small drop-down; the hidden select keeps
        // the current value for currentSource().
        var sourceRow = el('div', { id: 'rk-source-row', style: 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;' });
        var sel = el('select', { id: 'rk-source-select', 'class': 'no-custom-select', style: 'display: none;' });
        sel.appendChild(el('option', { value: 'mangadex' }, 'MangaDex'));
        sel.appendChild(el('option', { value: 'manhuagui' }, '漫画柜 Manhuagui'));
        sourceRow.appendChild(sel);
        [['mangadex', 'MangaDex'], ['manhuagui', '漫画柜 Manhuagui']].forEach(function (s) {
            var b = el('button', { type: 'button', 'class': 'rk-source-btn', 'data-source': s[0] }, s[1]);
            b.onclick = function () {
                if (sel.value === s[0]) return;
                sel.value = s[0];
                sel.onchange();
            };
            sourceRow.appendChild(b);
        });
        controls.insertBefore(sourceRow, controls.firstChild);

        // Manhuagui filters, shown instead of the MangaDex category/language/sort row.
        var mhgRow = el('div', { id: 'rk-mhg-filters', style: 'display: none; grid-template-columns: 1fr 1fr; gap: 8px;' });
        var sortSel = el('select', { id: 'rk-mhg-sort', style: SELECT_STYLE });
        var genreSel = el('select', { id: 'rk-mhg-genre', style: SELECT_STYLE });
        mhgRow.appendChild(genreSel);
        mhgRow.appendChild(sortSel);
        controls.appendChild(mhgRow);
        sortSel.onchange = function () { doStoreSearch(); };
        genreSel.onchange = function () { doStoreSearch(); };
        // The same System 7 drop-downs as the MangaDex row (js/custom-select.js). They
        // watch the <select> and show its options once loadFilters() fills them.
        [genreSel, sortSel].forEach(function (s) {
            if (typeof CustomSelect !== 'function') return;
            try {
                new CustomSelect(s);
                s.dataset.customSelectInitialized = 'true';
            } catch (e) { s.style.display = ''; }
        });

        var saved = null;
        try { saved = localStorage.getItem(SOURCE_KEY); } catch (e) { saved = null; }
        if (saved === 'manhuagui') sel.value = 'manhuagui';
        sel.onchange = function () {
            try { localStorage.setItem(SOURCE_KEY, sel.value); } catch (e) { }
            applySourceUi();
            document.getElementById('store-results').innerHTML = '';
            doStoreSearch();
        };
        applySourceUi();
    }

    var filtersLoaded = false;
    function loadFilters() {
        if (filtersLoaded) return Promise.resolve();
        return api('filters').then(function (f) {
            filtersLoaded = true;
            var sortSel = document.getElementById('rk-mhg-sort');
            var genreSel = document.getElementById('rk-mhg-genre');
            sortSel.innerHTML = '';
            genreSel.innerHTML = '';
            var k;
            for (k in f.sorts) if (f.sorts.hasOwnProperty(k)) sortSel.appendChild(el('option', { value: k }, f.sorts[k]));
            for (k in f.genres) if (f.genres.hasOwnProperty(k)) genreSel.appendChild(el('option', { value: k }, f.genres[k]));
            sortSel.value = 'view';
        });
    }

    function applySourceUi() {
        var mhg = currentSource() === 'manhuagui';
        var buttons = document.querySelectorAll('.rk-source-btn');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].className = 'rk-source-btn' + (buttons[i].getAttribute('data-source') === currentSource() ? ' active' : '');
        }
        var mdRow = document.getElementById('store-category');
        mdRow = mdRow ? mdRow.parentNode : null;
        if (mdRow) mdRow.style.display = mhg ? 'none' : 'grid';
        document.getElementById('rk-mhg-filters').style.display = mhg ? 'grid' : 'none';
        var search = document.getElementById('store-search');
        if (search) search.placeholder = mhg ? '搜索漫画 / Search manga...' : (window.t ? window.t('manga.store.search', 'Search manga...') : 'Search manga...');
    }

    // ------------------------------------------------------------ store

    function renderCards(items, container) {
        items.forEach(function (m) {
            var id = PREFIX + m.id;
            var isAdded = library.some(function (it) { return it.id === id; });
            var card = document.createElement('div');
            card.className = 'card';
            card.innerHTML =
                '<img src="' + (m.cover || '') + '" class="cover-img">' +
                '<div class="book-title">' + escapeHtml(m.title) + '</div>' +
                '<div class="book-author">' + escapeHtml(m.subtitle || '') + '</div>';
            var btn = document.createElement('button');
            btn.className = 'btn';
            btn.style.marginTop = 'auto';
            if (isAdded) {
                btn.innerText = (window.t && window.t('manga.msg.added')) || 'Added';
                btn.disabled = true;
            } else {
                btn.innerText = (window.t && window.t('manga.btn.add')) || '+ Add';
                btn.onclick = function (e) {
                    e.stopPropagation();
                    addToLibrary({ id: id, source: 'manhuagui', title: m.title, cover: m.cover, type: 'manga', author: '漫画柜' });
                    btn.innerText = (window.t && window.t('manga.msg.added')) || 'Added';
                    btn.disabled = true;
                };
            }
            card.appendChild(btn);
            container.appendChild(card);
        });
    }

    function loadMhgStore(page) {
        if (mhgLoading) return;
        mhgLoading = true;
        var container = document.getElementById('store-results');
        if (page === 1) container.innerHTML = '';
        showStatus('Loading Manhuagui...');
        var q = (document.getElementById('store-search').value || '').trim();
        loadFilters().then(function () {
            var sort = document.getElementById('rk-mhg-sort').value;
            var genre = document.getElementById('rk-mhg-genre').value;
            return api('list?page=' + page + '&q=' + encodeURIComponent(q) + '&sort=' + encodeURIComponent(sort) + '&genre=' + encodeURIComponent(genre));
        }).then(function (data) {
            // The reader may have switched back to MangaDex while this was loading.
            if (currentSource() !== 'manhuagui') return;
            if (!data.items.length && page === 1) {
                container.innerHTML = '<div style="grid-column: 1/-1; text-align: center;">No results.</div>';
            }
            renderCards(data.items, container);
            if (data.hasNext) {
                var more = document.createElement('button');
                more.className = 'btn';
                more.style.gridColumn = '1/-1';
                more.style.marginTop = '20px';
                more.innerText = 'Load More';
                more.onclick = function () { more.parentNode.removeChild(more); mhgPage++; loadMhgStore(mhgPage); };
                container.appendChild(more);
            }
            showStatus((window.t && window.t('manga.msg.ready')) || 'Ready');
        })['catch'](function (e) {
            if (currentSource() !== 'manhuagui') return;
            showStatus('Manhuagui: ' + e.message);
            if (page === 1) container.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: red;">' + escapeHtml(e.message) + '</div>';
        }).then(function () { mhgLoading = false; });
    }

    var originalLoadStore = loadStore;
    loadStore = function (offset) {
        if (currentSource() !== 'manhuagui') return originalLoadStore.apply(this, arguments);
        mhgPage = 1;
        loadMhgStore(1);
    };

    var originalDoStoreSearch = doStoreSearch;
    doStoreSearch = function () {
        if (currentSource() !== 'manhuagui') return originalDoStoreSearch.apply(this, arguments);
        mhgPage = 1;
        loadMhgStore(1);
    };

    // ------------------------------------------------------------ reader

    function populateChapterSelect(chapters) {
        var chapterSelect = document.getElementById('chapter-select');
        chapterSelect.innerHTML = '';
        chapters.forEach(function (ch, idx) {
            var opt = document.createElement('option');
            opt.value = idx;
            opt.innerText = ch.attributes.title || ('Part ' + (idx + 1));
            chapterSelect.appendChild(opt);
        });
        chapterSelect.value = currentChapterIndex;
        var existing = chapterSelect.parentNode.querySelector('.custom-select-container');
        if (existing) existing.parentNode.removeChild(existing);
        delete chapterSelect.dataset.customSelectInitialized;
        try {
            new CustomSelect(chapterSelect);
        } catch (e) {
            chapterSelect.style.display = 'inline-block';
            chapterSelect.style.border = '2px solid black';
            chapterSelect.style.maxWidth = '140px';
        }
        document.getElementById('chapter-select-wrapper').style.display = 'inline-block';
    }

    var originalOpenReader = openReader;
    openReader = function (item) {
        closeChapterPicker();
        if (!isMhg(item)) return originalOpenReader.apply(this, arguments);
        // Work on a copy so page lists never end up saved in the library.
        currentReading = {};
        for (var key in item) if (item.hasOwnProperty(key) && key !== 'pages' && key !== 'loadedOnce') currentReading[key] = item[key];
        currentReading.loadedOnce = false;
        isReaderOpen = true;
        document.getElementById('reader-view').style.display = 'flex';
        document.getElementById('view-library').style.display = 'none';
        document.getElementById('view-store').style.display = 'none';
        document.getElementById('back-btn').style.display = 'block';
        document.querySelector('.tabs').style.display = 'none';
        document.getElementById('app-title').innerText = item.title;
        document.getElementById('language-select-wrapper').style.display = 'none';

        var content = document.getElementById('reader-content');
        content.innerHTML = '<div style="padding: 20px;">Fetching chapters...</div>';

        var mangaId = String(item.id).substring(PREFIX.length);
        return api('details?id=' + encodeURIComponent(mangaId)).then(function (d) {
            if (!d.chapters.length) {
                content.innerHTML = '<div style="padding: 20px;">No chapters found.</div>';
                return;
            }
            // Shape chapters like MangaDex ones so manga.html's paging and progress code works unchanged.
            currentChapterList = d.chapters.map(function (c) {
                return { id: c.id, attributes: { chapter: '', title: (c.section ? c.section + ' ' : '') + c.name, pages: c.pages || 1 } };
            });
            return getProgress(item.id).then(function (saved) {
                currentChapterIndex = (saved && saved.chapter) || 0;
                if (currentChapterIndex >= currentChapterList.length) currentChapterIndex = 0;
                populateChapterSelect(currentChapterList);
                return loadChapter(currentChapterIndex);
            });
        })['catch'](function (e) {
            content.innerHTML = '<div style="padding: 20px; color: red;">Error: ' + escapeHtml(e.message) + '</div>';
        });
    };

    // ------------------------------------------------------------ chapter picker
    //
    // The chapter drop-down (the site-wide custom select) is 200 px tall and fiddly
    // on e-ink. For both sources, a button takes its place and opens a panel over
    // the reader that reaches the bottom of the window. Manhuagui titles that have
    // both chapters (回/话) and volumes (卷) get one column for each. The hidden
    // <select id="chapter-select"> stays the source of truth, so manga.html's own
    // chapter code keeps working.

    var VOLUME_RE = /卷|单行本|單行本/;
    var SECTION_PREFIX = /^(单话|單話|单行本|單行本)\s+/;

    function chapterOptions() {
        var select = document.getElementById('chapter-select');
        var out = [];
        if (!select) return out;
        for (var i = 0; i < select.options.length; i++) {
            out.push({ idx: parseInt(select.options[i].value, 10), text: select.options[i].text || select.options[i].innerText || '' });
        }
        return out;
    }

    function shortName(text) {
        return String(text || '').replace(SECTION_PREFIX, '');
    }

    function syncChapterButton(idx) {
        var wrap = document.getElementById('chapter-select-wrapper');
        if (!wrap) return;
        addStyle();
        var btn = document.getElementById('rk-ch-btn');
        if (!btn) {
            btn = el('button', { id: 'rk-ch-btn', type: 'button', title: 'Chapters' });
            btn.onclick = function (e) {
                e.stopPropagation();
                if (document.getElementById('rk-ch-panel')) closeChapterPicker();
                else openChapterPicker();
            };
            wrap.appendChild(btn);
        }
        if (!document.getElementById('rk-mobi-btn')) {
            var mobi = el('button', { id: 'rk-mobi-btn', type: 'button', title: 'Download this chapter as a MOBI book' });
            mobi.textContent = 'MOBI';
            mobi.onclick = function (e) { e.stopPropagation(); downloadMobi(); };
            wrap.appendChild(mobi);
        }
        var opts = chapterOptions();
        var cur = null;
        for (var i = 0; i < opts.length; i++) if (opts[i].idx === idx) cur = opts[i];
        btn.textContent = cur ? shortName(cur.text) : 'Chapters';
    }

    // The current chapter as one MOBI book: the Kindle browser downloads only MOBI, AZW,
    // PRC and TXT. The server packs the pages into a comic archive and has Calibre make
    // the MOBI (selfhost/server/src/manga-mobi.js); that takes a while, so this checks
    // on the job every few seconds and opens the file when it is ready. The status line
    // only changes when the step does (changing text redraws the whole e-ink screen).
    var mobiBusy = false;

    function downloadMobi() {
        if (mobiBusy) return;
        if (!currentReading || !currentReading.pages || !currentReading.pages.length) {
            showStatus('Open a chapter first.');
            return;
        }
        var btn = document.getElementById('rk-mobi-btn');
        var opts = chapterOptions(), chapter = '';
        for (var i = 0; i < opts.length; i++) if (opts[i].idx === currentChapterIndex) chapter = shortName(opts[i].text);
        var title = (currentReading.title || 'Manga') + (chapter ? ' - ' + chapter : '');
        var done = function (message) {
            mobiBusy = false;
            if (btn) btn.disabled = false;
            if (message) showStatus(message);
        };
        var json = function (r) {
            return r.json().then(function (d) {
                if (!r.ok || d.error) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
                return d;
            });
        };
        var shown = '';
        var say = function (text) { if (text !== shown) { shown = text; showStatus(text); } };
        var follow = function (id) {
            fetch('/__rk/manga/mobi/' + encodeURIComponent(id)).then(json).then(function (j) {
                if (j.status === 'ready') {
                    done('Downloading ' + j.name + (j.missing ? ' (' + j.missing + ' pages could not be fetched)' : ''));
                    window.location.href = j.href;
                    return;
                }
                if (j.status === 'failed') return done(j.message);
                say(j.step === 'convert' ? 'Making the MOBI...' : 'Getting the pages for the MOBI...');
                setTimeout(function () { follow(id); }, 3000);
            }, function (e) { done('MOBI failed: ' + e.message); });
        };
        mobiBusy = true;
        if (btn) btn.disabled = true;
        say('Getting the pages for the MOBI...');
        fetch('/__rk/manga/mobi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, pages: currentReading.pages })
        }).then(json).then(function (d) { follow(d.id); }, function (e) { done('MOBI failed: ' + e.message); });
    }

    function closeChapterPicker() {
        var panel = document.getElementById('rk-ch-panel');
        if (panel) panel.parentNode.removeChild(panel);
        var btn = document.getElementById('rk-ch-btn');
        if (btn) btn.className = '';
    }

    function openChapterPicker() {
        var view = document.getElementById('reader-view');
        var opts = chapterOptions();
        if (!view || !opts.length) return;
        closeChapterPicker();

        var chapters = [], volumes = [];
        opts.forEach(function (o) { (VOLUME_RE.test(o.text) ? volumes : chapters).push(o); });
        var columns = chapters.length && volumes.length
            ? [['回', chapters], ['卷', volumes]]
            : [[volumes.length ? '卷' : 'Chapters', volumes.length ? volumes : chapters]];

        var panel = el('div', { id: 'rk-ch-panel' });
        var head = el('div', { id: 'rk-ch-head' });
        head.appendChild(el('span', {}, 'Chapters (' + opts.length + ')'));
        var close = el('button', { id: 'rk-ch-close', type: 'button' }, 'Close');
        close.onclick = closeChapterPicker;
        head.appendChild(close);
        panel.appendChild(head);


        var cols = el('div', { id: 'rk-ch-cols', style: 'grid-template-columns: repeat(' + columns.length + ', minmax(0, 1fr));' });
        var currentItems = [];
        columns.forEach(function (c) {
            var col = el('div', { 'class': 'rk-ch-col' });
            col.appendChild(el('div', { 'class': 'rk-ch-col-title' }, c[0] + ' (' + c[1].length + ')'));
            var list = el('div', { 'class': 'rk-ch-list' });
            c[1].forEach(function (o) {
                var item = el('div', { 'class': 'rk-ch-item' + (o.idx === currentChapterIndex ? ' current' : ''), 'data-idx': String(o.idx) }, shortName(o.text));
                if (o.idx === currentChapterIndex) currentItems.push(item);
                list.appendChild(item);
            });
            col.appendChild(list);
            cols.appendChild(col);
        });
        cols.onclick = function (e) {
            var t = e.target;
            while (t && t !== cols && !(t.className && /rk-ch-item/.test(t.className))) t = t.parentNode;
            if (!t || t === cols) return;
            closeChapterPicker();
            loadChapter(parseInt(t.getAttribute('data-idx'), 10));
        };
        panel.appendChild(cols);
        view.appendChild(panel);
        document.getElementById('rk-ch-btn').className = 'open';
        // Show the current chapter a third of the way down its column.
        currentItems.forEach(function (item) {
            item.parentNode.scrollTop = Math.max(0, item.offsetTop - item.parentNode.offsetTop - item.parentNode.clientHeight / 3);
        });
    }

    if (typeof closeReader === 'function') {
        var originalCloseReader = closeReader;
        closeReader = function () {
            closeChapterPicker();
            return originalCloseReader.apply(this, arguments);
        };
    }

    // ------------------------------------------------------------ preloading
    //
    // For both sources: once the visible page has loaded, fetch the next pages in
    // the background, and near the end of a chapter fetch the next chapter's page
    // list and first pages, so page turns and chapter changes are instant.
    // Kept to a small window because e-readers have little memory.
    // Set localStorage 'rk_manga_preload' to '0' to turn it off.

    var PRELOAD_AHEAD = 2;
    var PAGE_LIST_TTL = 10 * 60000; // MangaDex@Home links expire after ~15 minutes
    var pageLists = {};             // source|chapterId -> { pages, t } or { pending }
    var preloaded = [];             // keep Image objects alive while they load

    function preloadEnabled() {
        try { return localStorage.getItem('rk_manga_preload') !== '0'; } catch (e) { return true; }
    }

    function chapterKey(ch) {
        return (isMhg(currentReading) ? 'mhg|' : 'md|') + ch.id;
    }

    function cachedPages(ch) {
        var hit = ch && pageLists[chapterKey(ch)];
        return hit && hit.pages && (Date.now() - hit.t < PAGE_LIST_TTL) ? hit.pages : null;
    }

    // Page image URLs for a chapter, built the same way manga.html builds them.
    function fetchChapterPages(ch) {
        var key = chapterKey(ch);
        var fresh = cachedPages(ch);
        if (fresh) return Promise.resolve(fresh);
        if (pageLists[key] && pageLists[key].pending) return pageLists[key].pending;
        var p;
        if (isMhg(currentReading)) {
            p = api('pages?chapter=' + encodeURIComponent(ch.id)).then(function (d) { return d.pages; });
        } else {
            if (ch.attributes && ch.attributes.pages === 0 && ch.attributes.externalUrl) return Promise.reject(new Error('External chapter'));
            p = fetchCORS(API_BASE + '/at-home/server/' + ch.id).then(function (r) { return r.json(); }).then(function (data) {
                return (data.chapter.data || []).map(function (file) {
                    return '/api/proxy?url=' + encodeURIComponent(data.baseUrl + '/data/' + data.chapter.hash + '/' + file);
                });
            });
        }
        pageLists[key] = { pending: p };
        return p.then(function (pages) {
            pageLists[key] = { pages: pages, t: Date.now() };
            return pages;
        }, function (e) {
            delete pageLists[key];
            throw e;
        });
    }

    // Pages are served with Cache-Control: no-store (see "page display" below), so
    // the preloaded <img> elements themselves are what the reader shows.
    function preloadImage(url) {
        for (var i = 0; i < preloaded.length; i++) if (preloaded[i].src === absolute(url)) return preloaded[i];
        var img = new Image();
        img.src = url;
        preloaded.push(img);
        return img;
    }

    // The last pages shown stay in memory too, so going back a page is instant.
    var RECENT_KEEP = 2;
    var recent = [];

    function takePreloaded(url) {
        var lists = [preloaded, recent];
        for (var l = 0; l < lists.length; l++) {
            for (var i = 0; i < lists[l].length; i++) {
                if (lists[l][i].src === absolute(url)) return lists[l].splice(i, 1)[0];
            }
        }
        return null;
    }

    function remember(img) {
        recent.unshift(img);
        if (recent.length > RECENT_KEEP) recent.length = RECENT_KEEP;
    }

    function preloadAhead() {
        if (!preloadEnabled() || !currentReading || !currentReading.pages) return;
        var reading = currentReading;
        var pages = reading.pages;
        var page = currentPage;
        var chapterIndex = currentChapterIndex;
        // Keep only this window: earlier pages are not needed again.
        var keep = [];
        for (var i = 1; i <= PRELOAD_AHEAD; i++) {
            if (pages[page + i]) keep.push(preloadImage(pageSrc(pages[page + i])));
        }
        preloaded = keep;
        var next = currentChapterList[chapterIndex + 1];
        if (next && page >= pages.length - 1 - PRELOAD_AHEAD) {
            fetchChapterPages(next).then(function (nextPages) {
                if (currentReading !== reading || currentChapterIndex !== chapterIndex || currentPage !== page) return;
                var room = PRELOAD_AHEAD - (pages.length - 1 - page);
                for (var j = 0; j < room && j < nextPages.length; j++) preloadImage(pageSrc(nextPages[j]));
            }, function () { /* the normal chapter load will report problems */ });
        }
    }

    // Show a chapter whose page list is already known.
    function showChapterPages(chapterIndex, pages) {
        currentReading.pages = pages;
        var finish = function () {
            isLoadingNextChapter = false;
            updateMangaPage();
        };
        if (!currentReading.loadedOnce) {
            return getProgress(currentReading.id).then(function (saved) {
                currentPage = (saved && saved.page) || 0;
                if (currentPage >= pages.length) currentPage = 0;
                currentReading.loadedOnce = true;
                finish();
            });
        }
        currentPage = 0;
        finish();
        return Promise.resolve();
    }

    var originalLoadChapter = loadChapter;
    loadChapter = function (chapterIndex) {
        if (chapterIndex < 0 || chapterIndex >= currentChapterList.length) return Promise.resolve();
        closeChapterPicker();
        syncChapterButton(chapterIndex);
        var ch = currentChapterList[chapterIndex];
        var ready = cachedPages(ch);
        if (!isMhg(currentReading) && !ready) {
            // MangaDex chapter not preloaded yet: manga.html's own loader.
            return originalLoadChapter.apply(this, arguments);
        }
        isLoadingNextChapter = true;
        currentChapterIndex = chapterIndex;
        var chapterSelect = document.getElementById('chapter-select');
        if (chapterSelect) chapterSelect.value = chapterIndex;
        if (ready && ready.length) return showChapterPages(chapterIndex, ready);

        var content = document.getElementById('reader-content');
        content.innerHTML = '<div style="padding: 20px;">Fetching ' + escapeHtml(ch.attributes.title) + ' (' + (chapterIndex + 1) + ' of ' + currentChapterList.length + ')...</div>';
        return fetchChapterPages(ch).then(function (pages) {
            if (!pages.length) {
                content.innerHTML = '<div style="padding: 20px;">No pages found in this chapter.</div>';
                isLoadingNextChapter = false;
                return;
            }
            return showChapterPages(chapterIndex, pages);
        })['catch'](function (e) {
            content.innerHTML = '<div style="padding: 20px; color: red;">Error: ' + escapeHtml(e.message) + '</div>';
            isLoadingNextChapter = false;
        });
    };

    // ------------------------------------------------------------ page display
    //
    // Page turns work as in manga.html: the reader goes blank (white) at once and
    // the page appears when it has loaded. The owner tried a straight page-to-page
    // swap and a blank drawn together with the page (2026-10-05) and preferred this.
    //
    // Pages are the original images, passed through this server (server/src/images.js)
    // unchanged, only marked Cache-Control: no-store: the Kindle deletes the browser's
    // whole data folder (sign-in, the Manga library and progress) when it passes
    // 64 MB, and cached manga pages (up to 2 MB each) used to fill it.

    var showSeq = 0;

    function absolute(url) {
        var a = document.createElement('a');
        a.href = url;
        return a.href;
    }

    // The page URL to show: MangaDex pages come as /api/proxy links (manga.html),
    // Manhuagui ones as this server's signed /__rk/manga/img links.
    function pageSrc(url) {
        if (!url) return url;
        var m = /^\/api\/proxy\?url=([^&]+)$/.exec(url);
        if (m) return '/__rk/img?url=' + m[1] + '&page=1';
        if (url.indexOf('/__rk/manga/img?') === 0) return url + '&page=1';
        return url;
    }

    function nextFrame(fn) {
        if (window.requestAnimationFrame) window.requestAnimationFrame(fn);
        else setTimeout(fn, 16);
    }

    if (typeof updateMangaPage === 'function' && typeof saveProgress === 'function') {
        updateMangaPage = function () {
            if (!currentReading || !currentReading.pages) return;
            var reading = currentReading;
            var pages = reading.pages;
            var page = currentPage;
            var chapterIndex = currentChapterIndex;
            var content = document.getElementById('reader-content');
            var seq = ++showSeq;
            var label = (page + 1) + ' / ' + pages.length;
            var src = pageSrc(pages[page]);
            var img = takePreloaded(src) || new Image();
            var current = function () {
                return seq === showSeq && currentReading === reading && isReaderOpen;
            };

            // As manga.html does it: the reader goes blank at once, the status line
            // says "Loading", and the page appears when it has loaded.
            content.innerHTML = '';
            content.scrollTop = 0;
            showStatus('Loading ' + label + '...');

            var shown = function () {
                if (!current()) return;
                showStatus(label);
                remember(img);
                preloadAhead();
            };
            var retried = false;
            var failed = function () {
                if (!current()) return;
                // MangaDex@Home nodes sometimes miss a page once; try again a
                // moment later (the server only remembers good copies).
                if (!retried) {
                    retried = true;
                    setTimeout(function () {
                        if (current()) img.src = src + '&retry=1';
                    }, 1500);
                    return;
                }
                content.innerHTML = '<div style="padding: 20px;">Could not load page ' + label + '.</div>';
                showStatus('Error loading page ' + (page + 1));
                preloadAhead();
            };
            img.className = 'reader-page';
            // A preloaded page is ready at once, so it goes in right after the frame that
            // shows the blank (a task queued from requestAnimationFrame runs once that
            // frame is painted), as the blank appeared when manga.html loaded pages from
            // the cache. Waiting two frames instead cost ~0.4 s per turn on the Kindle
            // (frames take ~300 ms there); the blank still shows every time.
            nextFrame(function () {
                setTimeout(function () {
                    if (!current()) return;
                    content.appendChild(img);
                    if (img.src && img.complete) {
                        if (img.naturalWidth) shown();
                        else failed();
                    }
                    img.onload = shown;
                    img.onerror = failed;
                    if (!img.src) img.src = src;
                }, 0);
            });

            // Progress, saved as manga.html saves it.
            var chapterNum = '';
            if (currentChapterList && currentChapterList[chapterIndex]) {
                chapterNum = currentChapterList[chapterIndex].attributes.chapter || '';
            }
            saveProgress(reading.id, chapterIndex, page, chapterNum);
        };
    }

    // ------------------------------------------------------------ library in the database
    //
    // manga.html keeps the library and reading progress only in the browser
    // (localforage: manga_library, manga_progress), which the Kindle can wipe. When
    // signed in, the account's copy on this server (GET/PUT /__rk/manga/state,
    // server/src/manga-state.js) is the master: opening Manga replaces the browser's
    // copy with it before the library is drawn, and every change is sent at once.
    // Changes that could not be sent (offline) wait in localStorage rk_manga_pending,
    // tagged with the account, and go first next time. Progress entries get a time (t)
    // so the newest wins per manga. Signed out, everything stays local as before.
    // Libraries kept only in the browser before this are not uploaded (owner's choice).

    var PENDING_KEY = 'rk_manga_pending';
    var SYNC_TIMEOUT_MS = 5000;

    function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function lsSet(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch (e) { } }

    function currentUid() {
        try {
            var s = JSON.parse(lsGet('rk_auth:[DEFAULT]') || 'null');
            return (s && s.refreshToken && s.user && s.user.uid) || null;
        } catch (e) { return null; }
    }

    function withTimeout(promise) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error('timeout')); }, SYNC_TIMEOUT_MS);
            promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
        });
    }

    function stateApi(method, body) {
        return getToken().then(function (token) {
            if (!token) throw new Error('signed out');
            var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
            if (body) {
                init.headers['Content-Type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            return fetch('/__rk/manga/state', init);
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    // { owner, library: true (send the current library), progress: { id: entry } }
    function readPending() {
        try { return JSON.parse(lsGet(PENDING_KEY) || 'null') || {}; } catch (e) { return {}; }
    }
    function writePending(p) {
        var empty = !p.library && !(p.progress && Object.keys(p.progress).length);
        lsSet(PENDING_KEY, empty ? null : JSON.stringify(p));
    }

    var flushTimer = null, flushing = false;

    function queueChange(kind, id, entry) {
        var uid = currentUid();
        if (!uid) return;  // signed out: local only
        var p = readPending();
        if (p.owner && p.owner !== uid) p = {};
        p.owner = uid;
        if (kind === 'library') p.library = true;
        else {
            p.progress = p.progress || {};
            p.progress[id] = entry;
        }
        writePending(p);
        if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flushPending(); }, 800);
    }

    function flushPending() {
        var p = readPending();
        var uid = currentUid();
        if (!p.owner || !uid || p.owner !== uid) { if (p.owner && uid && p.owner !== uid) writePending({}); return Promise.resolve(); }
        if (flushing) return Promise.resolve();
        var body = {};
        if (p.library) body.library = library;
        if (p.progress && Object.keys(p.progress).length) body.progress = p.progress;
        if (!body.library && !body.progress) return Promise.resolve();
        flushing = true;
        return withTimeout(stateApi('PUT', body)).then(function () {
            // Keep anything that changed while this was being sent.
            var now = readPending();
            if (body.library && now.library) delete now.library;
            if (body.progress && now.progress) {
                Object.keys(body.progress).forEach(function (id) {
                    if (now.progress[id] && now.progress[id].t === body.progress[id].t) delete now.progress[id];
                });
            }
            writePending(now);
        }, function () { /* offline or signed out: stays pending */ }).then(function () { flushing = false; });
    }

    // Before manga.html draws the library: send what is pending, then replace the
    // browser's copy with the account's.
    function syncFromServer() {
        if (!currentUid()) return Promise.resolve();
        return flushPending().then(function () {
            return withTimeout(stateApi('GET'));
        }).then(function (state) {
            return Promise.all([
                localforage.setItem('manga_library', state.library || []),
                localforage.setItem('manga_progress', state.progress || {})
            ]);
        })['catch'](function () { /* offline: use this device's copy */ });
    }

    if (typeof loadLibrary === 'function' && typeof saveLibrary === 'function' && typeof saveProgress === 'function' && window.localforage) {
        var originalLoadLibrary = loadLibrary;
        loadLibrary = function () {
            var self = this, args = arguments;
            return syncFromServer().then(function () { return originalLoadLibrary.apply(self, args); });
        };

        var originalSaveLibrary = saveLibrary;
        saveLibrary = function () {
            return Promise.resolve(originalSaveLibrary.apply(this, arguments)).then(function (v) {
                queueChange('library');
                return v;
            });
        };

        // Same entry manga.html saves, plus the time (t).
        saveProgress = function (mangaId, chapterIdx, pageIdx, chapterNum) {
            var entry = {
                chapter: chapterIdx,
                page: pageIdx,
                chapterNum: chapterNum || '',
                language: (typeof currentReadingLanguage !== 'undefined' && currentReadingLanguage) || 'en',
                t: Date.now()
            };
            return localforage.getItem('manga_progress').then(function (progress) {
                progress = progress || {};
                progress[mangaId] = entry;
                return localforage.setItem('manga_progress', progress);
            }).then(function () {
                queueChange('progress', mangaId, entry);
            })['catch'](function (e) {
                if (window.console) console.error('Failed to save progress:', e);
            });
        };
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildControls);
    else buildControls();
})();
