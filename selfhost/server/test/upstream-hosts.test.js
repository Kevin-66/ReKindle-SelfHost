// node --test selfhost/server/test/upstream-hosts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformHtml, transformJs } from '../src/transform.js';

test('old devices go to /legacy/ and /lite/ here, and the page still names the hosts', () => {
    const page = '<html><head></head><body><script>/* Traffic Cop */\n' +
        'if (isKobo) window.location.href = "https://legacy.rekindle.ink/" + search;\n' +
        'if (isKindle) window.location.href = "https://lite.rekindle.ink/" + search;\n' +
        '</script></body></html>';
    const out = transformHtml(page, 'index.html');
    const script = /<script>(\/\* Traffic Cop[\s\S]*?)<\/script>/.exec(out)[1];
    // The build's device-routing check (build-automation.js DEVICE_ROUTE_CHECKS).
    assert.match(script, /isKobo[\s\S]*?legacy\.rekindle\.ink/);
    assert.match(script, /isKindle[\s\S]*?lite\.rekindle\.ink/);
    const go = [];
    new Function('isKobo', 'isKindle', 'search', 'window', 'go', script.replace(/window\.location\.href = /g, 'go.push(').replace(/search;/g, 'search);'))
        .call(null, true, true, '?a=1', {}, go);
    assert.deepEqual(go, ['/legacy/?a=1', '/lite/?a=1']);
});

test('upstream Worker addresses point at this server, on either Workers account', () => {
    const out = transformJs([
        "fetch('https://rekindle-moderate.rekindle-social.workers.dev/check')",
        'const OCR = "https://rekindle-ocr.timjarnott.workers.dev";',
        'see https://story.timjarnott.workers.dev/x'
    ].join('\n'), 'x.js');
    assert.match(out, /location\.host \+ '\/__rk\/w\/rekindle-moderate\/check'/);
    assert.match(out, /location\.host \+ "\/__rk\/w\/rekindle-ocr"/);
    assert.match(out, /see \/__rk\/w\/rekindle-story\/x/);
    assert.doesNotMatch(out, /workers\.dev/);
});

test('the RSS reader and Newspaper fetch feeds from this server, not rss2json.com', () => {
    const reader = transformHtml("<html><head></head><body><script>const api = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(feed.url) + '&count=' + fetchCount;</script></body></html>", 'rssreader.html');
    const paper = transformHtml('<html><head></head><body><script>const RSS_BASE = "https://api.rss2json.com/v1/api.json?rss_url=";</script></body></html>', 'newspaper.html');
    assert.match(reader, /const api = '\/__rk\/rss2json\?rss_url=' \+ encodeURIComponent\(feed\.url\)/);
    assert.match(paper, /const RSS_BASE = "\/__rk\/rss2json\?rss_url=";/);
    assert.doesNotMatch(reader + paper, /rss2json\.com/);
});

test('upstream HTTP Cloud Functions run here at /__rk/fn/<name>', () => {
    const out = transformJs([
        'const SUBSTACK_API = "https://us-central1-rekindle-dd1fa.cloudfunctions.net/substack";',
        "var SE = 'https://us-central1-rekindle-dd1fa.cloudfunctions.net/standardebooks?url=';"
    ].join('\n'), 'x.js');
    assert.match(out, /SUBSTACK_API = \(location\.protocol \+ '\/\/' \+ location\.host \+ "\/__rk\/fn\/substack"\)/);
    assert.match(out, /location\.host \+ '\/__rk\/fn\/standardebooks\?url='/);
    assert.doesNotMatch(out, /cloudfunctions\.net/);
});
