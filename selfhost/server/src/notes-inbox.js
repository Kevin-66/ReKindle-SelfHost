// Notes upload link: lets an AI agent (or any script) add notes to a reader's Notes
// app with one HTTP request and no sign-in. Each account gets a secret link,
// /__rk/notes/inbox/<key>, shown in the Notes app (Agent button), where it can also be
// replaced. The link can only ADD notes: it cannot read, change or delete anything, so
// handing it to an agent risks at most unwanted notes. A wrong key gets 404.
//
// POST <link> with the note as Markdown (any text Content-Type), or JSON
// {"title": "...", "markdown": "..."}. The Markdown becomes the note's HTML
// (markdown.js, escaped, so nothing in it can run) in users/{uid}/notes/{id}, written
// like the app's own saves, so an open Notes list shows it at once.

import crypto from 'node:crypto';
import { db } from './db.js';
import * as fsStore from './firestore.js';
import { markdownToHtml } from './markdown.js';

export const MAX_BYTES = 256 * 1024;
const MAX_TITLE = 200;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const byUid = db.prepare('SELECT key FROM notes_inbox WHERE uid = ?');
const byKey = db.prepare('SELECT uid FROM notes_inbox WHERE key = ?');
const putRow = db.prepare('INSERT INTO notes_inbox(uid, key, created) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET key = excluded.key, created = excluded.created');

function bad(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code });
}

const linkFor = (origin, key) => origin + '/__rk/notes/inbox/' + key;

// The account's link, made on first use.
export function inboxLink(uid, origin) {
    const row = byUid.get(uid);
    return { url: linkFor(origin, row ? row.key : resetInbox(uid, origin).key) };
}

// A new link; the old one stops working.
export function resetInbox(uid, origin) {
    const key = crypto.randomBytes(24).toString('base64url');
    putRow.run(uid, key, Date.now());
    return { url: linkFor(origin, key), key };
}

export function ownerOf(key) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(String(key || ''))) return null;
    const row = byKey.get(key);
    return row ? row.uid : null;
}

export function usage(origin, key) {
    const url = linkFor(origin, key);
    return [
        'ReKindle Notes upload link.',
        '',
        'POST a note here as Markdown; it appears in the owner\'s Notes app.',
        'This link can only add notes (no reading, editing or deleting).',
        '',
        `  curl -X POST '${url}' -H 'Content-Type: text/markdown' --data-binary @note.md`,
        `  curl -X POST '${url}?title=Shopping' -H 'Content-Type: text/plain' --data-binary '- milk'`,
        `  curl -X POST '${url}' -H 'Content-Type: application/json' -d '{"title":"Plan","markdown":"# Plan\\n- step one"}'`,
        '',
        'Title: "title" (JSON) or ?title=, else a leading "# Heading" (moved into the title),',
        'else the first line. Markdown: headings, **bold**, *italic*, ~~strike~~, `code`,',
        'code blocks, links, lists, > quotes, tables, ---. Raw HTML is shown as text.',
        `Up to ${MAX_BYTES / 1024} KB. Answer: 201 {"ok":true,"id":"...","title":"..."}.`,
        ''
    ].join('\n');
}

function plainTitle(text) {
    return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

// { title, markdown } from the request body (a Buffer) and its Content-Type.
export function parseUpload(body, contentType, query) {
    let title = '', markdown = '';
    const text = body.toString('utf8').replace(/^﻿/, '');
    if (/json/i.test(contentType || '')) {
        let obj;
        try { obj = JSON.parse(text); } catch { throw bad('The body is not valid JSON.'); }
        if (!obj || typeof obj !== 'object') throw bad('Send a JSON object: {"title": "...", "markdown": "..."}');
        const content = [obj.markdown, obj.content, obj.text, obj.body].find((v) => typeof v === 'string');
        markdown = content || '';
        title = typeof obj.title === 'string' ? obj.title : '';
    } else {
        markdown = text;
    }
    if (!title) title = query.get('title') || '';
    markdown = markdown.replace(/\r\n?/g, '\n');
    if (!title) {
        // A leading "# Heading" becomes the title (and leaves the body).
        const m = /^\s*#[ \t]+(.+?)[ \t#]*(\n|$)/.exec(markdown);
        if (m) {
            title = plainTitle(m[1]);
            markdown = markdown.slice(m[0].length);
        } else {
            const first = markdown.split('\n').find((l) => l.trim());
            title = first ? plainTitle(first) : '';
        }
    }
    title = title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
    if (!markdown.trim() && !title) throw bad('The note is empty.');
    return { title, markdown };
}

function newId() {
    let id = '';
    for (let n = 0; n < 20; n++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
    return id;
}

export function addNote(uid, { title, markdown }) {
    const id = newId();
    fsStore.commit([{
        type: 'set',
        path: `users/${uid}/notes/${id}`,
        data: { title, content: markdownToHtml(markdown), updated: Date.now() }
    }], [], { internal: true });
    return { ok: true, id, title };
}
