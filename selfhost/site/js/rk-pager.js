// Self-hosted ReKindle: Page Up / Page Down buttons on every page that scrolls.
// Kindle Scribe and most e-readers have no page-turn keys, and scrolling by swipe
// smears on e-ink, so these move the page's main scrolling area one screen at a
// time. Added to every page by selfhost/server/src/transform.js; switched on/off in
// Settings > Accessibility ("Page Buttons", localStorage rk_page_buttons = '0' off).
// Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var KEY = 'rk_page_buttons';
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
            if (oy !== 'auto' && oy !== 'scroll') continue;
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

    function page(dir) {
        if (!scroller || !document.body.contains(scroller)) refresh();
        if (!scroller) return;
        var s = target();
        var h = s.clientHeight;
        // Overlap covers the buttons' corner, so nothing stays hidden under them.
        var step = Math.max(60, h - Math.max(BTN + MARGIN * 2, Math.round(h * 0.08)));
        s.scrollTop = Math.max(0, s.scrollTop + dir * step);
        place();
        updateButtons();
    }

    function refresh() {
        lastRefresh = Date.now();
        if (!bar) return;
        if (!enabled()) {
            scroller = null;
            bar.style.display = 'none';
            return;
        }
        scroller = findScroller();
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
