// Notes agent link: lets an AI agent (or any script) list, read, search, add, edit and
// delete a reader's notes over plain HTTP with no sign-in (the owner's choice). Each
// account gets one secret link, /__rk/notes/agent/<key>, shown in the Notes app (Agent
// button), where it can also be replaced. The link is the permission, so it must stay
// private; a wrong key gets 404.
//
// Notes travel as Markdown: markdownToHtml (escaped, nothing in it can run) becomes the
// note's HTML in users/{uid}/notes/{id}, and htmlToMarkdown turns notes back when an
// agent reads them. Writes go through the document store like the app's own saves, so
// open Notes pages update at once (an open note merges the change, rk-notes-sync.js).

import crypto from 'node:crypto';
import { db } from './db.js';
import * as fsStore from './firestore.js';
import { markdownToHtml, htmlToMarkdown } from './markdown.js';

export const MAX_BYTES = 256 * 1024;
const MAX_TITLE = 200;
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const byUid = db.prepare('SELECT key FROM notes_agent WHERE uid = ?');
const byKey = db.prepare('SELECT uid FROM notes_agent WHERE key = ?');
const putRow = db.prepare('INSERT INTO notes_agent(uid, key, created) VALUES(?, ?, ?) ON CONFLICT(uid) DO UPDATE SET key = excluded.key, created = excluded.created');

function fail(message, status = 400, code = 'invalid-argument') {
    return Object.assign(new Error(message), { status, code });
}

const linkFor = (origin, key) => origin + '/__rk/notes/agent/' + key;
const notesPath = (uid) => `users/${uid}/notes`;

// ------------------------------------------------------------------ the link

// The account's link, made on first use.
export function agentLink(uid, origin) {
    const row = byUid.get(uid);
    return { url: linkFor(origin, row ? row.key : resetLink(uid, origin).key) };
}

// A new link; the old one stops working.
export function resetLink(uid, origin) {
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
    const base = linkFor(origin, key);
    return [
        'ReKindle Notes - agent link',
        '',
        'This link gives full access to one person\'s notes in the ReKindle Notes app',
        '(an e-ink web app). Notes are Markdown. No other sign-in is needed.',
        '',
        `List:    GET    ${base}/notes            -> {"notes":[{"id","title","updated"}]}  (newest first)`,
        `Search:  GET    ${base}/notes?q=words    (title and text)`,
        `Read:    GET    ${base}/notes/<id>       -> {"id","title","updated","markdown"}`,
        `Add:     POST   ${base}/notes            -> 201 {"ok":true,"id","title"}`,
        `Edit:    PATCH  ${base}/notes/<id>       (fields given are replaced; PUT does the same)`,
        `Delete:  DELETE ${base}/notes/<id>`,
        '',
        'Add/Edit body: JSON {"title": "...", "markdown": "..."}; Edit also takes',
        '{"append": "..."} to add Markdown to the end. Or send the Markdown itself with',
        'Content-Type: text/markdown (title from ?title=; when adding without one, a leading',
        '"# Heading" becomes the title, else the first line). "updated" is milliseconds',
        'since 1970.',
        '',
        `  curl '${base}/notes'`,
        `  curl -X POST '${base}/notes' -H 'Content-Type: text/markdown' --data-binary @note.md`,
        `  curl -X PATCH '${base}/notes/<id>' -H 'Content-Type: application/json' -d '{"append":"- one more thing"}'`,
        `  curl -X DELETE '${base}/notes/<id>'`,
        '',
        'Markdown: headings, **bold**, *italic*, ~~strike~~, `code`, code blocks, links,',
        `lists, > quotes, tables, ---. Raw HTML is shown as text. Up to ${MAX_BYTES / 1024} KB per request.`,
        ''
    ].join('\n');
}

// ------------------------------------------------------------------ request bodies

function plainTitle(text) {
    return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_~`#>]+/g, '').replace(/\s+/g, ' ').trim();
}

const cleanTitle = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);

// { title?, markdown?, append? } from a request body (Buffer) and its Content-Type.
export function parseBody(body, contentType, query) {
    const text = body.toString('utf8').replace(/^﻿/, '');
    const out = {};
    if (/json/i.test(contentType || '')) {
        let obj;
        try { obj = JSON.parse(text || '{}'); } catch { throw fail('The body is not valid JSON.'); }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw fail('Send a JSON object: {"title": "...", "markdown": "..."}');
        const content = [obj.markdown, obj.content, obj.text, obj.body].find((v) => typeof v === 'string');
        if (content !== undefined) out.markdown = content;
        if (typeof obj.title === 'string') out.title = obj.title;
        if (typeof obj.append === 'string') out.append = obj.append;
    } else if (text) {
        out.markdown = text;
    }
    if (out.title === undefined && query.get('title') !== null) out.title = query.get('title');
    if (out.markdown !== undefined) out.markdown = out.markdown.replace(/\r\n?/g, '\n');
    if (out.append !== undefined) out.append = out.append.replace(/\r\n?/g, '\n');
    if (out.title !== undefined) out.title = cleanTitle(out.title);
    return out;
}

// A new note's title when none was given: a leading "# Heading" (moved out of the
// text), else the first line.
function titleFromMarkdown(fields) {
    const md = fields.markdown || '';
    const m = /^\s*#[ \t]+(.+?)[ \t#]*(\n|$)/.exec(md);
    if (m) return { title: cleanTitle(plainTitle(m[1])), markdown: md.slice(m[0].length) };
    const first = md.split('\n').find((l) => l.trim());
    return { title: first ? cleanTitle(plainTitle(first)) : '', markdown: md };
}

// ------------------------------------------------------------------ notes

function newId() {
    let id = '';
    for (let n = 0; n < 20; n++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
    return id;
}

function noteDoc(uid, id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) throw fail('No note with that id.', 404, 'not-found');
    const doc = fsStore.getDoc(`${notesPath(uid)}/${id}`, { internal: true });
    if (!doc.exists) throw fail('No note with that id.', 404, 'not-found');
    return doc;
}

const plainText = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export function listNotes(uid, q) {
    let docs = fsStore.runQuery(notesPath(uid), {}, { internal: true });
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
        docs = docs.filter((d) => {
            const hay = (String(d.data.title || '') + ' ' + plainText(d.data.content)).toLowerCase();
            return words.every((w) => hay.includes(w));
        });
    }
    const notes = docs.map((d) => ({ id: d.path.split('/').pop(), title: d.data.title || '', updated: Number(d.data.updated) || 0 }));
    notes.sort((a, b) => b.updated - a.updated);
    return { notes };
}

export function readNote(uid, id) {
    const doc = noteDoc(uid, id);
    return { id, title: doc.data.title || '', updated: Number(doc.data.updated) || 0, markdown: htmlToMarkdown(doc.data.content || '') };
}

function write(uid, id, title, content) {
    fsStore.commit([{ type: 'set', path: `${notesPath(uid)}/${id}`, data: { title, content, updated: Date.now() } }], [], { internal: true });
}

export function addNote(uid, fields) {
    let title = fields.title, markdown = fields.markdown || '';
    if (title === undefined) ({ title, markdown } = titleFromMarkdown(fields));
    if (fields.append) markdown += (markdown && !markdown.endsWith('\n') ? '\n' : '') + fields.append;
    if (!markdown.trim() && !title) throw fail('The note is empty.');
    const id = newId();
    write(uid, id, title, markdownToHtml(markdown));
    return { ok: true, id, title };
}

export function editNote(uid, id, fields) {
    const doc = noteDoc(uid, id);
    if (fields.title === undefined && fields.markdown === undefined && fields.append === undefined) {
        throw fail('Nothing to change: send "title", "markdown" or "append".');
    }
    const title = fields.title !== undefined ? fields.title : (doc.data.title || '');
    let content = fields.markdown !== undefined ? markdownToHtml(fields.markdown) : (doc.data.content || '');
    if (fields.append) content += markdownToHtml(fields.append);
    write(uid, id, title, content);
    return { ok: true, id, title };
}

export function deleteNote(uid, id) {
    noteDoc(uid, id);
    fsStore.commit([{ type: 'delete', path: `${notesPath(uid)}/${id}` }], [], { internal: true });
    return { ok: true, id };
}
