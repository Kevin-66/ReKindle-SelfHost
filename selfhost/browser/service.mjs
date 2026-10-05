// Private browser sidecar. Only the ReKindle process in this pod can reach it.
import http from 'node:http';
import { loadBrowserCatalogue, closeCatalogueBrowser } from './zlibrary-browser.mjs';

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('ok'); return; }
    if (req.method !== 'POST' || req.url !== '/catalogue') { res.writeHead(404).end(); return; }
    try {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 4096) { res.writeHead(413).end(); return; }
        }
        let input;
        try { input = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
        if (!input || typeof input.url !== 'string') { res.writeHead(400).end(); return; }
        const html = await loadBrowserCatalogue(input.url);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
    } catch (error) {
        res.writeHead(error.status === 429 ? 429 : 502, { 'Content-Type': 'text/plain' }).end('Catalogue browser unavailable');
    }
});
server.requestTimeout = 70000;
server.listen(8091, '127.0.0.1', () => console.log('ReKindle catalogue browser ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    server.close();
    await closeCatalogueBrowser();
    process.exit(0);
});
