// Self-hosted ReKindle: Chinese text in a Chinese font.
//
// The Kindle browser draws Chinese characters with its Japanese font (角 in 确 gets
// the Japanese stroke), even inside lang="zh" text: the lang attribute alone changed
// nothing on a Kindle Scribe Colorsoft. Its Chinese fonts, STSong and STHeiti, are
// only used when named (checked with /fonttest on the device, 2026-10). So runs of
// Chinese characters, with the CJK punctuation between them, are wrapped in
// <span class="rk-zh-serif|rk-zh-sans">: STSong where the surrounding
// text is set in a serif, STHeiti where it is a sans-serif; other devices fall back to
// their own Chinese fonts. English around them keeps its own font. Text with kana is
// Japanese and left alone, as is anything already inside a lang="zh..."/"ja..."
// element or data-rk-cjk="off", form fields and editable areas. Text added later (articles, feeds) is
// handled as it appears. Added to every page by transform.js. Plain ES5.
(function () {
    'use strict';

    var RUN = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]+/g;
    var HAN = /[㐀-䶿一-鿿豈-﫿]/;
    var KANA = /[぀-ヿㇰ-ㇿ]/;
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, TITLE: 1 };

    var style = document.createElement('style');
    style.appendChild(document.createTextNode(
        '.rk-zh-sans{font-family:"STHeiti","Heiti SC","PingFang SC","Noto Sans SC","Microsoft YaHei",sans-serif;}' +
        '.rk-zh-serif{font-family:"STSong","Songti SC","Noto Serif SC","SimSun",serif;}'));
    (document.head || document.documentElement).appendChild(style);

    // Serif or sans-serif: the first family in the element's font list that says which.
    var SERIF = /^(serif|georgia|times|times new roman|bookerly|palatino|baskerville|caecilia|cambria|garamond|book antiqua|.*mincho|.*song.*)$/;
    var SANS = /^(sans-serif|verdana|geneva|arial|helvetica|helvetica neue|amazon ember|futura|tahoma|trebuchet ms|system-ui|-apple-system|monospace|courier|courier new|.*gothic|.*hei.*)$/;
    var kindCache = {};
    function kindOf(el) {
        var list = '';
        try { list = window.getComputedStyle(el).fontFamily || ''; } catch (e) { list = ''; }
        if (kindCache[list]) return kindCache[list];
        var names = list.toLowerCase().split(','), kind = 'sans';
        for (var i = 0; i < names.length; i++) {
            var n = names[i].replace(/["']/g, '').trim();
            if (SERIF.test(n)) { kind = 'serif'; break; }
            if (SANS.test(n)) { kind = 'sans'; break; }
        }
        kindCache[list] = kind;
        return kind;
    }

    // Inside an element that already names Chinese or Japanese (or one we skip)?
    function settled(el) {
        while (el && el.nodeType === 1) {
            if (SKIP[el.nodeName] || el.isContentEditable) return true;
            if (el.getAttribute('data-rk-cjk') === 'off' || /(^|\s)rk-zh-/.test(el.className || '')) return true;
            var lang = el.getAttribute('lang');
            if (lang) return /^(zh|ja)/i.test(lang);
            el = el.parentNode;
        }
        return false;
    }

    function markText(node) {
        var text = node.nodeValue;
        if (!text || !HAN.test(text) || KANA.test(text)) return;
        var parent = node.parentNode;
        if (!parent || settled(parent)) return;
        var cls = 'rk-zh-' + kindOf(parent);
        var frag = document.createDocumentFragment();
        var last = 0, m;
        RUN.lastIndex = 0;
        while ((m = RUN.exec(text)) !== null) {
            if (!HAN.test(m[0])) continue; // punctuation only: leave as it is
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            var span = document.createElement('span');
            span.className = cls;
            span.appendChild(document.createTextNode(m[0]));
            frag.appendChild(span);
            last = m.index + m[0].length;
        }
        if (!last) return;
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        parent.replaceChild(frag, node);
    }

    function mark(root) {
        if (!root) return;
        if (root.nodeType === 3) { markText(root); return; }
        if (root.nodeType !== 1 || settled(root)) return;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
        var found = [], node;
        while ((node = walker.nextNode()) !== null) {
            if (HAN.test(node.nodeValue)) found.push(node);
        }
        for (var i = 0; i < found.length; i++) markText(found[i]);
    }

    var pending = [], timer = null;
    function flush() {
        timer = null;
        var nodes = pending;
        pending = [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].parentNode && document.documentElement.contains(nodes[i])) mark(nodes[i]);
        }
    }

    function start() {
        mark(document.body);
        if (!window.MutationObserver) return;
        new MutationObserver(function (records) {
            for (var i = 0; i < records.length; i++) {
                var r = records[i];
                if (r.type === 'characterData') pending.push(r.target);
                for (var j = 0; j < r.addedNodes.length; j++) pending.push(r.addedNodes[j]);
            }
            if (pending.length && !timer) timer = setTimeout(flush, 250);
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
