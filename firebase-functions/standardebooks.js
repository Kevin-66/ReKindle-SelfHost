/**
 * Standard Ebooks relay for rekindle.ink
 *
 * reader.html's Standard Ebooks tab used to fetch
 * https://standardebooks.org/feeds/rss/new-releases through /api/proxy (a
 * Cloudflare Pages Function). Since 2026-10 every one of those requests comes
 * back as an Apache "403 Forbidden":
 *
 *   [Error] Standard Ebooks feed error - Error: Status 403
 *
 * Cause: standardebooks.org blocks Cloudflare's egress (AS132892, the
 * Workers/Pages network). The proxy function and its request headers are fine —
 * the same URL returns 200 from a normal residential IP with the exact same
 * User-Agent, and every path on standardebooks.org (/ebooks, /feeds/opds/...,
 * a book page) is 403 through the proxy, while example.com is 200. Two
 * unrelated Cloudflare Workers produced the same 403, so this is an IP/ASN
 * block, not a User-Agent or header rule. Standard Ebooks answers direct
 * requests that carry a `CF-Connecting-IP` header with the same 403, which is
 * the same signal their WAF keys off.
 *
 * Therefore the feed and EPUB downloads have to leave through a network that
 * is not Cloudflare. This function runs on Google Cloud (us-central1), which is
 * allowed, and is the same workaround family as the Akinator relay (see
 * `akinator-service/` — that one needed a Chrome TLS fingerprint, this one does
 * not: plain global `fetch` works).
 *
 * Contract: GET/HEAD /?url=<encoded https://standardebooks.org/...>
 *   - single-host allowlist (standardebooks.org), https only
 *   - path allowlist (/feeds/ and /ebooks/, i.e. the catalogue feed and the
 *     EPUB downloads; cover images are <img> loads straight from the browser
 *     and never need a proxy)
 *   - follows redirects (/feeds/rss/* 301s to /feeds/atom/*)
 *   - 3 attempts on 429/5xx with backoff, honouring Retry-After
 *   - feed responses cached in memory per instance (30 min); browsers get
 *     Cache-Control so the 64 KB feed is not re-fetched on every tab open
 *
 * Cost: no Firestore/RTDB/Auth access. maxInstances caps cold starts.
 */

const ALLOWED_ORIGINS = [
    "https://rekindle.ink",
    "https://beta.rekindle.ink",
    "https://lite.rekindle.ink",
    "https://legacy.rekindle.ink",
    "https://rekindle.pages.dev",
    "http://localhost:8788",
    "http://localhost:3000",
    "http://localhost:8000"
];

// www.standardebooks.org 301s to the apex host; accepted so a feed that ever
// emits www URLs still resolves instead of failing the allowlist.
const ALLOWED_HOSTS = ["standardebooks.org", "www.standardebooks.org"];
// The only paths reader.html needs.
const ALLOWED_PATH_PREFIXES = ["/feeds/", "/ebooks/"];

const USER_AGENT = "ReKindle-App/1.0 (+https://rekindle.ink)";

const FEED_TIMEOUT_MS = 20000;
const DOWNLOAD_TIMEOUT_MS = 55000;
const FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const FEED_CACHE_MAX_ENTRIES = 4;

// Per-instance feed cache: { url -> { expires, status, contentType, body } }.
const feedCache = new Map();

// Per-instance token bucket. Cheap abuse guard only: Cloud Functions has no
// shared cache, and maxInstances caps the blast radius anyway. One feed fetch
// plus one request per downloaded book is normal use, so 60/min per IP is far
// above anything a reader does while still stopping a scripted crawl.
const RATE_CAPACITY = 60;
const RATE_REFILL_PER_SEC = 1;
const buckets = new Map();

function clientIp(req) {
    const forwarded = req.headers && req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
    if (req.ip) return req.ip;
    if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
    return "unknown";
}

function allowRequest(req) {
    const ip = clientIp(req);
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket) {
        bucket = { tokens: RATE_CAPACITY, last: now };
        buckets.set(ip, bucket);
        if (buckets.size > 5000) buckets.clear();
    }
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + ((now - bucket.last) / 1000) * RATE_REFILL_PER_SEC);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
}

function applyCors(req, res) {
    const origin = req.headers && req.headers.origin;
    if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
        res.set("Access-Control-Allow-Origin", origin);
    } else {
        res.set("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
    }
    res.set("Vary", "Origin");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "86400");
}

function sendError(res, status, code, message) {
    res.status(status).json({ error: code, message: message });
}

function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isAllowedPath(pathname) {
    for (let i = 0; i < ALLOWED_PATH_PREFIXES.length; i++) {
        if (pathname.indexOf(ALLOWED_PATH_PREFIXES[i]) === 0) return true;
    }
    return false;
}

function parseTarget(raw) {
    let target;
    try {
        target = new URL(String(raw));
    } catch (e) {
        return null;
    }
    if (target.protocol !== "https:") return null;
    if (ALLOWED_HOSTS.indexOf(target.hostname.toLowerCase()) === -1) return null;
    if (!isAllowedPath(target.pathname)) return null;
    return target;
}

function retryDelayMs(res, attempt) {
    const header = res && res.headers.get("retry-after");
    const secs = parseInt(header || "0", 10);
    if (secs > 0) return Math.min(secs * 1000, 3000);
    return 400 * Math.pow(3, attempt);
}

async function fetchUpstream(target, timeoutMs, attempts) {
    const maxAttempts = attempts || 3;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
        try {
            const upstream = await fetch(target.toString(), {
                method: "GET",
                redirect: "follow",
                headers: {
                    "User-Agent": USER_AGENT,
                    // Ask for exactly what we can use; Standard Ebooks serves
                    // the Atom feed for both, redirects are followed anyway.
                    "Accept": "application/atom+xml, application/xml, application/epub+zip, */*"
                },
                signal: controller.signal
            });
            clearTimeout(timer);

            const retryable = upstream.status === 429 || upstream.status >= 500;
            if (retryable && attempt < maxAttempts - 1) {
                const delay = retryDelayMs(upstream, attempt);
                // Drain the body so the socket is released before retrying.
                try { await upstream.arrayBuffer(); } catch (e) { /* ignore */ }
                await sleep(delay);
                continue;
            }
            return upstream;
        } catch (e) {
            clearTimeout(timer);
            lastError = e;
            if (attempt < maxAttempts - 1) {
                await sleep(400 * Math.pow(3, attempt));
            }
        }
    }

    throw lastError || new Error("upstream fetch failed");
}

async function standardEbooksHandler(req, res) {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "method_not_allowed", "Use GET or HEAD");
        return;
    }
    if (!allowRequest(req)) {
        sendError(res, 429, "rate_limited", "Too many requests, slow down");
        return;
    }

    const raw = req.query && req.query.url;
    if (!raw) {
        sendError(res, 400, "missing_url", "Missing url parameter");
        return;
    }

    const target = parseTarget(raw);
    if (!target) {
        sendError(res, 403, "host_not_allowed",
            "Only https://standardebooks.org/feeds/ and /ebooks/ URLs are allowed");
        return;
    }

    const isFeed = target.pathname.indexOf("/feeds/") === 0;
    const isDownload = target.pathname.indexOf("/downloads/") !== -1;
    const timeoutMs = isFeed ? FEED_TIMEOUT_MS : DOWNLOAD_TIMEOUT_MS;

    // HEAD is answered from the same cached GET body where possible so a
    // HEAD probe does not cost an upstream request.
    const cached = isFeed ? feedCache.get(target.toString()) : null;
    if (cached && cached.expires > Date.now() && (req.method === "GET" || req.method === "HEAD")) {
        res.set("Cache-Control", "public, max-age=1800");
        res.set("Content-Type", cached.contentType);
        res.status(cached.status);
        if (req.method === "HEAD") {
            res.set("Content-Length", String(cached.body.length));
            res.end();
        } else {
            res.send(cached.body);
        }
        return;
    }

    let upstream;
    try {
        upstream = await fetchUpstream(target, timeoutMs, 3);
    } catch (e) {
        console.error("standardebooks relay error:", e && e.message ? e.message : e);
        sendError(res, 502, "upstream_unreachable", "Standard Ebooks is unreachable");
        return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    res.set("Content-Type", contentType);
    res.set("Cache-Control", isDownload
        ? "public, max-age=86400"
        : (isFeed ? "public, max-age=1800" : "public, max-age=3600"));

    if (req.method === "HEAD") {
        const length = upstream.headers.get("content-length");
        if (length) res.set("Content-Length", length);
        res.status(upstream.status).end();
        return;
    }

    let body;
    try {
        body = Buffer.from(await upstream.arrayBuffer());
    } catch (e) {
        console.error("standardebooks relay body error:", e && e.message ? e.message : e);
        sendError(res, 502, "upstream_body_failed", "Failed to read Standard Ebooks response");
        return;
    }

    // Keep successful feed bodies only; failures are never cached.
    if (isFeed && upstream.status === 200) {
        if (feedCache.size >= FEED_CACHE_MAX_ENTRIES) {
            feedCache.delete(feedCache.keys().next().value);
        }
        feedCache.set(target.toString(), {
            expires: Date.now() + FEED_CACHE_TTL_MS,
            status: upstream.status,
            contentType: contentType,
            body: body
        });
    }

    res.status(upstream.status).send(body);
}

module.exports = { standardEbooksHandler, ALLOWED_ORIGINS, allowRequest, RATE_CAPACITY };
