// Self-hosted ReKindle: "Text Size" in Settings > Accessibility.
//
// Enlarges reading text (articles, posts, comments, messages, ...) across apps by
// setting the --rk-text CSS variable, which css/rk-text.css multiplies into those
// apps' own text sizes. Only font sizes change: no CSS zoom, which the Kindle
// browser mishandles (taps land in the wrong place, page buttons break).
// Saved in localStorage rk_text_size; every page applies it in <head> (transform.js).
// Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var KEY = 'rk_text_size';
    var SIZES = [['Small', '0.9'], ['Normal', '1'], ['Large', '1.2'], ['Larger', '1.45'], ['Largest', '1.75']];

    function current() {
        var v = null;
        try { v = localStorage.getItem(KEY); } catch (e) { v = null; }
        for (var i = 0; i < SIZES.length; i++) if (SIZES[i][1] === v) return v;
        return '1';
    }

    // Same as the <head> snippet in transform.js: css/rk-text.css rules only apply
    // while data-rk-text is set, scoped by data-rk-page.
    function apply(v) {
        var root = document.documentElement;
        if (v === '1') {
            root.style.removeProperty('--rk-text');
            root.removeAttribute('data-rk-text');
            return;
        }
        root.style.setProperty('--rk-text', v);
        root.setAttribute('data-rk-text', v);
        root.setAttribute('data-rk-page', (location.pathname.split('/').pop() || 'index').replace(/\.html$/, ''));
    }

    function addStyle() {
        var css =
            '#rk-text-row{flex-wrap:wrap;}' +
            '#rk-text-options{width:100%;display:grid;grid-template-columns:repeat(' + SIZES.length + ',minmax(0,1fr));gap:6px;margin-top:10px;}' +
            '.rk-text-opt{min-height:48px;border:2px solid #000;background:#fff;color:#000;box-shadow:2px 2px 0 #000;' +
            'font-family:inherit;font-weight:bold;cursor:pointer;padding:4px 2px;line-height:1.1;}' +
            '.rk-text-opt.active{background:#000;color:#fff;box-shadow:none;}' +
            '#rk-text-sample{width:100%;margin-top:10px;padding:8px 10px;border:1px solid #000;line-height:1.4;' +
            'font-size:calc(15px * var(--rk-text, 1));}';
        var style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
    }

    function addSetting() {
        var anchor = document.getElementById('toggle-opendyslexic');
        if (!anchor || document.getElementById('rk-text-row')) return;
        addStyle();
        var row = document.createElement('div');
        row.className = 'setting-row';
        row.id = 'rk-text-row';
        var html = '<div class="setting-text"><strong>Text Size</strong>' +
            '<div class="setting-desc">Size of reading text in articles, posts, comments and messages. Buttons and layout stay the same.</div></div>' +
            '<div id="rk-text-options">';
        for (var i = 0; i < SIZES.length; i++) {
            html += '<button type="button" class="rk-text-opt" data-size="' + SIZES[i][1] + '">' + SIZES[i][0] + '</button>';
        }
        html += '</div><div id="rk-text-sample">The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过了懒狗。</div>';
        row.innerHTML = html;
        var anchorRow = anchor.parentNode;
        anchorRow.parentNode.insertBefore(row, anchorRow.nextSibling);

        var buttons = row.querySelectorAll('.rk-text-opt');
        function mark(v) {
            for (var j = 0; j < buttons.length; j++) {
                buttons[j].className = 'rk-text-opt' + (buttons[j].getAttribute('data-size') === v ? ' active' : '');
            }
        }
        for (var k = 0; k < buttons.length; k++) {
            buttons[k].onclick = function () {
                var v = this.getAttribute('data-size');
                try { localStorage.setItem(KEY, v); } catch (e) { }
                apply(v);
                mark(v);
            };
        }
        mark(current());
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addSetting);
    else addSetting();
})();
