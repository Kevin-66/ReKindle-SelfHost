// Self-hosted ReKindle: a stopwatch in the Notes editor (notes.html, added by
// selfhost/server/src/transform.js; the page itself is unchanged).
//
// The editor toolbar shows a stopwatch that waits, paused at 0:00, each time a note is
// opened; tapping it starts it, and further taps pause and resume (pause bars while
// paused). Going back to the list stops it. Like the B/I/U buttons, the tap keeps the caret and
// keyboard in the note. Time comes from the clock, not from counting ticks, so a slow
// or sleeping Kindle doesn't lose seconds. Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    if (typeof openNote !== 'function' || typeof showList !== 'function') return;
    var editor = document.getElementById('editor-view');
    var titleInput = document.getElementById('note-title-input');
    if (!editor || !titleInput) return;

    var ICON_RUN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="square">' +
        '<circle cx="12" cy="14" r="8"></circle><path d="M12 14V10M9 2h6M12 2v4"></path></svg>';
    var ICON_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">' +
        '<rect x="5" y="4" width="5" height="16"></rect><rect x="14" y="4" width="5" height="16"></rect></svg>';

    var style = document.createElement('style');
    style.appendChild(document.createTextNode(
        '#rk-note-stopwatch{display:inline-flex;align-items:center;flex-shrink:0;white-space:nowrap;font-variant-numeric:tabular-nums;}' +
        '#rk-note-stopwatch svg{margin-right:5px;flex-shrink:0;}'));
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'rk-note-stopwatch';
    btn.className = 'sys-btn';
    btn.title = 'Time on this note. Tap to pause or resume.';
    var icon = document.createElement('span');
    icon.style.display = 'inline-flex';
    var label = document.createElement('span');
    btn.appendChild(icon);
    btn.appendChild(label);
    titleInput.parentNode.insertBefore(btn, titleInput.nextSibling);

    var banked = 0;        // ms counted before the last pause
    var startedAt = 0;     // Date.now() when it last started or resumed
    var running = false;
    var noteId = null;     // the note it is timing
    var tick = null;
    var shownIcon = null;

    function elapsed() {
        return Math.max(0, banked + (running ? Date.now() - startedAt : 0));
    }

    function format(ms) {
        var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
        s = s % 60;
        var mmss = (h && m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        return h ? h + ':' + mmss : mmss;
    }

    function render() {
        var text = format(elapsed());
        if (label.textContent !== text) label.textContent = text;
        if (shownIcon !== running) {
            icon.innerHTML = running ? ICON_RUN : ICON_PAUSE;
            shownIcon = running;
        }
    }

    // Wake just after the next whole second, so the display steps once per second.
    function schedule() {
        clearTimeout(tick);
        if (!running) return;
        tick = setTimeout(function () { render(); schedule(); }, 1000 - (elapsed() % 1000) + 20);
    }

    function reset(id) {
        noteId = id;
        banked = 0;
        running = false;
        clearTimeout(tick);
        render();
    }

    function stop() {
        noteId = null;
        running = false;
        clearTimeout(tick);
    }

    function toggle(e) {
        if (e) e.preventDefault();
        if (noteId === null) return;
        if (running) {
            banked = elapsed();
            running = false;
        } else {
            startedAt = Date.now();
            running = true;
        }
        render();
        schedule();
    }

    // touchstart's preventDefault also stops the mouse events a tap would send.
    btn.addEventListener('touchstart', toggle);
    btn.addEventListener('mousedown', toggle);
    btn.addEventListener('click', function (e) { if (e.detail === 0) toggle(e); });   // keyboard

    var originalOpenNote = openNote;
    openNote = function (id) {
        var r = originalOpenNote.apply(this, arguments);
        if (editor.style.display === 'flex' && currentNoteId === id && noteId !== id) reset(id);
        return r;
    };

    var originalShowList = showList;
    showList = function () {
        stop();
        return originalShowList.apply(this, arguments);
    };
})();
