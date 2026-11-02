/**
 * Same-origin proxy for Project Gutenberg.
 *
 * gutenberg.org sends no CORS headers, so the reader page cannot fetch its
 * catalogue or book text directly from the browser. This Function does the
 * fetch, caches it at the edge, and hands it back with permissive CORS.
 *
 *   GET /api/gutenberg?url=https%3A%2F%2Fwww.gutenberg.org%2Fcache%2Fepub%2F98%2Fpg98.txt
 *
 * Only gutenberg.org / www.gutenberg.org are allowed through. The host check
 * happens before any request is made.
 */

const ALLOWED_HOSTS = ['gutenberg.org', 'www.gutenberg.org'];

const UPSTREAM_TIMEOUT = 15000;
const MAX_ATTEMPTS = 3; // initial request + 2 retries

const TEXT_TTL = 86400; // book text and other text/plain payloads
const OPDS_TTL = 1800;  // Atom/OPDS catalogue feeds
const DEFAULT_TTL = 3600;

export async function onRequest(context) {
    const request = context.request;
    const method = request.method;

    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        return errorResponse(400, 'missing_url');
    }

    let target;
    try {
        target = new URL(targetUrl);
    } catch (e) {
        return errorResponse(400, 'invalid_url');
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return errorResponse(403, 'forbidden');
    }

    if (!isAllowedHost(target.hostname)) {
        return errorResponse(403, 'forbidden');
    }

    if (method !== 'GET' && method !== 'HEAD') {
        return errorResponse(405, 'method_not_allowed');
    }

    const targetKey = target.toString();
    const cache = (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
    const cacheKey = cache ? new Request(targetKey, { method: 'GET' }) : null;

    // Edge cache first: one copy of a book text shared by every reader.
    if (cache && cacheKey && method === 'GET') {
        try {
            const cached = await cache.match(cacheKey);
            if (cached) {
                return withCors(cached);
            }
        } catch (e) {
            // Cache reads are best effort; fall through to the origin.
        }
    }

    const upstreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'application/atom+xml,application/xml,text/xml;q=0.9,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate'
    };

    let lastResponse = null;
    let timedOut = false;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
            await sleep(retryDelay(lastResponse, attempt));
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
        let response = null;

        try {
            response = await fetch(targetKey, {
                method: method,
                headers: upstreamHeaders,
                redirect: 'follow',
                signal: controller.signal
            });
        } catch (e) {
            response = null;
        } finally {
            clearTimeout(timer);
        }

        if (controller.signal.aborted) {
            timedOut = true;
            lastResponse = null;
            break;
        }

        lastResponse = response;

        if (!response) {
            // Network-level failure: retry.
            continue;
        }

        // Rate limited or upstream error: retry with backoff.
        if (response.status === 429 || response.status >= 500) {
            continue;
        }

        break;
    }

    if (!lastResponse) {
        return errorResponse(timedOut ? 504 : 502, timedOut ? 'timeout' : 'upstream');
    }

    if (lastResponse.status === 429 || lastResponse.status >= 500) {
        return errorResponse(502, 'upstream');
    }

    const maxAge = cacheTtl(target, lastResponse.headers.get('content-type'));
    const headers = new Headers(lastResponse.headers);
    headers.set('Cache-Control', 'public, max-age=' + maxAge);
    headers.delete('Set-Cookie');

    if (method === 'HEAD') {
        return new Response(null, {
            status: lastResponse.status,
            statusText: lastResponse.statusText,
            headers: withCorsHeaders(headers)
        });
    }

    if (cache && cacheKey && lastResponse.status === 200 && lastResponse.body) {
        try {
            // Split the body: one copy for the edge cache, one for the client.
            const [cacheBody, clientBody] = lastResponse.body.tee();

            const cacheResponse = new Response(cacheBody, {
                status: lastResponse.status,
                statusText: lastResponse.statusText,
                headers: new Headers(headers)
            });

            const storePromise = cache.put(cacheKey, cacheResponse).catch(function () { });
            if (typeof context.waitUntil === 'function') {
                context.waitUntil(storePromise);
            } else {
                await storePromise;
            }

            return new Response(clientBody, {
                status: lastResponse.status,
                statusText: lastResponse.statusText,
                headers: withCorsHeaders(headers)
            });
        } catch (e) {
            // Body already consumed or tee unavailable: fall through uncached.
        }
    }

    return new Response(lastResponse.body, {
        status: lastResponse.status,
        statusText: lastResponse.statusText,
        headers: withCorsHeaders(headers)
    });
}

function isAllowedHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return ALLOWED_HOSTS.indexOf(host) !== -1;
}

function cacheTtl(target, contentType) {
    const path = String(target.pathname || '').toLowerCase();
    const ct = String(contentType || '').toLowerCase();

    if (path.endsWith('.opds') || ct.indexOf('opds') !== -1 || ct.indexOf('atom') !== -1) {
        return OPDS_TTL;
    }
    if (path.endsWith('.txt') || path.endsWith('.txt.utf-8') || ct.indexOf('text/plain') !== -1) {
        return TEXT_TTL;
    }
    return DEFAULT_TTL;
}

function retryDelay(response, attempt) {
    if (response && response.headers) {
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
            const seconds = parseInt(retryAfter, 10);
            if (!isNaN(seconds) && seconds > 0) {
                return Math.min(seconds * 1000, 10000);
            }
        }
    }
    return attempt === 1 ? 400 : 1200;
}

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function corsHeaders() {
    const h = new Headers();
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Methods', 'GET, HEAD');
    h.set('Access-Control-Max-Age', '86400');
    return h;
}

function withCorsHeaders(headers) {
    const h = new Headers(headers);
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Methods', 'GET, HEAD');
    return h;
}

function withCors(response) {
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: withCorsHeaders(response.headers)
    });
}

function errorResponse(status, code) {
    const headers = withCorsHeaders(new Headers());
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ error: code }), {
        status: status,
        headers: headers
    });
}
