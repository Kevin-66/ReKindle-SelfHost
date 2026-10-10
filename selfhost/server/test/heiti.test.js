// node --test selfhost/server/test/heiti.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHeiti, transformHtml } from '../src/transform.js';

test('STHeiti goes after the generic family that ends a font list', () => {
    assert.equal(addHeiti('body { font-family: "Geneva", "Verdana", sans-serif; }'), 'body { font-family: "Geneva", "Verdana", sans-serif, STHeiti; }');
    assert.equal(addHeiti('p{font-family:Georgia,serif}'), 'p{font-family:Georgia,serif, STHeiti}');
    assert.equal(addHeiti('code { font-family: "Courier New", monospace }'), 'code { font-family: "Courier New", monospace, STHeiti }');
    assert.equal(addHeiti('h1{font:bold 14px/1.2 Geneva, sans-serif;}'), 'h1{font:bold 14px/1.2 Geneva, sans-serif, STHeiti;}');
    assert.equal(addHeiti(':root { --ui-font: "Geneva", sans-serif; }'), ':root { --ui-font: "Geneva", sans-serif, STHeiti; }');
    assert.equal(addHeiti('.b{font-family:sans-serif !important;}'), '.b{font-family:sans-serif, STHeiti !important;}');
});

test('inside attributes and JS strings, the quoting is untouched', () => {
    assert.equal(addHeiti(`<div style="font-family: 'Courier New', monospace">x</div>`), `<div style="font-family: 'Courier New', monospace, STHeiti">x</div>`);
    assert.equal(addHeiti(`el.style.cssText = 'font-family:"Geneva",sans-serif';`), `el.style.cssText = 'font-family:"Geneva",sans-serif, STHeiti';`);
    assert.equal(addHeiti(`x = 'font-family: sans-serif' + ';';`), `x = 'font-family: sans-serif, STHeiti' + ';';`);
});

test('left alone: inherit, var(), lists going on after the generic, other properties', () => {
    for (const css of [
        'a{font-family:inherit}', 'a{font-family: var(--ui-font)}', 'a{font: inherit}',
        'a{font-family: sans-serif, "Noto Sans"}', 'a{-webkit-font-smoothing: none}',
        'a{font-size: 12px; color: red}', 'ctx.font = "bold 14px sans-serif";',
        "a{font-family: 'PixelFont'}", 'a{font-family: "Geneva",\n sans-serif}',
        'css = `font-family: ${f}, serif`;'   // a template value (none in the codebase): stops at the brace
    ]) assert.equal(addHeiti(css), css, css);
});

test('running it twice changes nothing more', () => {
    const once = addHeiti('a{font-family:Geneva,sans-serif}b{font:12px serif}');
    assert.equal(addHeiti(once), once);
});

test('pages get the rewrite and the form-control default at the top of <head>', () => {
    const html = transformHtml('<html><head><style>body{font-family:"Geneva",sans-serif}</style></head><body></body></html>', 'example.html');
    assert.match(html, /<head><style>input,textarea,select,button\{font-family:sans-serif, STHeiti\}<\/style>/);
    assert.match(html, /body\{font-family:"Geneva",sans-serif, STHeiti\}/);
    assert.doesNotMatch(html, /rk-cjk/);
});
