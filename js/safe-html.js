/*
 * DOM-based HTML sanitiser for rich text that comes from external services
 * (Reddit, Wiktionary, saved notes).
 *
 * Why not a regex? CodeQL's js/bad-tag-filter and js/incomplete-multi-character-
 * sanitization are right: stripping "<script" with a regex misses nested and
 * malformed tags, and innerHTML runs event handlers such as <img onerror>.
 *
 * Usage:
 *   rekindleSetSafeHtml(element, untrustedHtml)   // replaces children
 *   element.appendChild(rekindleSafeHtmlFragment(untrustedHtml))
 *
 * The HTML is parsed by DOMParser into an inert document, dangerous elements
 * and attributes are removed, then the resulting nodes are moved into the page
 * with appendChild (never innerHTML). Chromium 75 compatible (no
 * replaceChildren, optional chaining or nullish coalescing).
 */
(function () {
    'use strict';

    var BLOCKED_TAGS = {
        SCRIPT: 1, STYLE: 1, IFRAME: 1, FRAME: 1, FRAMESET: 1, OBJECT: 1,
        EMBED: 1, APPLET: 1, LINK: 1, META: 1, BASE: 1, FORM: 1, INPUT: 1,
        BUTTON: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, TEMPLATE: 1
    };

    var URL_ATTRS = {
        href: 1, src: 1, 'xlink:href': 1, action: 1, formaction: 1, poster: 1
    };

    function scrub(root) {
        var nodes = root.querySelectorAll('*');
        for (var i = nodes.length - 1; i >= 0; i--) {
            var el = nodes[i];
            if (BLOCKED_TAGS[el.tagName]) {
                if (el.parentNode) el.parentNode.removeChild(el);
                continue;
            }
            var attrs = Array.prototype.slice.call(el.attributes || []);
            for (var j = 0; j < attrs.length; j++) {
                var name = String(attrs[j].name || '').toLowerCase();
                var value = String(attrs[j].value || '');
                // Event handlers are the main XSS vector in otherwise valid markup.
                if (name.indexOf('on') === 0) {
                    el.removeAttribute(attrs[j].name);
                    continue;
                }
                if (URL_ATTRS[name]) {
                    var compact = value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
                    if (compact.indexOf('javascript:') === 0 || compact.indexOf('vbscript:') === 0) {
                        el.removeAttribute(attrs[j].name);
                        continue;
                    }
                    // data: is dangerous for navigation, but inert in <img src>.
                    if (name !== 'src' && name !== 'poster' && compact.indexOf('data:') === 0) {
                        el.removeAttribute(attrs[j].name);
                        continue;
                    }
                }
                if (name === 'style' && /expression\s*\(|url\s*\(\s*['"]?\s*(javascript|vbscript):/i.test(value)) {
                    el.removeAttribute(attrs[j].name);
                }
            }
        }
        return root;
    }

    window.rekindleSafeHtmlFragment = function (html) {
        var doc;
        try {
            doc = new DOMParser().parseFromString(String(html == null ? '' : html), 'text/html');
        } catch (e) {
            doc = document.implementation.createHTMLDocument('');
        }
        scrub(doc.body);
        var frag = document.createDocumentFragment();
        while (doc.body.firstChild) {
            frag.appendChild(doc.body.firstChild);
        }
        return frag;
    };

    window.rekindleSetSafeHtml = function (el, html) {
        if (!el) return;
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(window.rekindleSafeHtmlFragment(html));
    };
})();
