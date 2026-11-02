/*
 * Banned competitor mentions (promo ban).
 * ---------------------------------------------------------------------------
 * KindleHub (kindlehub / kindlehub.pro) and the other competing services are
 * banned from every social app: no promos, no name-drops, no "DM me on khub".
 *
 * A plain regex is not enough. The KindleHub owner has repeatedly evaded the
 * old filter with:
 *   - spelled-out dots      "kindlehubDOTpro", "unr3ad3r-v4yf.onrender(DOT)com"
 *   - homoglyphs            "kindlеhub" (Cyrillic e), "httрs://kindlеhub.рro/"
 *   - leetspeak             "Unr3ad3r", "k1ndlehub"
 *   - separators / spacing  "kindle.hub", "kindle hub", "un-reader"
 *   - abbreviations         "khub", "K-Hub"
 *   - zero-width characters "kindle​hub"
 *
 * So this helper folds all of that away (homoglyphs -> ASCII, leet -> letters,
 * diacritics stripped, non-alphanumerics dropped) and matches on the compacted
 * text, then maps the match back to the original characters so callers can
 * either reject the content outright or mask the offending span for display.
 *
 * The moderation worker (workers/rekindle-moderate/worker.js) carries a mirror
 * of this matcher for server-side enforcement - KEEP THEM IN SYNC.
 */
(function () {
    'use strict';

    // Cyrillic / Greek / small-caps lookalikes -> Latin.
    var HOMOGLYPHS = {
        // Cyrillic
        '\u0430': 'a', '\u0432': 'b', '\u0435': 'e', '\u0451': 'e', '\u043A': 'k',
        '\u043C': 'm', '\u043D': 'h', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c',
        '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0457': 'i',
        '\u0455': 's', '\u0501': 'd', '\u04CF': 'l', '\u0458': 'j', '\u051B': 'q',
        '\u051D': 'w', '\u0261': 'g', '\u044C': 'b', '\u043F': 'n',
        // Greek
        '\u03B1': 'a', '\u03B2': 'b', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k',
        '\u03BD': 'v', '\u03BF': 'o', '\u03C1': 'p', '\u03C3': 'o', '\u03C4': 't',
        '\u03C5': 'u', '\u03C7': 'x', '\u03C9': 'w', '\u03B3': 'y', '\u03B7': 'n',
        '\u03BC': 'u', '\u03C0': 'n', '\u03B6': 'z',
        // Latin small caps / dotless forms
        '\u0131': 'i', '\u0251': 'a', '\u2113': 'l', '\u026A': 'i', '\u0280': 'r',
        '\u0274': 'n', '\u028F': 'y', '\u0262': 'g', '\u029C': 'h', '\u0299': 'b',
        '\u1D0B': 'k', '\u1D1C': 'u', '\u1D0F': 'o', '\u1D00': 'a', '\u1D04': 'c',
        '\u1D05': 'd', '\u1D07': 'e', '\u1D0A': 'j', '\u029F': 'l', '\u1D0D': 'm',
        '\u1D18': 'p', '\uA731': 's', '\uA730': 'f', '\u1D1B': 't'
    };

    // Leetspeak / symbol substitutions.
    var LEET = {
        '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
        '9': 'g', '@': 'a', '$': 's', '!': 'i', '|': 'i'
    };

    // Compact-form terms. Every non-alphanumeric character between the letters
    // is dropped before matching, so "kindle.hub", "kindle hub" and
    // "kindlehubDOTpro" all collapse to "kindlehub...".
    var TERMS = ['kindlehub', 'unreader', 'inkchat'];

    // Usernames are alphanumeric-only, so a plain substring check is safe there
    // ("kindlehubfan", "ilovekhub", "KINDLEHUBUNREADER").
    var USERNAME_TERMS = ['kindlehub', 'khub', 'unreader', 'inkchat'];

    // Standalone "khub"/"K-Hub" abbreviation. Needs a word boundary before the
    // "k" so ordinary words like "look hub" ("lookhub") do not match.
    var KHUB_RE = /(^|[^a-z0-9])k[\W_]*hub(?![a-z0-9])/g;

    // A trailing TLD ("kindlehub.pro", "kindlehub pro", "kindlehubDOTpro")
    // belongs to the mention, so it is masked/blocked together with it.
    // Bounded so a long run of "dot" tokens cannot trigger exponential
    // backtracking (CodeQL js/redos). Four is more than any real mention uses.
    var TLD_RE = /^[\W_]*(?:dot[\W_]*){0,4}(?:pro|com|net|org|app|site|ink)(?![a-z0-9])/;

    var BLOCKS = '\u2588\u2588\u2588\u2588\u2588'; // █████

    function foldChar(ch) {
        if (!ch) return '';
        var code = ch.charCodeAt(0);
        var c = ch;
        if (code > 127 && typeof ch.normalize === 'function') {
            try {
                var n = ch.normalize('NFKD');
                if (n) c = n.charAt(0);
            } catch (e) {
                c = ch;
            }
        }
        c = c.toLowerCase();
        if (c.length !== 1) c = ch.charAt(0).toLowerCase();
        return HOMOGLYPHS[c] || LEET[c] || c;
    }

    // Folds the text into two aligned copies:
    //   folded  - one output character per input character (separators kept)
    //   compact - alphanumerics only, with `map` pointing back at the original
    //             character index for each compact character.
    function foldText(text) {
        var s = String(text || '');
        var folded = '';
        var compact = '';
        var map = [];
        for (var i = 0; i < s.length; i++) {
            var f = foldChar(s.charAt(i));
            folded += f;
            if (f.length === 1 && /[a-z0-9]/.test(f)) {
                compact += f;
                map.push(i);
            }
        }
        return { folded: folded, compact: compact, map: map };
    }

    function isWordCharBefore(s, index) {
        if (index <= 0) return false;
        return /[a-z0-9]/.test(foldChar(s.charAt(index - 1)));
    }

    // Swallows a trailing TLD so "kindlehubDOTpro" is masked as one mention
    // instead of leaving a "DOTpro" tail that still identifies the service.
    function extendPastTld(folded, end) {
        var m = TLD_RE.exec(folded.slice(end));
        return m ? end + m[0].length : end;
    }

    function collectRanges(text) {
        var s = String(text || '');
        var ranges = [];
        if (!s) return ranges;

        var foldedInfo = foldText(s);
        var t, from, at, start, end;

        for (t = 0; t < TERMS.length; t++) {
            var term = TERMS[t];
            from = 0;
            while ((at = foldedInfo.compact.indexOf(term, from)) !== -1) {
                from = at + 1;
                start = foldedInfo.map[at];
                // "unreader"/"inkchat" need a word boundary or ordinary phrases
                // ("run reader" -> "runreader", "think chat" -> "thinkchat") would
                // match. "kindlehub" is distinctive enough to match inside a word,
                // so "mykindlehub"/"joinKindlehub" cannot dodge the filter.
                if (term !== 'kindlehub' && isWordCharBefore(s, start)) continue;
                end = foldedInfo.map[at + term.length - 1] + 1;
                end = extendPastTld(foldedInfo.folded, end);
                ranges.push([start, end]);
            }
        }

        // Standalone "khub" (and "k-hub", "k hub", "K.Hub").
        var m;
        KHUB_RE.lastIndex = 0;
        while ((m = KHUB_RE.exec(foldedInfo.folded)) !== null) {
            var lead = m[1] ? m[1].length : 0;
            start = m.index + lead;
            end = extendPastTld(foldedInfo.folded, start + m[0].length - lead);
            ranges.push([start, end]);
            KHUB_RE.lastIndex = m.index + m[0].length;
        }

        return ranges;
    }

    function mergeRanges(ranges) {
        ranges.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [];
        for (var i = 0; i < ranges.length; i++) {
            var last = merged[merged.length - 1];
            if (last && ranges[i][0] <= last[1]) {
                if (ranges[i][1] > last[1]) last[1] = ranges[i][1];
            } else {
                merged.push([ranges[i][0], ranges[i][1]]);
            }
        }
        return merged;
    }

    // True when the text mentions a banned service (any evasion form).
    window.rekindleContainsPromotedTerm = function (text) {
        if (!text) return false;
        return collectRanges(text).length > 0;
    };

    // Masks the banned mention(s) with blocks, preserving the rest of the text.
    window.rekindleCensorPromotedTerms = function (text) {
        if (!text) return text;
        var s = String(text);
        var ranges = mergeRanges(collectRanges(s));
        if (!ranges.length) return s;
        var out = '';
        var last = 0;
        for (var i = 0; i < ranges.length; i++) {
            out += s.slice(last, ranges[i][0]) + BLOCKS;
            last = ranges[i][1];
        }
        return out + s.slice(last);
    };

    // Usernames are alphanumeric-only, so substring matching on the folded form
    // catches "kindlehub", "Kindlehubpro" and "ilovekhub" without false hits on
    // innocent Kindle-themed names ("kindlebook", "kindlebell").
    window.rekindleContainsPromotedUsername = function (name) {
        if (!name) return false;
        var compact = foldText(name).compact;
        for (var i = 0; i < USERNAME_TERMS.length; i++) {
            if (compact.indexOf(USERNAME_TERMS[i]) !== -1) return true;
        }
        return false;
    };

    window.rekindleCensorPromotedUsername = function (name) {
        if (!name) return name;
        var s = String(name);
        var info = foldText(s);
        var ranges = [];
        for (var i = 0; i < USERNAME_TERMS.length; i++) {
            var term = USERNAME_TERMS[i];
            var at = info.compact.indexOf(term);
            while (at !== -1) {
                ranges.push([info.map[at], info.map[at + term.length - 1] + 1]);
                at = info.compact.indexOf(term, at + 1);
            }
        }
        ranges = mergeRanges(ranges);
        if (!ranges.length) return name;
        var out = '';
        var last = 0;
        for (var r = 0; r < ranges.length; r++) {
            out += s.slice(last, ranges[r][0]) + BLOCKS;
            last = ranges[r][1];
        }
        return out + s.slice(last);
    };
})();
