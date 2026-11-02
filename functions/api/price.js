// Yahoo Finance chart proxy.
//
// Every stocks page view used to hit Yahoo directly (shared Cloudflare egress,
// which Yahoo rate-limits), and a miss fell straight through to a second host
// with no cache. Use the edge cache like functions/api/reddit.js:
//   - short-TTL entry keyed on symbol+interval+range, shared by all users
//   - long-TTL "last good" entry so a rate-limited upstream still renders
const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36";

// Letters, digits and the punctuation Yahoo actually uses in tickers (BRK-B,
// BTC-USD, ^GSPC, EURUSD=X). Also keeps the string safe in a cache key.
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,16}$/;

function ttlFor(interval, range) {
    if (interval === "1d" || interval === "1wk" || interval === "1mo") return 300;
    if (range === "1d") return 30;
    return 60;
}

function jsonResponse(payload, status, extra) {
    const headers = Object.assign(
        {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=30",
        },
        extra || {}
    );
    return new Response(JSON.stringify(payload), { status: status || 200, headers });
}

async function fetchYahoo(symbol, interval, range, host) {
    const target = `https://${host}/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
    return fetch(target, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const symbol = (url.searchParams.get("symbol") || "").trim();
    const interval = url.searchParams.get("interval") || "60m";
    const range = url.searchParams.get("range") || "1d";

    if (!symbol) {
        return jsonResponse({ error: "Symbol required" }, 400);
    }
    if (!SYMBOL_RE.test(symbol)) {
        return jsonResponse({ error: "Invalid symbol" }, 400);
    }

    const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
    const scope = `${symbol.toUpperCase()}/${interval}/${range}`;
    const cacheKey = cache ? new Request(`https://price.cache.rekindle.internal/${scope}`) : null;
    const lastGoodKey = cache ? new Request(`https://price.cache.rekindle.internal/last/${scope}`) : null;

    if (cache) {
        try {
            const hit = await cache.match(cacheKey);
            if (hit) return jsonResponse(await hit.json(), 200, { "X-ReKindle-Cache": "hit" });
        } catch (e) {
            // Cache read problems are never fatal.
        }
    }

    let response = null;
    try {
        response = await fetchYahoo(symbol, interval, range, "query1.finance.yahoo.com");
        // Rate limit or upstream error: one retry on the alternate host.
        if (!response.ok && (response.status === 429 || response.status >= 500)) {
            response = await fetchYahoo(symbol, interval, range, "query2.finance.yahoo.com");
        }
    } catch (e) {
        response = null;
    }

    if (response && response.ok) {
        let data;
        try {
            data = await response.json();
        } catch (e) {
            data = null;
        }
        if (data) {
            const ttl = ttlFor(interval, range);
            if (cache) {
                try {
                    const cached = jsonResponse(data, 200, { "Cache-Control": `public, max-age=${ttl}` });
                    await cache.put(cacheKey, cached.clone());
                    const lastGood = jsonResponse(data, 200, { "Cache-Control": "public, max-age=86400" });
                    await cache.put(lastGoodKey, lastGood.clone());
                } catch (e) {
                    // Caching is best-effort.
                }
            }
            return jsonResponse(data, 200, {
                "Cache-Control": `public, max-age=${ttl}`,
                "X-ReKindle-Cache": "miss",
            });
        }
    }

    // Upstream failed or rate-limited: serve the last good body rather than an error.
    if (cache) {
        try {
            const stale = await cache.match(lastGoodKey);
            if (stale) {
                return jsonResponse(await stale.json(), 200, {
                    "Cache-Control": "public, max-age=30",
                    "X-ReKindle-Cache": "stale",
                });
            }
        } catch (e) {
            // fall through to the error
        }
    }

    const status = response ? response.status : 502;
    return jsonResponse(
        { error: "Yahoo API Error", status },
        status === 404 ? 404 : 502
    );
}
