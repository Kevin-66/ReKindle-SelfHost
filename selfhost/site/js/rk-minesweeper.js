// Self-hosted ReKindle: long press to flag in Minesweeper (minesweeper.html, added by
// selfhost/server/src/transform.js; the page itself is unchanged).
//
// Holding a covered cell for LONG_MS flags or unflags it in either mode, without
// switching the FLAG/DIG button; the flag appears while the finger is still down and
// the tap that follows is swallowed, so letting go doesn't also dig. A plain tap works
// as before. Right-click flags on a computer. Uses Pointer Events (Chromium 75 has
// them) for touch and mouse alike. Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var LONG_MS = 450;
    var MOVE_PX = 12;      // a drag this far is not a press
    var container = document.getElementById('grid-container');
    if (!container || typeof toggleFlag !== 'function' || typeof saveGame !== 'function') return;

    var style = document.createElement('style');
    style.appendChild(document.createTextNode('#grid-container .cell{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}'));
    document.head.appendChild(style);

    var timer = null, startX = 0, startY = 0, pressedCell = null;
    var swallowClickUntil = 0;

    function cellAt(target) {
        while (target && target !== container) {
            if (target.className && /(^|\s)cell(\s|$)/.test(target.className) && /^cell-\d+-\d+$/.test(target.id)) return target;
            target = target.parentNode;
        }
        return null;
    }

    function flagCell(el) {
        if (gameOver) return;
        var m = /^cell-(\d+)-(\d+)$/.exec(el.id);
        if (!m) return;
        if (!timerId) startTimer();
        toggleFlag(parseInt(m[1], 10), parseInt(m[2], 10));
        saveGame();
    }

    function cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
        pressedCell = null;
    }

    container.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        var el = cellAt(e.target);
        cancel();
        if (!el) return;
        pressedCell = el;
        startX = e.clientX;
        startY = e.clientY;
        timer = setTimeout(function () {
            timer = null;
            if (!pressedCell) return;
            var target = pressedCell;
            pressedCell = null;
            swallowClickUntil = Date.now() + 1500;
            flagCell(target);
        }, LONG_MS);
    });

    container.addEventListener('pointermove', function (e) {
        if (timer && (Math.abs(e.clientX - startX) > MOVE_PX || Math.abs(e.clientY - startY) > MOVE_PX)) cancel();
    });
    container.addEventListener('pointerup', function () { if (timer) cancel(); });
    container.addEventListener('pointercancel', cancel);
    container.addEventListener('pointerleave', function () { if (timer) cancel(); });

    // Swallow the click that ends a long press (capture phase, before the cell's onclick).
    container.addEventListener('click', function (e) {
        if (Date.now() < swallowClickUntil) {
            swallowClickUntil = 0;
            e.stopPropagation();
            e.preventDefault();
        }
    }, true);

    // The browser's own long-press menu, or a right-click on a computer.
    container.addEventListener('contextmenu', function (e) {
        var el = cellAt(e.target);
        if (!el) return;
        e.preventDefault();
        if (Date.now() < swallowClickUntil) return; // the long press already flagged it
        // A touch hold the browser reported before our timer: swallow its tap too.
        if (pressedCell) swallowClickUntil = Date.now() + 1500;
        cancel();
        flagCell(el);
    });
})();
