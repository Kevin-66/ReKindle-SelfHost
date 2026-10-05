// Self-hosted ReKindle: Chinese text in a Chinese font.
//
// ReKindle's pages say lang="en", so for Chinese characters the Kindle browser falls
// back to its Japanese font, and many characters come out with Japanese shapes. This
// marks runs of Chinese characters (with the CJK punctuation between them) as
// <span lang="zh-Hans">, which makes the browser pick a Chinese font for them. English
// around them keeps its own font. Text with kana is Japanese and left alone, as is
// anything already inside a lang="zh..."/"ja..." element, form fields and editable
// areas. Text added later (articles, feeds) is marked as it appears. Added to every
// page by transform.js. Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var RUN = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]+/g;
    var HAN = /[㐀-䶿一-鿿豈-﫿]/;
    var KANA = /[぀-ヿㇰ-ㇿ]/;
    var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, TITLE: 1 };

    // Inside an element that already names Chinese or Japanese (or one we skip)?
    function settled(el) {
        while (el && el.nodeType === 1) {
            if (SKIP[el.nodeName] || el.isContentEditable) return true;
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
        var frag = document.createDocumentFragment();
        var last = 0, m;
        RUN.lastIndex = 0;
        while ((m = RUN.exec(text)) !== null) {
            if (!HAN.test(m[0])) continue; // punctuation only: leave as it is
            if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            var span = document.createElement('span');
            span.setAttribute('lang', 'zh-Hans');
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
