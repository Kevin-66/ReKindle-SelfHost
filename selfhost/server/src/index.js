import http from 'node:http';
import './cache.js'; // Cache API stand-in for the upstream /api functions
import { config } from './config.js';
import * as auth from './auth.js';
import { rtdb } from './rtdb.js';
import { ensureProfile } from './firestore.js';
import { handleApi, publicOrigin } from './api.js';
import { loadWorkers, handleWorker, handlePagesFunction } from './workers-host.js';
import { serveStatic, siteMode } from './static.js';
import { proxyEnabled } from './netguard.js';
import './functions-host.js';

await loadWorkers();

// Every account gets a profile document (ReKindle+ status is read from it).
if (config.plusForAll) {
    for (const u of auth.listUsers(100000, 0)) ensureProfile(u.uid);
}
auth.pruneSessions();
setInterval(() => auth.pruneSessions(), 24 * 3600 * 1000).unref();

function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
}

const server = http.createServer(async (req, res) => {
    const started = Date.now();
    if (config.logRequests) res.on('finish', () => console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
    let url;
    try {
        url = new URL(req.url, 'http://localhost');
    } catch {
        res.writeHead(400).end();
        return;
    }
    try {
        if (url.pathname.startsWith('/__rk/')) return await handleApi(req, res, url);
        if (url.pathname.startsWith('/api/')) {
            const name = url.pathname.slice(5).split('/')[0];
            if (await handlePagesFunction(req, res, name, `${publicOrigin(req)}${url.pathname}${url.search}`)) return;
            return notFound(res);
        }
        // Links handed out by the interactive-fiction story service.
        if (url.pathname.startsWith('/play/')) {
            if (await handleWorker(req, res, 'rekindle-story', url.pathname.slice(1), url.search, publicOrigin(req))) return;
        }
        if (serveStatic(req, res, url.pathname)) return;
        notFound(res);
    } catch (e) {
        console.error('[server]', e);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal server error');
        else res.destroy();
    }
});

server.requestTimeout = 0; // long-polls
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(config.port, config.host, () => {
    const admin = config.adminUsername ? config.adminUsername : (auth.userCount() ? auth.adminEmail().split('@')[0] : 'the first account you create');
    console.log(`ReKindle is running on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} (${siteMode()} mode)`);
    console.log(`  data: ${config.dataDir}`);
    console.log(`  admin: ${admin}`);
    console.log(`  ReKindle+ for everyone: ${config.plusForAll ? 'yes' : 'no'}; new accounts: ${config.allowRegistration ? 'open' : 'closed'}`);
    if (!config.geminiApiKey && !config.openaiApiKey) console.log('  handwriting recognition and Oracle AI: off (set GEMINI_API_KEY to turn on)');
    console.log(`  archive.today: ${proxyEnabled ? 'through PROXY_URL' : 'direct (set PROXY_URL if this server is blocked)'}`);
});

function shutdown() {
    console.log('Shutting down...');
    rtdb.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
