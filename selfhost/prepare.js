#!/usr/bin/env node
// Copies the ReKindle site into a build folder and applies the self-hosting
// edits (see server/src/transform.js). The repository itself is not changed,
// so upstream updates merge cleanly.
//
// Usage: node selfhost/prepare.js <repo dir> <output dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformHtml, transformJs } from './server/src/transform.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const [src = path.resolve(here, '..'), out = path.join(here, '.build')] = process.argv.slice(2);

// Backend code, tooling and data that must not end up on the website.
// (package.json, build-automation.js and scripts/ are kept: the build needs them
// and leaves them out of its output.)
const EXCLUDE = new Set([
    '.git', '.github', 'node_modules', '_deploy', 'selfhost',
    'workers', 'firebase-functions', 'functions', 'admin',
    'Dockerfile', 'docker-compose.yml', '.dockerignore', '.env', '.env.example'
]);

function copyTree(from, to, top) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (top && EXCLUDE.has(entry.name)) continue;
        if (entry.name === '.DS_Store') continue;
        const a = path.join(from, entry.name);
        const b = path.join(to, entry.name);
        if (entry.isDirectory()) {
            copyTree(a, b, false);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (ext === '.html') {
                fs.writeFileSync(b, transformHtml(fs.readFileSync(a, 'utf8'), entry.name));
            } else if (ext === '.js' && !(top && (entry.name === 'build-automation.js'))) {
                fs.writeFileSync(b, transformJs(fs.readFileSync(a, 'utf8'), entry.name));
            } else {
                fs.copyFileSync(a, b);
            }
        }
    }
}

fs.rmSync(out, { recursive: true, force: true });
copyTree(path.resolve(src), path.resolve(out), true);
fs.copyFileSync(path.join(here, 'client', 'rk-backend.js'), path.join(out, 'rk-backend.js'));
// Files this server adds to the site (e.g. the Manga app's Manhuagui add-on).
fs.cpSync(path.join(here, 'site'), path.resolve(out), { recursive: true });

// Sanity check: no page may still load the Firebase SDK from Google.
const leftovers = fs.readdirSync(out).filter((f) => f.endsWith('.html') && /www\.gstatic\.com\/firebasejs/.test(fs.readFileSync(path.join(out, f), 'utf8')));
if (leftovers.length) {
    console.error(`Firebase SDK still referenced in: ${leftovers.join(', ')}`);
    process.exit(1);
}
console.log(`Prepared self-hosted site in ${out}`);
