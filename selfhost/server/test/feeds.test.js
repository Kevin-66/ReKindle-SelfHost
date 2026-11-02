// node --test selfhost/server/test/feeds.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseFeed, decode, formatDate, handleFeed, cleanHtml } from '../src/feeds.js';
import { transformHtml } from '../src/transform.js';

test('feed HTML loses scripts, frames, styles, handlers and javascript: links', () => {
    assert.equal(cleanHtml(
        '<p onclick="steal()">Text <img src="https://example.com/a.jpg" onerror="steal()"></p>' +
        '<script>steal()</script><style>p{}</style><iframe src="https://evil"></iframe>' +
        '<a href=" java\tscript:steal()">x</a><a href="https://example.com/">ok</a>' +
        '<svg><a xlink:href="javascript:steal()"><text>y</text></a></svg>'),
    '<p>Text <img src="https://example.com/a.jpg"></p><a>x</a><a href="https://example.com/">ok</a><svg><a><text>y</text></a></svg>');
    assert.equal(cleanHtml('Plain text & more'), 'Plain text & more');
    assert.equal(cleanHtml(''), '');
});

test('the RSS reader shows the feed\'s text when the page has less (paywalls)', async () => {
    const page = transformHtml(fs.readFileSync(new URL('../../../rssreader.html', import.meta.url), 'utf8'), 'rssreader.html');
    // Every edit found its place in upstream's page.
    assert.match(page, /rkContent: item\.content \|\| "",/);
    assert.match(page, /const res = await rkReaderFetch\(article, `\$\{READER_WORKER_URL\}\/\?url=/);
    assert.match(page, /async function rkReaderFetch[\s\S]*?\n {8}async function openArticle\(articleOrUrl\) \{/);
    // Page turns on the Kindle: not-yet-drawn parts of the overlay come out white.
    assert.match(page, /#article-modal \{[^}]*background: transparent;[\s\S]*<style>#article-modal\{background:#fff\}<\/style>\n<\/head>/);
    // ...and the article's columns scroll on the compositor, with swipes still blocked.
    assert.match(page, /column-width: calc\(100vw - 80px\);[^}]*overflow-x: scroll;[^}]*touch-action: none;/);
    assert.doesNotMatch(page, /overflow-x: hidden; \/\* Disable user scrolling \*\//);

    const source = /async function rkReaderFetch[\s\S]*?\n {8}\}\n/.exec(page)[0];
    const readerFetch = (answer) => new Function('fetch', 'Response', `${source}; return rkReaderFetch;`)(answer, Response);
    const pageAnswer = (text) => async () => new Response(JSON.stringify({ title: 'Page', textContent: text, content: `<p>${text}</p>` }));
    const article = { title: 'Feed title', source: 'Caixin', rkContent: '<p>' + '全文'.repeat(3000) + '</p>' };

    const paywalled = await (await readerFetch(pageAnswer('Teaser'))(article, 'u', {})).json();
    assert.deepEqual(paywalled, { title: 'Feed title', siteName: 'Caixin', content: article.rkContent });
    const fuller = await (await readerFetch(pageAnswer('x'.repeat(7000)))(article, 'u', {})).json();
    assert.equal(fuller.title, 'Page');
    const failed = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
    assert.equal((await (await readerFetch(failed)(article, 'u', {})).json()).content, article.rkContent);
    const refused = async () => new Response('{"error":"Blocked"}', { status: 403 });
    assert.equal((await (await readerFetch(refused)(article, 'u', {})).json()).content, article.rkContent);
    // Without feed text (or opened by address) the reader gets the page's answer as it was.
    const original = new Response('{}', { status: 502 });
    assert.equal(await readerFetch(async () => original)({ title: 't', rkContent: '' }, 'u', {}), original);
    assert.equal(await readerFetch(async () => original)(null, 'u', {}), original);
    await assert.rejects(readerFetch(failed)(null, 'u', {}), /aborted/);
});

test('RSS 2.0 items come out in rss2json\'s fields', () => {
    const { feed, items } = parseFeed(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>财新网 - 最新文章</title>
    <link>https://www.caixin.com/</link>
    <atom:link href="https://example.com/feed.xml" rel="self" xmlns:atom="http://www.w3.org/2005/Atom"/>
    <description>Full text</description>
    <image><url>https://example.com/logo.png</url></image>
    <item>
      <title>First &amp; foremost</title>
      <link>https://example.com/1</link>
      <guid isPermaLink="false">id-1</guid>
      <pubDate>Mon, 02 Nov 2026 14:02:00 +0800</pubDate>
      <dc:creator>Reporter</dc:creator>
      <category>#政经频道</category>
      <category>Economy</category>
      <description><![CDATA[<p>Summary</p>]]></description>
      <content:encoded><![CDATA[<p>Whole <b>article</b></p>]]></content:encoded>
      <media:thumbnail url="https://example.com/t.jpg"/>
    </item>
    <item>
      <title>Second</title>
      <guid>https://example.com/2</guid>
      <description>Only a description</description>
      <enclosure url="https://example.com/2.png" type="image/png" length="123"/>
    </item>
  </channel>
</rss>`);
    assert.deepEqual(feed, { title: '财新网 - 最新文章', link: 'https://www.caixin.com/', author: '', description: 'Full text', image: 'https://example.com/logo.png' });
    assert.deepEqual(items[0], {
        title: 'First & foremost',
        pubDate: '2026-11-02 06:02:00',
        link: 'https://example.com/1',
        guid: 'id-1',
        author: 'Reporter',
        thumbnail: 'https://example.com/t.jpg',
        description: '<p>Summary</p>',
        content: '<p>Whole <b>article</b></p>',
        enclosure: {},
        categories: ['#政经频道', 'Economy']
    });
    // No <link>: a permalink guid stands in. No content:encoded: the description.
    assert.equal(items[1].link, 'https://example.com/2');
    assert.equal(items[1].content, 'Only a description');
    assert.equal(items[1].pubDate, '');
    assert.deepEqual(items[1].enclosure, { link: 'https://example.com/2.png', type: 'image/png', length: 123 });
    assert.equal(items[1].thumbnail, 'https://example.com/2.png');
});

test('Atom entries: alternate link, xhtml content, category terms', () => {
    const { feed, items } = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <title>The Site</title>
  <subtitle>News</subtitle>
  <link rel="self" href="https://example.com/atom.xml"/>
  <link rel="alternate" href="https://example.com/"/>
  <icon>https://example.com/i.png</icon>
  <entry>
    <title type="html">Peacock &amp;amp; YouTube</title>
    <id>tag:example.com,2026:1</id>
    <link rel="replies" href="https://example.com/1#comments"/>
    <link rel="alternate" type="text/html" href="https://example.com/1"/>
    <published>2026-11-02T10:00:00-05:00</published>
    <updated>2026-11-02T12:00:00Z</updated>
    <author><name>Writer</name></author>
    <category term="Tech"/>
    <summary type="html">&lt;p&gt;Short&lt;/p&gt;</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Long <em>text</em></p></div></content>
    <media:group><media:thumbnail url="https://example.com/yt.jpg"/></media:group>
  </entry>
</feed>`);
    assert.deepEqual(feed, { title: 'The Site', link: 'https://example.com/', author: '', description: 'News', image: 'https://example.com/i.png' });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Peacock &amp; YouTube');
    assert.equal(items[0].link, 'https://example.com/1');
    assert.equal(items[0].guid, 'tag:example.com,2026:1');
    assert.equal(items[0].pubDate, '2026-11-02 15:00:00');
    assert.equal(items[0].author, 'Writer');
    assert.equal(items[0].description, '<p>Short</p>');
    assert.equal(items[0].content, '<p>Long <em>text</em></p>');
    assert.equal(items[0].thumbnail, 'https://example.com/yt.jpg');
    assert.deepEqual(items[0].categories, ['Tech']);
});

test('RSS 1.0 items sit next to the channel', () => {
    const { feed, items } = parseFeed(`<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com/"><title>RDF site</title><link>https://example.com/</link></channel>
  <item rdf:about="https://example.com/a"><title>A</title><link>https://example.com/a</link><dc:date>2026-11-01T08:00:00Z</dc:date></item>
  <item rdf:about="https://example.com/b"><title>B</title><link>https://example.com/b</link></item>
</rdf:RDF>`);
    assert.equal(feed.title, 'RDF site');
    assert.deepEqual(items.map((i) => [i.title, i.link, i.pubDate]), [
        ['A', 'https://example.com/a', '2026-11-01 08:00:00'],
        ['B', 'https://example.com/b', '']
    ]);
});

test('a web page is not a feed', () => {
    assert.throws(() => parseFeed('<!doctype html><html><body>Hi</body></html>'), /not a valid RSS feed/);
});

test('the XML declaration\'s encoding decodes GBK feeds; the HTTP charset wins', () => {
    const gbk = Buffer.concat([
        Buffer.from('<?xml version="1.0" encoding="GBK"?><rss><channel><title>'),
        Buffer.from([0xb2, 0xc6, 0xd0, 0xc2]), // 财新
        Buffer.from('</title></channel></rss>')
    ]);
    assert.match(decode(gbk, 'text/xml'), /<title>财新<\/title>/);
    assert.match(decode(Buffer.from('<rss>é</rss>', 'latin1'), 'text/xml; charset=ISO-8859-1'), /é/);
    assert.equal(decode(Buffer.from('﻿<rss/>'), ''), '<rss/>');
});

test('dates the reader cannot read are passed on as they are', () => {
    assert.equal(formatDate('Tue, 03 Nov 2026 01:02:03 GMT'), '2026-11-03 01:02:03');
    assert.equal(formatDate('someday'), 'someday');
});

test('errors answer HTTP 422 with rss2json\'s status and message', async () => {
    const answer = async (query) => {
        const res = { writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(body) { this.body = body; } };
        await handleFeed({ method: 'GET' }, res, new URL('http://x/__rk/rss2json' + query));
        return { status: res.status, body: JSON.parse(res.body) };
    };
    assert.deepEqual(await answer(''), { status: 422, body: { status: 'error', message: 'rss_url parameter is required and must be an http(s) address.' } });
    assert.deepEqual(await answer('?rss_url=file%3A%2F%2F%2Fetc%2Fpasswd'), { status: 422, body: { status: 'error', message: 'rss_url parameter is required and must be an http(s) address.' } });
    // This server's own network stays out of reach (netguard.js).
    const local = await answer('?rss_url=' + encodeURIComponent('http://127.0.0.1:9/feed.xml'));
    assert.equal(local.status, 422);
    assert.equal(local.body.status, 'error');
});
