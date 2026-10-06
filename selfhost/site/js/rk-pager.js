// Self-hosted ReKindle: Page Up / Page Down buttons on every page that scrolls.
// Kindle Scribe and most e-readers have no page-turn keys, and scrolling by swipe
// smears on e-ink, so these move the page's main scrolling area one screen at a
// time. Added to every page by selfhost/server/src/transform.js; switched on/off in
// Settings > Accessibility ("Page Buttons", localStorage rk_page_buttons = '0' off).
// Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var KEY = 'rk_page_buttons';

    // Also keep the choice with the account (users/{uid}/settings/general, where
    // Settings saves its own options) and signal the change, so the home screen copies
    // it into other devices and back after the Kindle wipes its browser data.
    function saveToAccount(field, value) {
        try {
            if (!window.firebase || !firebase.apps || !firebase.apps.length) return;
            var user = firebase.auth().currentUser;
            if (!user) return;
            var update = {};
            update[field] = value;
            var userRef = firebase.firestore().collection('users').doc(user.uid);
            userRef.collection('settings').doc('general').set(update, { merge: true }).then(function () {
                return userRef.set({ settingsLastUpdated: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
            })['catch'](function () { });
        } catch (e) { }
    }
    var BTN = 52;      // button size (px), above the 48 px touch minimum
    var MARGIN = 12;   // gap from the scrolling area's edges
    var THROTTLE = 1500;

    function enabled() {
        try { return localStorage.getItem(KEY) !== '0'; } catch (e) { return true; }
    }

    var bar = null, up = null, down = null;
    var scroller = null;
    var timer = null, lastRefresh = 0;

    var ARROW_UP = '<svg viewBox="0 0 20 16" width="20" height="16"><polygon points="10,1 19,15 1,15" fill="currentColor"/></svg>';
    var ARROW_DOWN = '<svg viewBox="0 0 20 16" width="20" height="16"><polygon points="1,1 19,1 10,15" fill="currentColor"/></svg>';

    function addStyle() {
        var css =
            '#rk-pager{position:absolute;z-index:900;display:none;margin:0;padding:0;border:none;background:#fff;width:' + (BTN * 2 + 8) + 'px;height:' + BTN + 'px;box-shadow:none;transform:none;}' +
            '#rk-pager .rk-pager-btn{position:absolute;top:0;box-sizing:border-box;width:' + BTN + 'px;height:' + BTN + 'px;min-width:0;min-height:0;margin:0;padding:0;' +
            'border:2px solid #000;border-radius:0;background:#fff;color:#000;box-shadow:2px 2px 0 #000;cursor:pointer;font:inherit;line-height:0;text-align:center;transform:none;opacity:1;}' +
            '#rk-pager-up{left:0;}#rk-pager-down{left:' + (BTN + 8) + 'px;}' +
            '#rk-pager .rk-pager-btn:active{background:#000;color:#fff;box-shadow:none;transform:translate(2px,2px);}' +
            // Disabled: solid white with a grey arrow (opacity would let the page show through).
            '#rk-pager .rk-pager-btn[disabled]{opacity:1;box-shadow:none;cursor:default;transform:none;background:#fff;color:#aaa;border-color:#aaa;}' +
            '#rk-pager svg{display:inline-block;vertical-align:middle;}';
        var style = document.createElement('style');
        style.id = 'rk-pager-style';
        style.appendChild(document.createTextNode(css));
        (document.head || document.documentElement).appendChild(style);
    }

    function build() {
        bar = document.createElement('div');
        bar.id = 'rk-pager';
        bar.innerHTML =
            '<button type="button" class="rk-pager-btn" id="rk-pager-up" aria-label="Page up" title="Page up">' + ARROW_UP + '</button>' +
            '<button type="button" class="rk-pager-btn" id="rk-pager-down" aria-label="Page down" title="Page down">' + ARROW_DOWN + '</button>';
        up = bar.firstChild;
        down = bar.lastChild;
        up.onclick = function (e) { e.stopPropagation(); page(-1); };
        down.onclick = function (e) { e.stopPropagation(); page(1); };
    }

    function isDocScroller(el) {
        return el === document.scrollingElement || el === document.documentElement || el === document.body;
    }

    // The largest visible element that scrolls vertically (or the page itself).
    function findScroller() {
        var best = null, bestArea = 0;
        var els = document.body.getElementsByTagName('*');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            if (el.clientHeight < 120 || el.scrollHeight - el.clientHeight < 30) continue;
            if (el === bar || /^(TEXTAREA|SELECT|INPUT|IFRAME|CANVAS)$/.test(el.tagName)) continue;
            if (!el.offsetParent) continue; // hidden, or fixed (modals)
            var oy = window.getComputedStyle(el).overflowY;
            if (oy !== 'auto' && oy !== 'scroll' && !(held && held.el === el)) continue;
            var area = el.clientWidth * el.clientHeight;
            if (area > bestArea) { best = el; bestArea = area; }
        }
        var doc = document.scrollingElement || document.documentElement;
        if (doc.scrollHeight - doc.clientHeight >= 30 &&
            window.getComputedStyle(document.body).overflowY !== 'hidden' &&
            window.getComputedStyle(document.documentElement).overflowY !== 'hidden' &&
            doc.clientWidth * doc.clientHeight > bestArea) {
            best = doc;
        }
        return best;
    }

    // Offset of el inside its positioned ancestor `anc`, in layout pixels
    // (offsetTop/Left are safe under theme.js CSS zoom, getBoundingClientRect is not).
    function offsetWithin(el, anc) {
        var x = 0, y = 0;
        while (el && el !== anc) {
            x += el.offsetLeft;
            y += el.offsetTop;
            el = el.offsetParent;
            if (el && el !== anc) { x += el.clientLeft; y += el.clientTop; }
        }
        return { x: x, y: y };
    }

    function place() {
        if (!scroller) return;
        if (isDocScroller(scroller)) {
            if (bar.parentNode !== document.body) document.body.appendChild(bar);
            var doc = document.scrollingElement || document.documentElement;
            bar.style.top = (doc.scrollTop + doc.clientHeight - BTN - MARGIN) + 'px';
            bar.style.left = (doc.scrollLeft + doc.clientWidth - (BTN * 2 + 8) - MARGIN) + 'px';
            return;
        }
        // Absolute positioning is relative to the nearest positioned ancestor
        // (offsetParent can also be a static <td>/<table>).
        var anc = scroller.offsetParent;
        while (anc && anc !== document.body && window.getComputedStyle(anc).position === 'static') anc = anc.offsetParent;
        if (!anc) anc = document.body;
        if (bar.parentNode !== anc) anc.appendChild(bar);
        var o = offsetWithin(scroller, anc);
        bar.style.top = (o.y + scroller.clientTop + scroller.clientHeight - BTN - MARGIN) + 'px';
        bar.style.left = (o.x + scroller.clientLeft + scroller.clientWidth - (BTN * 2 + 8) - MARGIN) + 'px';
    }

    function target() {
        return isDocScroller(scroller) ? (document.scrollingElement || document.documentElement) : scroller;
    }

    function updateButtons() {
        if (!scroller) return;
        var s = target();
        up.disabled = s.scrollTop <= 0;
        down.disabled = s.scrollTop + s.clientHeight >= s.scrollHeight - 2;
    }

    // E-ink: on a high-density screen Chromium scrolls a scrolling box as its own
    // composited layer and draws only part of the screen ahead, so a jump of almost a
    // screen showed the top at once and the rest a moment later, white until then: a
    // second refresh. With overflow-y: hidden the box is not composited, so a jump is a
    // normal repaint. The box stays that way after a jump: turning scrolling back on
    // re-creates the layer and redraws the whole box, which on the Kindle left the lower
    // part white for another second or so (seen in the owner's video when it was given
    // back 400 ms after each jump). It is given back only when the reader actually
    // swipes or uses the mouse wheel in it. A classic scrollbar's width is kept as
    // padding meanwhile, so the text doesn't reflow.
    var held = null;   // { el, overflow, padding } of the box held non-scrollable

    function hold(s) {
        if (held && held.el === s) return;
        release();
        var cs = window.getComputedStyle(s);
        var gutter = s.offsetWidth - s.clientWidth - (parseFloat(cs.borderLeftWidth) || 0) - (parseFloat(cs.borderRightWidth) || 0);
        held = { el: s, overflow: s.style.overflowY, padding: s.style.paddingRight };
        s.style.overflowY = 'hidden';
        if (gutter > 0) s.style.paddingRight = ((parseFloat(cs.paddingRight) || 0) + gutter) + 'px';
    }

    function release() {
        if (!held) return;
        held.el.style.overflowY = held.overflow;
        held.el.style.paddingRight = held.padding;
        held = null;
    }

    function jump(s, top) {
        if (!isDocScroller(scroller)) hold(s);
        s.scrollTop = top;
    }

    function stepOf(s) {
        var h = s.clientHeight;
        // Overlap covers the buttons' corner, so nothing stays hidden under them.
        return Math.max(60, h - Math.max(BTN + MARGIN * 2, Math.round(h * 0.08)));
    }

    function maxTop(s) { return Math.max(0, s.scrollHeight - s.clientHeight); }

    // Substack: this Kindle shows a screen while it is still drawing it, and a dense
    // Substack screen (pictures, Chinese text) takes about half a second, so a jump
    // showed the top first and the rest later (owner's videos). A white cover during the
    // jump hid that but added a delay the owner disliked. Instead the next screen is
    // drawn ahead (double buffering): a copy of the article box sits exactly behind it,
    // scrolled one step further, and Page Down swaps the two, which only reorders two
    // composited layers that are already drawn. The box now behind then moves on to the
    // following screen and is drawn while the reader reads. Both boxes are their own
    // composited layers (will-change) with an almost opaque white background (254/255):
    // with a fully opaque front the compositor would skip drawing the box behind it, and
    // 1/255 of the back box showing through is invisible on e-ink. The copy keeps the
    // id (for the page's #reader-content styles) but comes after the real box, so the
    // app's getElementById still finds the real one. Page Up and swipes scroll the front
    // box directly; the back box catches up afterwards.
    var BUFFER_PAGES = /(^|\/)substack(\.html)?$/;
    var BUFFER_BOX = 'reader-content';
    var BUFFER_BG = 'rgba(255,255,255,0.996)';
    var buf = null;   // { real, copy, front, back, ready, syncTimer, rebuildTimer }

    function bufferWanted(el) {
        return !!el && el.id === BUFFER_BOX && BUFFER_PAGES.test(location.pathname) && el.offsetHeight > 0;
    }

    function placeCopy() {
        var r = buf.real, c = buf.copy;
        c.style.top = r.offsetTop + 'px';
        c.style.left = r.offsetLeft + 'px';
        c.style.width = r.offsetWidth + 'px';
        c.style.height = r.offsetHeight + 'px';
    }

    // The back box goes to the screen after the front one, to be drawn out of sight.
    function syncBack() {
        if (!buf) return;
        clearTimeout(buf.syncTimer);
        buf.back.scrollTop = Math.min(buf.front.scrollTop + stepOf(buf.front), maxTop(buf.back));
    }

    function laterSync(ms) {
        clearTimeout(buf.syncTimer);
        buf.syncTimer = setTimeout(syncBack, ms);
    }

    function swap() {
        var f = buf.front, b = buf.back;
        b.style.zIndex = '2';
        f.style.zIndex = '1';
        b.removeAttribute('aria-hidden');
        f.setAttribute('aria-hidden', 'true');
        buf.front = b;
        buf.back = f;
        scroller = b;
    }

    // New content in the real box (another article, or text changed): show the real box
    // and copy it again.
    function contentChanged() {
        if (!buf) return;
        buf.ready = false;
        if (buf.front !== buf.real) { swap(); place(); updateButtons(); }
        clearTimeout(buf.rebuildTimer);
        buf.rebuildTimer = setTimeout(function () {
            if (!buf) return;
            buf.copy.innerHTML = buf.real.innerHTML;
            placeCopy();
            syncBack();
            buf.ready = true;
        }, 600);
    }

    function setupBuffer(real) {
        if (held && held.el === real) release();
        var copy = real.cloneNode(true);
        copy.setAttribute('data-rk-cjk', 'off');   // already wrapped by rk-cjk.js
        copy.setAttribute('aria-hidden', 'true');
        copy.style.position = 'absolute';
        copy.style.margin = '0';
        copy.style.maxWidth = 'none';
        copy.style.boxSizing = 'border-box';
        copy.style.flex = 'none';
        real.style.position = 'relative';
        real.style.background = copy.style.background = BUFFER_BG;
        real.style.willChange = copy.style.willChange = 'transform';
        real.style.zIndex = '2';
        copy.style.zIndex = '1';
        real.parentNode.insertBefore(copy, real.nextSibling);
        buf = { real: real, copy: copy, front: real, back: copy, ready: true, syncTimer: null, rebuildTimer: null };
        placeCopy();
        syncBack();
        if (window.MutationObserver) {
            new MutationObserver(contentChanged).observe(real, { childList: true, subtree: true, characterData: true });
        }
        // A swipe in the front box: the back box follows once it settles.
        var onScroll = function (e) { if (buf && e.target === buf.front) laterSync(300); };
        real.addEventListener('scroll', onScroll);
        copy.addEventListener('scroll', onScroll);
    }

    function page(dir) {
        if (!scroller || !document.body.contains(scroller)) refresh();
        if (!scroller) return;
        var s = target();
        var top = Math.max(0, Math.min(s.scrollTop + dir * stepOf(s), maxTop(s)));
        if (buf && s === buf.front) {
            if (dir > 0 && buf.ready && Math.abs(buf.back.scrollTop - top) <= 1) swap();
            else s.scrollTop = top;   // Page Up, or the copy is not ready: scroll directly
            place();
            updateButtons();
            laterSync(50);   // let the swap reach the screen, then draw the next screen behind
            return;
        }
        jump(s, top);
        place();
        updateButtons();
    }

    function refresh() {
        lastRefresh = Date.now();
        if (!bar) return;
        if (!enabled()) {
            release();
            scroller = null;
            bar.style.display = 'none';
            return;
        }
        scroller = findScroller();
        if (buf && !document.body.contains(buf.real)) buf = null;
        if (buf && (scroller === buf.real || scroller === buf.copy)) {
            scroller = buf.front;
            placeCopy();
        } else if (!buf && bufferWanted(scroller)) {
            setupBuffer(scroller);
        }
        if (held && held.el !== scroller) release();
        if (!scroller) {
            bar.style.display = 'none';
            return;
        }
        place();
        bar.style.display = 'block';
        updateButtons();
    }

    function scheduleRefresh() {
        if (timer) return;
        var wait = Math.max(200, THROTTLE - (Date.now() - lastRefresh));
        timer = setTimeout(function () { timer = null; refresh(); }, wait);
    }

    function init() {
        if (!document.body || bar) return;
        addStyle();
        build();
        refresh();
        // Pages fill in their content after loading: look again when the DOM changes.
        if (window.MutationObserver) {
            new MutationObserver(function (records) {
                for (var i = 0; i < records.length; i++) {
                    if (records[i].target !== bar && !bar.contains(records[i].target)) { scheduleRefresh(); return; }
                }
            }).observe(document.body, { childList: true, subtree: true });
        }
        document.addEventListener('scroll', function (e) {
            if (!scroller) return;
            if (isDocScroller(scroller)) place();
            if (e.target === target() || (isDocScroller(scroller) && e.target === document)) updateButtons();
        }, true);
        document.addEventListener('click', scheduleRefresh, true);
        // A swipe or wheel in the held box gives its scrolling back (see hold()).
        var giveBack = function (e) { if (held && held.el.contains(e.target)) release(); };
        document.addEventListener('touchmove', giveBack, true);
        document.addEventListener('wheel', giveBack, true);
        window.addEventListener('resize', scheduleRefresh);
        setTimeout(refresh, 800); // theme.js may zoom/rescale after first paint
    }

    // Settings page: the on/off switch.
    function addSetting() {
        var anchor = document.getElementById('toggle-opendyslexic');
        if (!anchor || document.getElementById('toggle-page-buttons')) return;
        var row = anchor.parentNode;
        var mine = document.createElement('div');
        mine.className = 'setting-row';
        mine.innerHTML =
            '<div class="setting-text"><strong>Page Buttons</strong>' +
            '<div class="setting-desc">Show Page Up / Page Down buttons on pages that scroll.</div></div>' +
            '<input type="checkbox" id="toggle-page-buttons" class="toggle-switch">';
        row.parentNode.insertBefore(mine, row.nextSibling);
        var box = document.getElementById('toggle-page-buttons');
        box.checked = enabled();
        box.onchange = function () {
            try { localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch (e) { }
            saveToAccount('rkPageButtons', box.checked ? '1' : '0');
            if (bar) refresh();
            else if (box.checked) init();
        };
    }

    window.rkPagerRefresh = refresh;

    function start() {
        addSetting();
        if (enabled()) init();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
