// Self-hosted ReKindle: a stopwatch in the Notes editor (notes.html, added by
// selfhost/server/src/transform.js; the page itself is unchanged).
//
// The editor toolbar shows a stopwatch that waits, paused at 0:00, each time a note is
// opened; tapping it starts it, and further taps pause and resume (pause bars while
// paused). Going back to the list stops it. Like the B/I/U buttons, the tap keeps the
// caret and keyboard in the note. Time comes from the clock, not from counting ticks, so
// a slow or sleeping Kindle doesn't lose seconds. Plain ES5 for the Kindle browser.
//
// The time is drawn as 1-bit pixel glyphs on a small canvas, not as text: an update
// with any grey (anti-aliased) pixel makes the Kindle redraw the whole screen in
// grayscale (a full flash), and a text clock did that every second. Pure black and
// white pixels, scaled with image-rendering: pixelated, get a quick local update.
(function () {
    'use strict';

    if (typeof openNote !== 'function' || typeof showList !== 'function') return;
    var editor = document.getElementById('editor-view');
    var titleInput = document.getElementById('note-title-input');
    if (!editor || !titleInput) return;

    var SCALE = 2;   // CSS px per glyph pixel
    var ROWS = 7;
    // 5x7 digits (bit 4 is the left column), a 1-wide colon, and 7-wide state icons.
    var GLYPHS = {
        '0': [5, [14, 17, 17, 17, 17, 17, 14]],
        '1': [5, [4, 12, 4, 4, 4, 4, 14]],
        '2': [5, [14, 17, 1, 2, 4, 8, 31]],
        '3': [5, [31, 2, 4, 2, 1, 17, 14]],
        '4': [5, [2, 6, 10, 18, 31, 2, 2]],
        '5': [5, [31, 16, 30, 1, 1, 17, 14]],
        '6': [5, [6, 8, 16, 30, 17, 17, 14]],
        '7': [5, [31, 1, 2, 4, 8, 8, 8]],
        '8': [5, [14, 17, 17, 14, 17, 17, 14]],
        '9': [5, [14, 17, 17, 15, 1, 2, 12]],
        ':': [1, [0, 0, 1, 0, 1, 0, 0]],
        'P': [7, [54, 54, 54, 54, 54, 54, 54]],   // paused: two bars
        'R': [7, [28, 8, 62, 73, 77, 65, 62]]     // running: a stopwatch
    };

    var style = document.createElement('style');
    style.appendChild(document.createTextNode(
        '#rk-note-stopwatch{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}' +
        '#rk-note-stopwatch canvas{display:block;image-rendering:pixelated;}'));
    document.head.appendChild(style);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'rk-note-stopwatch';
    btn.className = 'sys-btn';
    btn.title = 'Time on this note. Tap to start, pause or resume.';
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    btn.appendChild(canvas);
    titleInput.parentNode.insertBefore(btn, titleInput.nextSibling);

    var banked = 0;        // ms counted before the last pause
    var startedAt = 0;     // Date.now() when it last started or resumed
    var running = false;
    var noteId = null;     // the note it is timing
    var tick = null;
    var shown = '';

    function elapsed() {
        return Math.max(0, banked + (running ? Date.now() - startedAt : 0));
    }

    function format(ms) {
        var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
        s = s % 60;
        var mmss = (h && m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        return h ? h + ':' + mmss : mmss;
    }

    function textWidth(text) {
        var w = 0;
        for (var i = 0; i < text.length; i++) w += GLYPHS[text.charAt(i)][0] + 1;
        return w - 1;
    }

    // Icon, a 3-pixel gap, then the time; the width is kept for at least "00:00", so it
    // only changes (moving the toolbar) when the hours appear.
    function draw(time) {
        var key = (running ? 'R' : 'P') + time;
        if (key === shown) return;
        shown = key;
        var timeW = Math.max(textWidth(time), textWidth('00:00'));
        var w = 7 + 3 + timeW;
        if (canvas.width !== w) {
            canvas.width = w;
            canvas.height = ROWS;
            canvas.style.width = (w * SCALE) + 'px';
            canvas.style.height = (ROWS * SCALE) + 'px';
        }
        ctx.clearRect(0, 0, w, ROWS);
        ctx.fillStyle = '#000';
        drawGlyph(running ? 'R' : 'P', 0);
        var x = 10 + timeW - textWidth(time);   // right-aligned
        for (var i = 0; i < time.length; i++) x = drawGlyph(time.charAt(i), x) + 1;
    }

    function drawGlyph(ch, x) {
        var g = GLYPHS[ch], width = g[0], rows = g[1];
        for (var y = 0; y < ROWS; y++) {
            for (var c = 0; c < width; c++) {
                if (rows[y] & (1 << (width - 1 - c))) ctx.fillRect(x + c, y, 1, 1);
            }
        }
        return x + width;
    }

    function render() {
        draw(format(elapsed()));
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

    render();
})();
