// Self-hosted ReKindle: Notes kept in sync when the same note is open in two
// browsers (notes.html, added by selfhost/server/src/transform.js; the page itself is
// unchanged).
//
// notes.html saved the whole note a second after typing and never updated an open
// note, so two browsers editing it overwrote each other. For a signed-in reader this
// script:
// - listens to the open note and shows the other browser's saves at once, keeping
//   the caret where it was;
// - merges instead of overwriting: each side's unsaved change since the last version
//   both saw ("base") is one changed stretch; stretches in different places are both
//   applied, overlapping ones are both kept side by side (nothing is lost);
// - saves in a transaction that fails if the note changed meanwhile (the server
//   checks the version), merging and retrying.
// Guest (local) notes are unchanged. Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    if (typeof saveNoteData !== 'function' || typeof openNote !== 'function' || typeof showList !== 'function' || typeof db === 'undefined') return;

    var SAVE_DELAY_MS = 800;

    var open = null;      // { id, ref, unsubscribe, base: { title, content }, timer, saving, again }

    // ------------------------------------------------------------ merging

    // The single changed stretch from a to b: a[start, end) became text.
    function stretch(a, b) {
        var max = Math.min(a.length, b.length), p = 0, s = 0;
        while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
        while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
        return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
    }

    // Three-way merge of two edited versions of base (strings of note HTML).
    function merge3(base, mine, theirs) {
        if (mine === theirs || theirs === base) return mine;
        if (mine === base) return theirs;
        var m = stretch(base, mine), t = stretch(base, theirs);
        if (m.end <= t.start) {
            return base.slice(0, m.start) + m.text + base.slice(m.end, t.start) + t.text + base.slice(t.end);
        }
        if (t.end <= m.start) {
            return base.slice(0, t.start) + t.text + base.slice(t.end, m.start) + m.text + base.slice(m.end);
        }
        // Overlapping edits: keep both versions of the overlapping part.
        var s = Math.min(m.start, t.start), e = Math.max(m.end, t.end);
        var mineRegion = mine.slice(s, mine.length - (base.length - e));
        var theirRegion = theirs.slice(s, theirs.length - (base.length - e));
        return base.slice(0, s) + mineRegion + theirRegion + base.slice(e);
    }

    // ------------------------------------------------------------ editor

    function titleEl() { return document.getElementById('note-title-input'); }
    function contentEl() { return document.getElementById('note-content'); }

    function current() {
        return { title: titleEl().value, content: contentEl().innerHTML };
    }

    // Where a position ends up after a changed to b.
    function mapPos(pos, a, b) {
        var d = stretch(a, b);
        if (pos <= d.start) return pos;
        if (pos >= d.end) return pos + (b.length - a.length);
        return d.start + d.text.length;
    }

    function caretOffset(root) {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return -1;
        var r = sel.getRangeAt(0).cloneRange();
        r.selectNodeContents(root);
        r.setEnd(sel.anchorNode, sel.anchorOffset);
        return r.toString().length;
    }

    function setCaret(root, offset) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false), node, left = offset;
        while ((node = walker.nextNode()) !== null) {
            if (left <= node.nodeValue.length) {
                var r = document.createRange();
                r.setStart(node, left);
                r.collapse(true);
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(r);
                return;
            }
            left -= node.nodeValue.length;
        }
    }

    // Put a merged version on screen, keeping the caret in the same place in the text.
    function show(next) {
        var t = titleEl(), c = contentEl();
        if (t.value !== next.title) {
            var focusedTitle = document.activeElement === t, pos = t.selectionStart;
            var oldTitle = t.value;
            t.value = next.title;
            if (focusedTitle && pos !== null) { var np = mapPos(pos, oldTitle, next.title); t.setSelectionRange(np, np); }
        }
        if (c.innerHTML !== next.content) {
            var oldText = c.textContent, offset = document.activeElement === c ? caretOffset(c) : -1;
            c.innerHTML = next.content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
            if (offset >= 0) setCaret(c, mapPos(offset, oldText, c.textContent));
        }
        var note = notes.find(function (n) { return n.id === (open && open.id); });
        if (note) { note.title = next.title; note.content = next.content; }
    }

    // ------------------------------------------------------------ syncing one note

    function onRemote(snap) {
        if (!open || !snap.exists) return;
        var data = snap.data() || {};
        var theirs = { title: data.title || '', content: data.content || '' };
        var mine = current();
        var merged = {
            title: merge3(open.base.title, mine.title, theirs.title),
            content: merge3(open.base.content, mine.content, theirs.content)
        };
        open.base = theirs;
        if (merged.title !== mine.title || merged.content !== mine.content) show(merged);
        // Unsent changes of ours remain on top of their version: send them.
        if (merged.title !== theirs.title || merged.content !== theirs.content) scheduleSave();
    }

    function scheduleSave() {
        if (!open) return;
        clearTimeout(open.timer);
        open.timer = setTimeout(save, SAVE_DELAY_MS);
    }

    function setStatus(text) {
        var bar = document.getElementById('status-bar');
        if (bar) bar.innerText = text;
    }

    function save() {
        var o = open;
        if (!o) return Promise.resolve();
        clearTimeout(o.timer);
        if (o.saving) { o.again = true; return o.saving; }
        setStatus(window.t ? window.t('notes.status.saving', 'Saving...') : 'Saving...');
        var written = null, sent = null;
        o.saving = db.runTransaction(function (tx) {
            return tx.get(o.ref).then(function (snap) {
                var mine = open === o ? current() : o.last;
                sent = mine;
                var server = snap.exists ? snap.data() : null;
                var theirs = server ? { title: server.title || '', content: server.content || '' } : o.base;
                written = {
                    title: merge3(o.base.title, mine.title, theirs.title),
                    content: merge3(o.base.content, mine.content, theirs.content)
                };
                tx.set(o.ref, { title: written.title, content: written.content, updated: Date.now() });
            });
        }).then(function () {
            o.base = written;
            if (open === o) {
                // Show text that came in through the merge, keeping anything typed
                // while the save was on its way (that goes out with the next save).
                var now = current();
                var shown = { title: merge3(sent.title, now.title, written.title), content: merge3(sent.content, now.content, written.content) };
                if (shown.title !== now.title || shown.content !== now.content) show(shown);
                if (shown.title !== written.title || shown.content !== written.content) scheduleSave();
            }
            setStatus(window.t ? window.t('notes.status.saved', 'Saved.') : 'Saved.');
        }, function (e) {
            setStatus(window.t ? window.t('notes.status.failed', 'Save Failed.') : 'Save Failed.');
            if (window.console) console.error(e);
        }).then(function () {
            o.saving = null;
            if (o.again) { o.again = false; return save(); }
        });
        return o.saving;
    }

    function stop() {
        if (!open) return Promise.resolve();
        var o = open;
        o.last = current();
        var pending = o.timer || o.saving;
        var done = pending ? save() : Promise.resolve();
        if (o.unsubscribe) o.unsubscribe();
        open = null;
        return done;
    }

    function start(id) {
        if (!currentUser || !id) return;
        var note = notes.find(function (n) { return n.id === id; });
        var ref = db.collection('users').doc(currentUser.uid).collection('notes').doc(id);
        open = { id: id, ref: ref, base: { title: (note && note.title) || '', content: (note && note.content) || '' }, timer: null, saving: null, again: false };
        open.unsubscribe = ref.onSnapshot(onRemote, function (e) { if (window.console) console.warn('Note sync:', e); });
    }

    // ------------------------------------------------------------ hooks into notes.html

    var originalOpenNote = openNote;
    openNote = function (id) {
        if (open && open.id !== id) stop();
        var r = originalOpenNote.apply(this, arguments);
        if (!open && currentNoteId === id) start(id);
        return r;
    };

    var originalShowList = showList;
    showList = function () {
        stop();
        return originalShowList.apply(this, arguments);
    };

    var originalSaveNoteData = saveNoteData;
    saveNoteData = function (note) {
        if (currentUser && open && note && note.id === open.id) {
            if (typeof updateCache === 'function') updateCache();
            scheduleSave();
            return;
        }
        return originalSaveNoteData.apply(this, arguments);
    };

    if (typeof deleteNoteData === 'function') {
        var originalDeleteNoteData = deleteNoteData;
        deleteNoteData = function (id) {
            if (open && open.id === id) {
                clearTimeout(open.timer);
                if (open.unsubscribe) open.unsubscribe();
                open = null;
            }
            return originalDeleteNoteData.apply(this, arguments);
        };
    }

    window.addEventListener('pagehide', function () { if (open) save(); });
})();
