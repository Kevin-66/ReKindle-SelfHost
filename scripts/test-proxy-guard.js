/*
 * Guards for the /api/proxy function.
 *
 * Run: node scripts/test-proxy-guard.js
 *
 * The proxy is an SSRF boundary: these tests assert that private/link-local
 * targets, non-http schemes, URL credentials, and non-GET methods are rejected
 * before any outbound fetch happens.
 */
const assert = require('assert');

(async () => {
    const proxy = await import('../functions/api/proxy.js');
    const { validateProxyUrl, isForbiddenHost, originAllowed, readBodyWithLimit, onRequest } = proxy;

    function assertBlocked(url, reason) {
        const result = validateProxyUrl(url);
        assert.strictEqual(result.ok, false, `expected ${url} to be blocked`);
        if (reason) assert.strictEqual(result.reason, reason, `${url} reason`);
    }

    assert.strictEqual(validateProxyUrl('https://example.com/a').ok, true);
    assert.strictEqual(validateProxyUrl('http://example.com/a').ok, true);

    const blockedHosts = [
        'http://127.0.0.1/',
        'http://127.1.2.3/',
        'http://localhost/',
        'http://foo.localhost/',
        'http://10.0.0.1/',
        'http://172.16.0.1/',
        'http://192.168.1.1/',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/',
        'http://[fc00::1]/',
        'http://[fe80::1]/',
        'http://metadata.google.internal/',
        'http://127.0.0.1.nip.io/',
        'http://localtest.me/',
        'http://2130706433/'
    ];
    blockedHosts.forEach(url => assertBlocked(url, 'forbidden_host'));

    assert.strictEqual(isForbiddenHost('example.com'), false);
    assert.strictEqual(isForbiddenHost('sub.example.com'), false);
    assert.strictEqual(isForbiddenHost('localhost'), true);
    assert.strictEqual(isForbiddenHost('10.1.2.3'), true);
    assert.strictEqual(isForbiddenHost('0.0.0.0'), true);
    assert.strictEqual(isForbiddenHost('224.0.0.1'), true);

    assertBlocked('ftp://example.com/', 'forbidden_protocol');
    assertBlocked('file:///etc/passwd', 'forbidden_protocol');
    assertBlocked('http://user:pass@example.com/', 'credentials_in_url');
    assertBlocked('not a url', 'invalid_url');

    assert.strictEqual(originAllowed(''), true);
    assert.strictEqual(originAllowed('https://rekindle.ink'), true);
    assert.strictEqual(originAllowed('https://beta.rekindle.ink'), true);
    assert.strictEqual(originAllowed('https://evil.example'), false);
    assert.strictEqual(originAllowed('null'), false);

    // Method / target handling before any fetch.
    const post = await onRequest({
        request: new Request('https://rekindle.ink/api/proxy?url=https://example.com', { method: 'POST' })
    });
    assert.strictEqual(post.status, 405);

    const privateTarget = await onRequest({
        request: new Request('https://rekindle.ink/api/proxy?url=http://169.254.169.254/latest/meta-data')
    });
    assert.strictEqual(privateTarget.status, 403);

    // Redirects are re-validated before the next hop.
    const realFetch = global.fetch;
    try {
        let calls = 0;
        global.fetch = async function () {
            calls++;
            return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
        };
        const redirected = await onRequest({
            request: new Request('https://rekindle.ink/api/proxy?url=https://example.com/start')
        });
        assert.strictEqual(redirected.status, 403);
        assert.strictEqual(calls, 1);
    } finally {
        global.fetch = realFetch;
    }

    // 304/204/205 must not be constructed with a body.
    try {
        global.fetch = async function () {
            return new Response(null, { status: 304, headers: { etag: 'x' } });
        };
        const notModified = await onRequest({
            request: new Request('https://rekindle.ink/api/proxy?url=https://example.com/etag')
        });
        assert.strictEqual(notModified.status, 304);
    } finally {
        global.fetch = realFetch;
    }

    // Size ceiling helper.
    const big = new Response('x'.repeat(64));
    await assert.rejects(() => readBodyWithLimit(big, 8), /too_large/);

    const small = new Response('12345678');
    const bytes = await readBodyWithLimit(small, 8);
    assert.strictEqual(bytes.byteLength, 8);

    console.log('PASS - proxy guard');
})().catch(err => {
    console.error('FAIL - proxy guard:', err);
    process.exit(1);
});
