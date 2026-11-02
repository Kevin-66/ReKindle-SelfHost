/**
 * Express app for the Akinator Chrome-TLS relay.
 *
 * The HTTP contract is unchanged from the old Firebase function: POST a JSON
 * body with `action` = start | answer | back | continue. The handler in
 * `akinator.js` owns CORS, OPTIONS and the error envelope, so this file only
 * wires the server up and turns body-parser errors into the same JSON shape.
 */

const express = require("express");
const { akinatorHandler } = require("./akinator");

const app = express();

app.disable("x-powered-by");
// Northflank (and any reverse proxy) terminates TLS and forwards the caller in
// X-Forwarded-For. `trust proxy` makes req.ip meaningful as a fallback for
// clientIp(); the handler still prefers the first XFF entry.
app.set("trust proxy", true);

app.use(express.json({ limit: "16kb" }));

// Uptime / health check: never calls Akinator, so a monitor can poll it.
app.get("/healthz", function (req, res) {
    res.status(200).json({ ok: true });
});

// The old Firebase function lived at one URL, so the root path is canonical.
// /akinator is accepted too in case the service is ever mounted behind a path.
app.all(["/", "/akinator"], akinatorHandler);

// Express's default body-parser failure is an HTML error page. The client
// expects { error, message }, so keep the relay's contract for malformed JSON
// and oversized bodies.
app.use(function (err, req, res, next) {
    if (err && (err.type === "entity.parse.failed" || err.type === "entity.too.large")) {
        res.status(400).json({ error: "bad_request", message: "Invalid JSON body" });
        return;
    }
    console.error("akinator service error:", err);
    res.status(500).json({ error: "internal", message: "Relay error" });
});

module.exports = { app };
