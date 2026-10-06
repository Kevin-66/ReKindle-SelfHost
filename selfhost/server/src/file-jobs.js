// Background jobs that end in a file for the Kindle to download: Z-Library books
// (zlibrary-account.js) and Manga chapters as AZW3 (manga-azw3.js). Fetching and
// converting can take minutes, longer than a page request should wait behind a proxy,
// so the page starts a job, asks how it is going, and downloads the file when it is
// ready. Each job works in its own temporary folder; a finished file is kept for
// KEEP_MS (the Kindle may retry), then the folder goes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const KEEP_MS = 30 * 60 * 1000;

// An error whose message is meant for the reader.
export function userError(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code, userMessage: message });
}

export function jobStore() {
    const jobs = new Map();
    setInterval(() => {
        const now = Date.now();
        for (const [id, job] of jobs) {
            if (job.finished && now - job.finished > KEEP_MS) {
                if (job.dir) fs.rmSync(job.dir, { recursive: true, force: true });
                jobs.delete(id);
            }
        }
    }, 60000).unref();
    return {
        get: (id) => jobs.get(String(id || '')),
        working: () => [...jobs.values()].filter((job) => job.status === 'working'),
        // Starts `work(job, dir)`, which returns { file, name } in dir; returns the job.
        start(fields, work, failMessage) {
            const job = { ...fields, id: crypto.randomBytes(16).toString('base64url'), status: 'working', started: Date.now() };
            jobs.set(job.id, job);
            job.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rk-job-'));
            Promise.resolve().then(() => work(job, job.dir)).then(({ file, name }) => {
                Object.assign(job, { status: 'ready', file, name, size: fs.statSync(file).size, finished: Date.now() });
            }, (error) => {
                fs.rmSync(job.dir, { recursive: true, force: true });
                Object.assign(job, { status: 'failed', message: error.userMessage || failMessage, finished: Date.now() });
            });
            return job;
        }
    };
}

// Writes a fetch Response's body to `file`.
export async function saveBody(res, file) {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    return file;
}

export const isReady = (job) => !!job && job.status === 'ready' && fs.existsSync(job.file);

// Sends a ready job's file as a download named job.name.
export function sendJobFile(res, job, contentType) {
    const ascii = job.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.name)}`,
        'Content-Length': job.size,
        'Cache-Control': 'no-store'
    });
    fs.createReadStream(job.file).on('error', () => res.destroy()).pipe(res);
}
