// node --test test/markdown.test.js   (or: deno test -A --unstable-detect-cjs --no-check test/markdown.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, htmlToMarkdown } from '../src/markdown.js';

const md = markdownToHtml;

test('raw HTML and unsafe links are shown as text', () => {
    assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(md('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    assert.equal(md('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
    assert.equal(md('![x](data:image/png;base64,AAAA)'), '<p>![x](data:image/png;base64,AAAA)</p>');
    assert.equal(md('[a"b](https://e.com/"onmouseover="x)'), '<p><a href="https://e.com/&quot;onmouseover=&quot;x">a&quot;b</a></p>');
});

test('inline formatting', () => {
    assert.equal(md('**b** *i* ~~s~~ `c <d>` ***bi***'), '<p><strong>b</strong> <em>i</em> <s>s</s> <code>c &lt;d&gt;</code> <strong><em>bi</em></strong></p>');
    assert.equal(md('snake_case_name and 2*3*4'), '<p>snake_case_name and 2*3*4</p>');
    assert.equal(md('see https://e.com/x.'), '<p>see <a href="https://e.com/x">https://e.com/x</a>.</p>');
    assert.equal(md('a\nb'), '<p>a<br>b</p>');
});

test('no whitespace between tags (the editor uses pre-wrap)', () => {
    const html = md('# T\n\npara\n\n- a\n- b\n\n> q\n\n```\ncode\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---');
    assert.doesNotMatch(html.replace(/<pre>[\s\S]*?<\/pre>/g, ''), />\s+</);
});

test('lists: tight, loose, nested, numbered', () => {
    assert.equal(md('- a\n- b\n  - c\n- d'), '<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>');
    assert.equal(md('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    assert.equal(md('3. a\n4. b'), '<ol start="3"><li>a</li><li>b</li></ol>');
    assert.equal(md('- a\n\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
});

test('blocks', () => {
    assert.equal(md('## Two ##'), '<h2>Two</h2>');
    assert.equal(md('Title\n==='), '<h1>Title</h1>');
    assert.equal(md('> a\n> b'), '<blockquote><p>a<br>b</p></blockquote>');
    assert.equal(md('```js\na < b\n```'), '<pre><code>a &lt; b</code></pre>');
    assert.equal(md('| a | b |\n|:-:|--:|\n| 1 | 2 |'),
        '<table><thead><tr><th style="text-align:center">a</th><th style="text-align:right">b</th></tr></thead><tbody><tr><td style="text-align:center">1</td><td style="text-align:right">2</td></tr></tbody></table>');
    assert.equal(md('***'), '<hr>');
});

test('pathological input stays fast', () => {
    const t = Date.now();
    md('**a '.repeat(60000));
    md('*'.repeat(200000));
    md('_a '.repeat(80000));
    md('['.repeat(50000) + ']('.repeat(50000));
    md('`a '.repeat(60000));
    md('<http://'.repeat(30000));
    assert.ok(Date.now() - t < 3000);
});

test('HTML back to Markdown (agents reading notes)', () => {
    const src = '# T\n\npara **b** *i* `c` [l](https://e.com)\nline2\n\n- a\n- b\n  - c\n\n1. x\n2. y\n\n> q\n\n```\ncode\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nend\n';
    assert.equal(htmlToMarkdown(markdownToHtml(src)), src);
    // What the editor saves: first line bare, then <div> lines, <br> placeholders.
    assert.equal(htmlToMarkdown('Heading<div>Some <b>bold</b> text</div><div><br></div><div>after<br></div><div><ul><li>item</li></ul></div>'),
        'Heading\nSome **bold** text\n\nafter\n\n- item\n');
});
