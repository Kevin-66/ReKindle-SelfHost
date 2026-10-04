/*
 * Self-hosted ReKindle: adds Manhuagui (漫画柜) as a second source to the Manga app.
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

    function buildControls() {
        var controls = document.getElementById('store-controls');
        if (!controls || document.getElementById('rk-source-select')) return;

        var sourceRow = el('div', { style: 'display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center;' });
        sourceRow.appendChild(el('label', { 'for': 'rk-source-select', style: 'font-weight: bold; font-size: 0.8rem;' }, 'Source'));
        var sel = el('select', { id: 'rk-source-select', 'class': 'no-custom-select', style: SELECT_STYLE });
        sel.appendChild(el('option', { value: 'mangadex' }, 'MangaDex'));
        sel.appendChild(el('option', { value: 'manhuagui' }, '漫画柜 Manhuagui'));
        sourceRow.appendChild(sel);
        controls.insertBefore(sourceRow, controls.firstChild);

        // Manhuagui filters, shown instead of the MangaDex category/language/sort row.
        var mhgRow = el('div', { id: 'rk-mhg-filters', style: 'display: none; grid-template-columns: 1fr 1fr; gap: 8px;' });
        var sortSel = el('select', { id: 'rk-mhg-sort', 'class': 'no-custom-select', style: SELECT_STYLE });
        var genreSel = el('select', { id: 'rk-mhg-genre', 'class': 'no-custom-select', style: SELECT_STYLE });
        mhgRow.appendChild(genreSel);
        mhgRow.appendChild(sortSel);
        controls.appendChild(mhgRow);
        sortSel.onchange = function () { doStoreSearch(); };
        genreSel.onchange = function () { doStoreSearch(); };

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

    var originalLoadChapter = loadChapter;
    loadChapter = function (chapterIndex) {
        if (!isMhg(currentReading)) return originalLoadChapter.apply(this, arguments);
        if (chapterIndex < 0 || chapterIndex >= currentChapterList.length) return Promise.resolve();
        isLoadingNextChapter = true;
        currentChapterIndex = chapterIndex;
        var chapterSelect = document.getElementById('chapter-select');
        if (chapterSelect) chapterSelect.value = chapterIndex;
        var ch = currentChapterList[chapterIndex];
        var content = document.getElementById('reader-content');
        content.innerHTML = '<div style="padding: 20px;">Fetching ' + escapeHtml(ch.attributes.title) + ' (' + (chapterIndex + 1) + ' of ' + currentChapterList.length + ')...</div>';
        return api('pages?chapter=' + encodeURIComponent(ch.id)).then(function (data) {
            if (!data.pages.length) {
                content.innerHTML = '<div style="padding: 20px;">No pages found in this chapter.</div>';
                return;
            }
            currentReading.pages = data.pages;
            if (!currentReading.loadedOnce) {
                return getProgress(currentReading.id).then(function (saved) {
                    currentPage = (saved && saved.page) || 0;
                    if (currentPage >= data.pages.length) currentPage = 0;
                    currentReading.loadedOnce = true;
                    updateMangaPage();
                });
            }
            currentPage = 0;
            updateMangaPage();
        })['catch'](function (e) {
            content.innerHTML = '<div style="padding: 20px; color: red;">Error: ' + escapeHtml(e.message) + '</div>';
        }).then(function () {
            isLoadingNextChapter = false;
            // Fetch the next page image early; e-ink browsers are slow to decode.
            if (currentReading && currentReading.pages && currentReading.pages[currentPage + 1]) {
                var pre = new Image();
                pre.src = currentReading.pages[currentPage + 1];
            }
        });
    };

    // Prefetch the following page while reading Manhuagui chapters.
    var originalUpdateMangaPage = updateMangaPage;
    updateMangaPage = function () {
        originalUpdateMangaPage.apply(this, arguments);
        if (isMhg(currentReading) && currentReading.pages && currentReading.pages[currentPage + 1]) {
            var pre = new Image();
            pre.src = currentReading.pages[currentPage + 1];
        }
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildControls);
    else buildControls();
})();
