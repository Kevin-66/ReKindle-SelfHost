// Markdown to HTML (and back) for notes handled through the Notes agent link (notes-agent.js).
//
// Safe by construction: all text is HTML-escaped (raw HTML in the Markdown shows as
// text), and links and images keep only http(s) (and mailto for links) addresses. The
// result goes straight into the reader's Notes editor, so nothing in it may run.
// htmlToMarkdown (end of file) turns a note's HTML back into Markdown for agents.
//
// The editor shows notes with `white-space: pre-wrap`, so the output has no whitespace
// between tags (it would show as blank lines), and a line break inside a paragraph
// becomes <br>, keeping the lines as written.
//
// Covers what agents write: ATX and setext headings, paragraphs, **bold**, *italic*,
// ~~strike~~, `code`, fenced code blocks, links, images, autolinks and bare URLs,
// block quotes, nested bullet and numbered lists, GitHub tables and rules.

import { parseHTML } from 'linkedom';

const MAX_SPAN = 500;   // inline emphasis spans stay on one line and this short (no slow regexes)

export function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function safeUrl(raw, allowMail) {
    const u = String(raw || '').trim().replace(/^<(.*)>$/, '$1');
    if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
    if (allowMail && /^mailto:[^\s]+$/i.test(u)) return u;
    return null;
}

// ------------------------------------------------------------------ inline

const SPAN = `[^\\n]{0,${MAX_SPAN}}?`;
const RE = {
    escape: /\\([\\`*_{}[\]()#+\-.!~|>])/g,
    code: new RegExp(`(\`+)([^\`\n](?:[^\n]{0,${MAX_SPAN}}?[^\`\n])?)\\1(?!\`)`, 'g'),
    image: new RegExp(`!\\[([^\\[\\]\\n]{0,${MAX_SPAN}})\\]\\(\\s*(<[^>\\n]{0,2000}>|[^\\s)]{1,2000})(?:\\s+"[^"\\n]{0,${MAX_SPAN}}")?\\s*\\)`, 'g'),
    link: new RegExp(`\\[([^\\[\\]\\n]{1,${MAX_SPAN}})\\]\\(\\s*(<[^>\\n]{0,2000}>|[^\\s)]{1,2000})(?:\\s+"[^"\\n]{0,${MAX_SPAN}}")?\\s*\\)`, 'g'),
    autolink: /<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi,
    bareUrl: /\bhttps?:\/\/[^\s\u0000]+/gi,
    strongEm: new RegExp(`\\*\\*\\*(?=\\S)(${SPAN}\\S)\\*\\*\\*`, 'g'),
    strong: new RegExp(`\\*\\*(?=\\S)(${SPAN}\\S)\\*\\*`, 'g'),
    strongU: new RegExp(`(^|[^\\w])__(?=\\S)(${SPAN}\\S)__(?!\\w)`, 'g'),
    strike: new RegExp(`~~(?=\\S)(${SPAN}\\S)~~`, 'g'),
    em: new RegExp(`(^|[^*\\w])\\*([^\\s*](?:[^*\\n]{0,${MAX_SPAN}}?[^\\s*])?)\\*(?![*\\w])`, 'g'),
    emU: new RegExp(`(^|[^\\w])_([^\\s_](?:[^_\\n]{0,${MAX_SPAN}}?[^\\s_])?)_(?!\\w)`, 'g')
};

// Pieces of finished HTML are parked in `slots` and replaced by \u0000n\u0000 markers
// while the rest of the text is processed, so later steps can't touch them.
function inlinePass(text, slots) {
    const keep = (html) => '\u0000' + (slots.push(html) - 1) + '\u0000';
    text = text.replace(/\u0000/g, '');
    text = text.replace(RE.escape, (m, c) => keep(escapeHtml(c)));
    text = text.replace(RE.code, (m, ticks, code) => keep('<code>' + escapeHtml(code.replace(/^ ([\s\S]*) $/, '$1')) + '</code>'));
    text = text.replace(RE.image, (m, alt, url) => {
        const u = safeUrl(url, false);
        return u ? keep('<img src="' + escapeHtml(u) + '" alt="' + escapeHtml(alt) + '">') : keep(escapeHtml(m));
    });
    text = text.replace(RE.link, (m, label, url) => {
        const u = safeUrl(url, true);
        return u ? keep('<a href="' + escapeHtml(u) + '">' + inlinePass(label, slots) + '</a>') : m;
    });
    text = text.replace(RE.autolink, (m, u) => keep('<a href="' + escapeHtml(u) + '">' + escapeHtml(u) + '</a>'));
    text = escapeHtml(text);
    text = text.replace(RE.bareUrl, (u) => {
        let tail = '';
        for (;;) {
            const m = /(&quot;|&#39;|&gt;|[.,;:!?'\]])$/.exec(u);
            if (m) { tail = m[0] + tail; u = u.slice(0, -m[0].length); continue; }
            if (u.endsWith(')') && u.split('(').length < u.split(')').length) { tail = ')' + tail; u = u.slice(0, -1); continue; }
            break;
        }
        return (u.length > 8 ? keep('<a href="' + u + '">' + u + '</a>') : u) + tail;
    });
    text = text.replace(RE.strongEm, '<strong><em>$1</em></strong>');
    text = text.replace(RE.strong, '<strong>$1</strong>');
    text = text.replace(RE.strongU, '$1<strong>$2</strong>');
    text = text.replace(RE.strike, '<s>$1</s>');
    text = text.replace(RE.em, '$1<em>$2</em>');
    text = text.replace(RE.emU, '$1<em>$2</em>');
    return text;
}

function restore(html, slots) {
    return html.replace(/\u0000(\d+)\u0000/g, (m, i) => restore(slots[Number(i)] || '', slots));
}

function inline(text) {
    const slots = [];
    return restore(inlinePass(text, slots), slots);
}

// Paragraph lines: trailing "  " or "\" hard breaks and soft breaks all become <br>.
function inlineLines(lines) {
    return inline(lines.map((l) => l.replace(/^\s+/, '').replace(/(\\| {2,})$/, '').replace(/\s+$/, '')).join('\n')).replace(/\n/g, '<br>');
}

// ------------------------------------------------------------------ blocks

const B = {
    fence: /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/,
    heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
    hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
    quote: /^ {0,3}> ?(.*)$/,
    list: /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+(.*))?$/,
    setext1: /^ {0,3}=+[ \t]*$/,
    setext2: /^ {0,3}-+[ \t]*$/,
    tableDelim: /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/,
    blank: /^\s*$/
};

function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
        if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
        cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
}

function isTableStart(lines, i) {
    return lines[i].includes('|') && i + 1 < lines.length && B.tableDelim.test(lines[i + 1]) && lines[i + 1].includes('-')
        && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

// Does this line start a block that ends a paragraph?
function interrupts(lines, i) {
    const l = lines[i];
    if (B.fence.test(l) || B.heading.test(l) || B.hr.test(l) || B.quote.test(l)) return true;
    const m = B.list.exec(l);
    if (m && m[5] && (!m[3] || m[3] === '1')) return true;
    return isTableStart(lines, i);
}

function renderList(lines, i, tight) {
    const first = B.list.exec(lines[i]);
    const ordered = !!first[3];
    const start = ordered ? parseInt(first[3], 10) : 1;
    const items = [];
    let loose = false;
    while (i < lines.length) {
        const m = B.list.exec(lines[i]);
        if (!m || !!m[3] !== ordered || (!ordered && m[2] !== first[2]) || m[1].length > first[1].length + 1) break;
        const indent = m[1].length + m[2].length + (m[4] ? Math.min(Math.max(m[4].length - (m[5] || '').length, 1), 4) : 1);
        const body = [m[5] || ''];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
            const l = lines[i];
            if (B.blank.test(l)) { sawBlank = true; body.push(''); i++; continue; }
            const lead = l.match(/^ */)[0].length;
            if (lead >= indent) { if (sawBlank) loose = true; body.push(l.slice(indent)); sawBlank = false; i++; continue; }
            if (!sawBlank && !B.list.test(l) && !interrupts(lines, i)) { body.push(l.trim()); i++; continue; }   // lazy continuation
            break;
        }
        while (body.length && B.blank.test(body[body.length - 1])) body.pop();
        items.push(body);
        if (sawBlank) {
            // A blank line between two items of this list makes it loose; anything else ends it.
            const n = i < lines.length ? B.list.exec(lines[i]) : null;
            if (!n || !!n[3] !== ordered || (!ordered && n[2] !== first[2]) || n[1].length > first[1].length + 1) break;
            loose = true;
        }
    }
    const tag = ordered ? 'ol' : 'ul';
    const html = '<' + tag + (ordered && start !== 1 ? ' start="' + start + '"' : '') + '>'
        + items.map((body) => '<li>' + blocks(body, tight || !loose) + '</li>').join('') + '</' + tag + '>';
    return { html, next: i };
}

function renderTable(lines, i) {
    const head = splitRow(lines[i]);
    const aligns = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
    const cell = (tag, text, n) => '<' + tag + (aligns[n] ? ' style="text-align:' + aligns[n] + '"' : '') + '>' + inline(text) + '</' + tag + '>';
    let html = '<table><thead><tr>' + head.map((c, n) => cell('th', c, n)).join('') + '</tr></thead><tbody>';
    i += 2;
    while (i < lines.length && !B.blank.test(lines[i]) && lines[i].includes('|')) {
        const row = splitRow(lines[i]);
        html += '<tr>' + head.map((h, n) => cell('td', row[n] || '', n)).join('') + '</tr>';
        i++;
    }
    return { html: html + '</tbody></table>', next: i };
}

// tight: paragraphs inside a tight list item are bare text, not <p>.
function blocks(lines, tight) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (B.blank.test(line)) { i++; continue; }

        let m = B.fence.exec(line);
        if (m) {
            const fence = m[1];
            const close = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$');
            const indent = line.match(/^ */)[0].length;
            const code = [];
            i++;
            while (i < lines.length && !close.test(lines[i])) {
                code.push(lines[i].replace(new RegExp('^ {0,' + indent + '}'), ''));
                i++;
            }
            i++;
            out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
            continue;
        }

        m = B.heading.exec(line);
        if (m) {
            out.push('<h' + m[1].length + '>' + inline((m[2] || '').trim()) + '</h' + m[1].length + '>');
            i++;
            continue;
        }

        if (B.hr.test(line)) { out.push('<hr>'); i++; continue; }

        if (B.quote.test(line)) {
            const inner = [];
            while (i < lines.length && !B.blank.test(lines[i])) {
                const q = B.quote.exec(lines[i]);
                if (q) inner.push(q[1]);
                else if (!interrupts(lines, i)) inner.push(lines[i]);   // lazy continuation
                else break;
                i++;
            }
            out.push('<blockquote>' + blocks(inner, false) + '</blockquote>');
            continue;
        }

        if (B.list.test(line) && B.list.exec(line)[5] !== undefined) {
            const r = renderList(lines, i, tight);
            out.push(r.html);
            i = r.next;
            continue;
        }

        if (isTableStart(lines, i)) {
            const r = renderTable(lines, i);
            out.push(r.html);
            i = r.next;
            continue;
        }

        const para = [line];
        i++;
        let heading = 0;
        while (i < lines.length && !B.blank.test(lines[i])) {
            if (B.setext1.test(lines[i])) { heading = 1; i++; break; }
            if (B.setext2.test(lines[i])) { heading = 2; i++; break; }
            if (interrupts(lines, i)) break;
            para.push(lines[i]);
            i++;
        }
        const text = inlineLines(para);
        if (heading) out.push('<h' + heading + '>' + text + '</h' + heading + '>');
        else out.push(tight ? text : '<p>' + text + '</p>');
    }
    if (!tight) return out.join('');
    // Bare text pieces next to each other are separate lines; blocks need no <br>.
    let html = '';
    for (let n = 0; n < out.length; n++) {
        if (n && !/^<(p|h\d|ul|ol|pre|blockquote|table|hr)[\s>]/.test(out[n]) && !/<\/(h\d|ul|ol|pre|blockquote|table)>$|^<hr>$/.test(out[n - 1])) html += '<br>';
        html += out[n];
    }
    return html;
}

export function markdownToHtml(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    return blocks(lines, false);
}

// ------------------------------------------------------------------ HTML -> Markdown

// A note's HTML (as the Notes editor saves it: text with <div>/<br> lines, <b>/<i>/<u>,
// and the Markdown elements above) back to Markdown, for agents reading notes. Same
// rules as the Notes page's .md download (selfhost/site/js/rk-notes-markdown.js).
const BLOCK_TAGS = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE|TR|TD|TH|HR)$/;

class MdOut {
    constructor() { this.s = ''; }
    lines(n) {   // make sure the text ends with n line breaks
        if (!this.s) return;
        let have = /\n*$/.exec(this.s)[0].length;
        while (have < n) { this.s += '\n'; have++; }
    }
}

function hasContent(el) {
    return /\S/.test(el.textContent || '') || !!el.querySelector('img,hr');
}

function wrapMark(mark, inner) {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
    return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner;
}

function mdText(el, root) {
    const o = new MdOut();
    mdChildren(el, o, root);
    return o.s;
}

function mdChildren(el, out, root) {
    for (let c = el.firstChild; c; c = c.nextSibling) mdNode(c, out, root);
}

function mdNode(c, out, root) {
    if (c.nodeType === 3) { out.s += c.nodeValue.replace(/ /g, ' ').replace(/​/g, ''); return; }
    if (c.nodeType !== 1) return;
    const tag = c.nodeName.toUpperCase();
    switch (tag) {
        case 'BR':
            if (!c.nextSibling && c.parentNode !== root && BLOCK_TAGS.test(c.parentNode.nodeName.toUpperCase()) && hasContent(c.parentNode)) return;
            out.s += '\n';
            return;
        case 'B': case 'STRONG': out.s += wrapMark('**', mdText(c, root)); return;
        case 'I': case 'EM': out.s += wrapMark('*', mdText(c, root)); return;
        case 'S': case 'STRIKE': case 'DEL': out.s += wrapMark('~~', mdText(c, root)); return;
        case 'CODE': out.s += '`' + c.textContent + '`'; return;
        case 'A': out.s += '[' + mdText(c, root) + '](' + (c.getAttribute('href') || '') + ')'; return;
        case 'IMG': out.s += '![' + (c.getAttribute('alt') || '') + '](' + (c.getAttribute('src') || '') + ')'; return;
        case 'SCRIPT': case 'STYLE': return;
        case 'HR': out.lines(2); out.s += '---'; out.lines(2); return;
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
            out.lines(2);
            out.s += '#'.repeat(Number(tag[1])) + ' ' + mdText(c, root).replace(/\s*\n\s*/g, ' ').trim();
            out.lines(2);
            return;
        case 'P': out.lines(2); mdChildren(c, out, root); out.lines(2); return;
        case 'DIV':
            out.lines(1);
            if (!hasContent(c)) { out.s += '\n'; return; }
            mdChildren(c, out, root);
            out.lines(1);
            return;
        case 'PRE':
            out.lines(2);
            out.s += '```\n' + c.textContent.replace(/\n$/, '') + '\n```';
            out.lines(2);
            return;
        case 'BLOCKQUOTE': {
            const inner = mdText(c, root).replace(/^\n+|\n+$/g, '');
            out.lines(2);
            out.s += inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n');
            out.lines(2);
            return;
        }
        case 'UL': case 'OL': {
            out.lines(c.parentNode && c.parentNode.nodeName.toUpperCase() === 'LI' ? 1 : 2);
            let n = tag === 'OL' ? parseInt(c.getAttribute('start') || '1', 10) : 0;
            for (let li = c.firstChild; li; li = li.nextSibling) {
                if (li.nodeType !== 1 || li.nodeName.toUpperCase() !== 'LI') continue;
                const mark = tag === 'OL' ? (n++) + '. ' : '- ';
                const pad = ' '.repeat(mark.length);
                const body = mdText(li, root).replace(/^\n+|\n+$/g, '').replace(/\n{2,}/g, '\n');
                out.lines(1);
                out.s += mark + body.split('\n').map((l, k) => (k ? (l ? pad + l : '') : l)).join('\n');
            }
            out.lines(2);
            return;
        }
        case 'TABLE': {
            const rows = c.querySelectorAll('tr');
            out.lines(2);
            rows.forEach((row, r) => {
                const cells = [...row.querySelectorAll('th,td')].map((cell) => mdText(cell, root).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
                out.s += '| ' + cells.join(' | ') + ' |\n';
                if (r === 0) out.s += '|' + cells.map(() => ' --- ').join('|') + '|\n';
            });
            out.lines(2);
            return;
        }
        default:
            mdChildren(c, out, root);
    }
}

export function htmlToMarkdown(html) {
    const { document } = parseHTML('<!doctype html><html><body><div id="rk-root"></div></body></html>');
    const root = document.getElementById('rk-root');
    root.innerHTML = String(html || '');
    const out = new MdOut();
    mdChildren(root, out, root);
    return out.s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '') + '\n';
}
