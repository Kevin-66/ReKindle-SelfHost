// deno test -A --unstable-detect-cjs --no-check test/dark-mode.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { darkBackdrops, noticePage, transformHtml, DARK_HEAD } from '../src/transform.js';

const page = (style, body = '') => `<!DOCTYPE html><html><head><style>${style}</style></head><body>${body}</body></html>`;

test('a see-through black dialog backdrop gets a white twin for dark mode, same opacity', () => {
    const css = darkBackdrops(page('/* MODALS */\n.modal-overlay { position: fixed; background: rgba(0, 0, 0, 0.6); }'));
    assert.equal(css, ':root[data-theme="dark"] .modal-overlay{background-color:rgba(255,255,255,0.6) !important}');
    const both = darkBackdrops(page('#modal-overlay, .modal-overlay { background-color: rgba(0,0,0,.4) }'));
    assert.match(both, /dark"\] #modal-overlay\{background-color:rgba\(255,255,255,\.4\)/);
    assert.match(both, /dark"\] \.modal-overlay\{/);
});

test('full-page layers count even without an overlay name; other black backgrounds do not', () => {
    assert.match(darkBackdrops(page('#login-view { position: absolute; top: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); }')), /#login-view/);
    assert.equal(darkBackdrops(page('.square.valid-move::after { background-color: rgba(0, 0, 0, 0.5); }')), '');
    assert.equal(darkBackdrops(page('.badge { background: rgba(0, 0, 0, 0.5); }')), '');
    assert.equal(darkBackdrops(page('.modal-overlay { background: transparent; }')), '');   // Pool
    assert.equal(darkBackdrops(page('.modal-overlay { background: rgba(255, 255, 255, 0.5); }')), '');
});

test('inline full-page backdrops with an id are covered', () => {
    const html = page('', '<div id="alert-modal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5);"></div>' +
        '<div style="position:fixed; background:rgba(0,0,0,0.5);"></div>');   // no id: nothing to aim at
    assert.equal(darkBackdrops(html), ':root[data-theme="dark"] #alert-modal{background-color:rgba(255,255,255,0.5) !important}');
});

test('pages carry dark mode: app pages, notice pages, and Doom keeps its colours', () => {
    const app = transformHtml(page('.modal-overlay { background: rgba(0, 0, 0, 0.5); }'), 'wordle.html');
    assert.ok(app.includes(DARK_HEAD));
    assert.match(app, /dark"\] \.modal-overlay\{background-color:rgba\(255,255,255,0\.5\)/);
    assert.ok(noticePage('Not available', 'Off.').includes(DARK_HEAD));
    const doom = transformHtml('<html><head></head><body><canvas id="canvas" oncontextmenu=""></canvas></body></html>', 'doom.html');
    assert.match(doom, /<canvas id="canvas" class="no-invert"/);
    assert.ok(!DARK_HEAD.includes('canvas,'));   // canvases go dark with the page
});
