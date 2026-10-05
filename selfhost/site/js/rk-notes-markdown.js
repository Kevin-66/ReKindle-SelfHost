// Self-hosted ReKindle: Markdown in Notes (notes.html, added by
// selfhost/server/src/transform.js; the page itself is unchanged).
//
// - Shows Markdown formatting (headings, lists, quotes, code, tables, links, rules) in
//   the editor. Notes stay HTML, so old notes and the B/I/U buttons work as before.
// - Typing Markdown formats as you go, Typora-style, through the browser's own editing
//   commands (so Undo still works): "# " .. "###### " heading, "- " / "* " / "+ "
//   bullets, "1. " numbers, "> " quote, "---" rule at the start of a line;
//   **bold**, *italic* / _italic_, ~~strike~~ and `code` when the closing mark is typed.
// - The download button saves the note as Markdown (.md) instead of plain text.
// - "Agent" (list view) shows the account's agent link: an AI agent or script can
//   list, read, add, edit and delete notes through it as Markdown, with no sign-in
//   (server: selfhost/server/src/notes-agent.js).
// Plain ES5 for the Kindle browser.
(function () {
    'use strict';

    var editor = document.getElementById('note-content');
    if (!editor || typeof showList !== 'function') return;

    // ------------------------------------------------------------------ styles

    var css =
        '#note-content h1,#note-content h2,#note-content h3,#note-content h4,#note-content h5,#note-content h6{font-weight:bold;line-height:1.25;margin:0.5em 0 0.3em;}' +
        '#note-content h1{font-size:1.6em;}#note-content h2{font-size:1.35em;}#note-content h3{font-size:1.15em;}' +
        '#note-content h4,#note-content h5,#note-content h6{font-size:1em;}' +
        '#note-content p{margin:0 0 0.7em;}' +
        '#note-content ul,#note-content ol{margin:0 0 0.7em;padding-left:1.6em;}' +
        '#note-content li ul,#note-content li ol{margin:0;}' +
        '#note-content blockquote{margin:0 0 0.7em;padding:0 0 0 0.8em;border-left:4px solid #000;}' +
        '#note-content blockquote+blockquote{margin-top:-0.7em;padding-top:0.2em;}' +
        '#note-content pre{margin:0 0 0.7em;padding:0.5em;border:2px solid #000;white-space:pre-wrap;font-size:0.9em;}' +
        '#note-content code{font-family:"Courier New",Courier,monospace;border:1px solid #000;padding:0 0.2em;}' +
        '#note-content pre code{border:none;padding:0;}' +
        '#note-content table{border-collapse:collapse;margin:0 0 0.7em;}' +
        '#note-content th,#note-content td{border:1px solid #000;padding:0.2em 0.5em;text-align:left;vertical-align:top;}' +
        '#note-content th{font-weight:bold;}' +
        '#note-content hr{border:none;border-top:2px solid #000;margin:0.7em 0;}' +
        '#note-content a{color:#000;text-decoration:underline;}' +
        '#note-content img{max-width:100%;}' +
        '#rk-agent-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.9);z-index:10000;align-items:center;justify-content:center;}' +
        '#rk-agent-box{background:#fff;border:2px solid #000;box-shadow:8px 8px 0 #000;padding:20px;width:90%;max-width:560px;box-sizing:border-box;text-align:left;font-size:0.9rem;max-height:90vh;overflow-y:auto;}' +
        '#rk-agent-box h3{margin:0 0 10px;font-size:1.1rem;text-align:center;}' +
        '#rk-agent-box p{margin:0 0 10px;line-height:1.4;}' +
        '#rk-agent-url{width:100%;box-sizing:border-box;border:2px solid #000;border-radius:0;padding:6px;font-family:"Courier New",Courier,monospace;font-size:0.85rem;margin:0 0 10px;-webkit-user-select:text;user-select:text;}' +
        '#rk-agent-box pre{margin:0 0 10px;padding:6px;border:1px solid #000;white-space:pre-wrap;word-break:break-all;font-size:0.75rem;-webkit-user-select:text;user-select:text;}' +
        '#rk-agent-buttons{display:flex;justify-content:center;margin-top:5px;}' +
        '#rk-agent-buttons>*+*{margin-left:10px;}';
    var style = document.createElement('style');
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);

    // ------------------------------------------------------------------ typing Markdown

    var BLOCKS = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|UL|OL|TABLE|TR|TD|TH|HR)$/;
    var busy = false;

    function inside(node, re) {
        while (node && node !== editor) {
            if (node.nodeType === 1 && re.test(node.nodeName)) return node;
            node = node.parentNode;
        }
        return null;
    }

    // Is the text node the first thing on its line?
    function atLineStart(node) {
        var n = node;
        while (n && n !== editor) {
            var p = n.previousSibling;
            while (p && p.nodeType === 3 && p.nodeValue === '') p = p.previousSibling;
            if (p) return p.nodeName === 'BR' || BLOCKS.test(p.nodeName);
            n = n.parentNode;
            if (n === editor || BLOCKS.test(n.nodeName)) return true;
        }
        return true;
    }

    function selectText(node, start, end) {
        var r = document.createRange();
        r.setStart(node, start);
        r.setEnd(node, end);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
    }

    function blockRule(node, offset, line) {
        var m, cmd = null, arg = null;
        if (inside(node, /^(LI|PRE|H[1-6]|TD|TH)$/)) return false;
        if ((m = /^(#{1,6})[  ]$/.exec(line))) { cmd = 'formatBlock'; arg = 'h' + m[1].length; }
        else if (/^[-*+][  ]$/.test(line)) cmd = 'insertUnorderedList';
        else if (/^\d{1,9}[.)][  ]$/.test(line)) cmd = 'insertOrderedList';
        else if (/^>[  ]$/.test(line) && !inside(node, /^BLOCKQUOTE$/)) { cmd = 'formatBlock'; arg = 'blockquote'; }
        if (!cmd) return false;
        selectText(node, offset - line.length, offset);
        document.execCommand('delete', false, null);
        document.execCommand(cmd, false, arg);
        return true;
    }

    function ruleRule(node, offset, line) {
        if (!/^(---|\*\*\*|___)$/.test(line) || node.nodeValue.slice(offset).replace(/[\s ]/g, '') !== '') return false;
        if (inside(node, /^(LI|PRE|H[1-6]|TD|TH|BLOCKQUOTE)$/)) return false;
        selectText(node, offset - 3, offset);
        document.execCommand('insertHTML', false, '<hr><div><br></div>');
        return true;
    }

    var INLINE = [
        { mark: '*', re: /(^|[^*\\])\*\*([^*\s ](?:[^*]*[^*\s ])?)\*\*$/, cmd: 'bold' },
        { mark: '_', re: /(^|[^\w\\])__([^_\s ](?:[^_]*[^_\s ])?)__$/, cmd: 'bold' },
        { mark: '*', re: /(^|[^*\w\\])\*([^*\s ](?:[^*]*[^*\s ])?)\*$/, cmd: 'italic' },
        { mark: '_', re: /(^|[^\w\\])_([^_\s ](?:[^_]*[^_\s ])?)_$/, cmd: 'italic' },
        { mark: '~', re: /(^|[^~\\])~~([^~\s ](?:[^~]*[^~\s ])?)~~$/, cmd: 'strikeThrough' },
        { mark: '`', re: /(^|[^`\\])`([^`]+)`$/, cmd: 'code' }
    ];

    function inlineRule(node, offset, before, typed) {
        for (var i = 0; i < INLINE.length; i++) {
            var rule = INLINE[i];
            if (rule.mark !== typed) continue;
            var m = rule.re.exec(before);
            if (!m) continue;
            var start = m.index + m[1].length, inner = m[2];
            selectText(node, start, offset);
            if (rule.cmd === 'code') {
                // Built by hand: insertHTML copies the surrounding font size onto the code
                // and the text after it. A space after the code keeps what follows out of it.
                document.execCommand('delete', false, null);
                var s = window.getSelection();
                if (!s.rangeCount) return true;
                var r = s.getRangeAt(0), code = document.createElement('code'), after = document.createTextNode(' ');
                code.textContent = inner;
                r.insertNode(after);
                r.insertNode(code);
                r = document.createRange();
                r.setStart(after, 1);
                r.collapse(true);
                s.removeAllRanges();
                s.addRange(r);
            } else {
                document.execCommand('insertText', false, inner);
                var sel = window.getSelection();
                var end = sel.anchorNode, endOffset = sel.anchorOffset;
                if (end && end.nodeType === 3 && endOffset >= inner.length) {
                    selectText(end, endOffset - inner.length, endOffset);
                    document.execCommand(rule.cmd, false, null);
                    sel = window.getSelection();
                    if (sel.rangeCount) sel.collapseToEnd();
                    // Turn the style off again for what is typed next.
                    if (document.queryCommandState(rule.cmd)) document.execCommand(rule.cmd, false, null);
                }
            }
            return true;
        }
        return false;
    }

    // Enter on an empty quote line leaves the quote (Chrome would start another quote).
    function leaveQuote() {
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount) return false;
        var quote = inside(sel.anchorNode, /^BLOCKQUOTE$/);
        var prev = quote && quote.previousSibling;
        if (!prev || prev.nodeName !== 'BLOCKQUOTE' || hasContent(prev) || hasContent(quote)) return false;
        prev.parentNode.removeChild(prev);
        document.execCommand('formatBlock', false, 'div');
        return true;
    }

    editor.addEventListener('input', function (e) {
        if (!busy && e.inputType === 'insertParagraph') {
            busy = true;
            try { if (leaveQuote() && typeof saveCurrentNote === 'function') saveCurrentNote(); } finally { busy = false; }
            return;
        }
        if (busy || e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
        var sel = window.getSelection();
        if (!sel || !sel.rangeCount || !sel.isCollapsed) return;
        var node = sel.anchorNode, offset = sel.anchorOffset;
        if (!node || node.nodeType !== 3 || !editor.contains(node) || inside(node, /^(PRE|CODE)$/)) return;
        var before = node.nodeValue.slice(0, offset);
        var nl = before.lastIndexOf('\n');
        var line = before.slice(nl + 1);
        var lineStart = nl >= 0 || atLineStart(node);
        busy = true;
        var changed = false;
        try {
            if (lineStart && (e.data === ' ' || e.data === ' ')) changed = blockRule(node, offset, line);
            else if (lineStart && /[-*_]/.test(e.data)) changed = ruleRule(node, offset, line);
            if (!changed && /[*_~`]/.test(e.data)) changed = inlineRule(node, offset, before, e.data);
        } finally {
            busy = false;
        }
        if (changed && typeof saveCurrentNote === 'function') saveCurrentNote();
    });

    // ------------------------------------------------------------------ Markdown download

    function Out() { this.s = ''; }
    Out.prototype.lines = function (n) {   // make sure the text ends with n line breaks
        if (!this.s) return;
        var have = /\n*$/.exec(this.s)[0].length;
        while (have < n) { this.s += '\n'; have++; }
    };

    function textOf(el, out) {
        var o = new Out();
        children(el, o);
        return o.s;
    }

    function wrap(mark, inner) {
        var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
        return m[2] ? m[1] + mark + m[2] + mark + m[3] : inner;
    }

    function hasContent(el) {
        return /\S/.test(el.textContent || '') || !!el.querySelector('img,hr');
    }

    function children(el, out) {
        for (var c = el.firstChild; c; c = c.nextSibling) node(c, out);
    }

    function node(c, out) {
        if (c.nodeType === 3) { out.s += c.nodeValue.replace(/ /g, ' ').replace(/​/g, ''); return; }
        if (c.nodeType !== 1) return;
        var tag = c.nodeName, inner, n;
        switch (tag) {
            case 'BR':
                // The <br> a browser leaves at the end of a line is not an extra line.
                if (!c.nextSibling && c.parentNode !== editor && BLOCKS.test(c.parentNode.nodeName) && hasContent(c.parentNode)) return;
                out.s += '\n';
                return;
            case 'B': case 'STRONG': out.s += wrap('**', textOf(c)); return;
            case 'I': case 'EM': out.s += wrap('*', textOf(c)); return;
            case 'S': case 'STRIKE': case 'DEL': out.s += wrap('~~', textOf(c)); return;
            case 'CODE': out.s += '`' + c.textContent + '`'; return;
            case 'A': out.s += '[' + textOf(c) + '](' + (c.getAttribute('href') || '') + ')'; return;
            case 'IMG': out.s += '![' + (c.getAttribute('alt') || '') + '](' + (c.getAttribute('src') || '') + ')'; return;
            case 'HR': out.lines(2); out.s += '---'; out.lines(2); return;
            case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
                out.lines(2);
                out.s += '######'.slice(0, Number(tag.charAt(1))) + ' ' + textOf(c).replace(/\s*\n\s*/g, ' ').trim();
                out.lines(2);
                return;
            case 'P': out.lines(2); children(c, out); out.lines(2); return;
            case 'DIV':
                out.lines(1);
                if (!hasContent(c)) { out.s += '\n'; return; }   // an empty line
                children(c, out);
                out.lines(1);
                return;
            case 'PRE':
                out.lines(2);
                out.s += '```\n' + c.textContent.replace(/\n$/, '') + '\n```';
                out.lines(2);
                return;
            case 'BLOCKQUOTE':
                inner = textOf(c).replace(/^\n+|\n+$/g, '');
                out.lines(2);
                out.s += inner.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
                out.lines(2);
                return;
            case 'UL': case 'OL':
                out.lines(inside(c.parentNode, /^LI$/) || c.parentNode.nodeName === 'LI' ? 1 : 2);
                n = tag === 'OL' ? parseInt(c.getAttribute('start') || '1', 10) : 0;
                for (var li = c.firstChild; li; li = li.nextSibling) {
                    if (li.nodeName !== 'LI') continue;
                    var mark = tag === 'OL' ? (n++) + '. ' : '- ';
                    var pad = new Array(mark.length + 1).join(' ');
                    var body = textOf(li).replace(/^\n+|\n+$/g, '').replace(/\n{2,}/g, '\n');
                    out.lines(1);
                    out.s += mark + body.split('\n').map(function (l, k) { return k ? (l ? pad + l : '') : l; }).join('\n');
                }
                out.lines(2);
                return;
            case 'TABLE':
                var rows = c.querySelectorAll('tr');
                out.lines(2);
                for (var r = 0; r < rows.length; r++) {
                    var cells = rows[r].querySelectorAll('th,td'), line = [];
                    for (var k = 0; k < cells.length; k++) line.push(textOf(cells[k]).replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim());
                    out.s += '| ' + line.join(' | ') + ' |\n';
                    if (r === 0) out.s += '|' + line.map(function () { return ' --- '; }).join('|') + '|\n';
                }
                out.lines(2);
                return;
            default:
                children(c, out);
        }
    }

    function toMarkdown(el) {
        var out = new Out();
        children(el, out);
        return out.s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '') + '\n';
    }
    window.rkNotesToMarkdown = toMarkdown;

    var downloadBtn = document.querySelector('.editor-toolbar [onclick="downloadTXT()"]');
    if (downloadBtn) {
        downloadBtn.removeAttribute('data-i18n-title');
        downloadBtn.title = 'Download as Markdown (.md)';
    }

    window.downloadTXT = function () {
        if (typeof currentNoteId === 'undefined' || !currentNoteId) return;
        var note = notes.find(function (n) { return n.id === currentNoteId; });
        if (!note) return;
        var tmp = document.createElement('div');
        tmp.innerHTML = (note.content || '').replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        var blob = new Blob([toMarkdown(tmp)], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (note.title || 'Untitled').replace(/[\\\/:*?"<>|]+/g, '-') + '.md';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };

    // ------------------------------------------------------------------ agent link

    var controls = document.getElementById('list-controls');
    if (!controls) return;

    var agentBtn = document.createElement('button');
    agentBtn.className = 'sys-btn';
    agentBtn.textContent = 'Agent';
    agentBtn.title = 'Link for AI agents to read and write your notes';
    controls.insertBefore(agentBtn, controls.lastElementChild);

    var overlay = document.createElement('div');
    overlay.id = 'rk-agent-overlay';
    overlay.innerHTML =
        '<div id="rk-agent-box">' +
        '<h3>Agent link</h3>' +
        '<div id="rk-agent-body"></div>' +
        '<div id="rk-agent-buttons">' +
        '<button class="sys-btn" id="rk-agent-reset">New link</button>' +
        '<button class="sys-btn" id="rk-agent-close">Close</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    var body = document.getElementById('rk-agent-body');
    var resetBtn = document.getElementById('rk-agent-reset');
    var confirmReset = false;

    function signedIn() {
        return typeof currentUser !== 'undefined' && currentUser && typeof currentUser.getIdToken === 'function';
    }

    function call(method) {
        return currentUser.getIdToken().then(function (token) {
            return fetch('/__rk/notes/agent-link', { method: method, headers: { Authorization: 'Bearer ' + token } });
        }).then(function (r) {
            return r.json().then(function (data) {
                if (!r.ok || !data.url) throw new Error((data.error && data.error.message) || 'Could not get the link.');
                return data.url;
            });
        });
    }

    function message(text) {
        body.innerHTML = '';
        var p = document.createElement('p');
        p.textContent = text;
        body.appendChild(p);
    }

    function showLink(url) {
        body.innerHTML =
            '<p>With this link an AI agent or script can read, add, change and delete your notes (as Markdown), with no sign-in. Keep it private. "New link" replaces it, and the old one stops working.</p>' +
            '<input id="rk-agent-url" type="text" readonly>' +
            '<p>Tell your agent, for example:</p>' +
            '<pre id="rk-agent-example"></pre>';
        var input = document.getElementById('rk-agent-url');
        input.value = url;
        input.addEventListener('focus', function () { input.select(); });
        input.addEventListener('click', function () { input.select(); });
        document.getElementById('rk-agent-example').textContent =
            'My ReKindle notes are at ' + url + ' - GET it for the API (list, read, add, edit, delete notes as Markdown).\n\n' +
            "curl '" + url + "/notes'\n" +
            "curl -X POST '" + url + "/notes' -H 'Content-Type: text/markdown' --data-binary @note.md";
    }

    function open() {
        confirmReset = false;
        resetBtn.textContent = 'New link';
        overlay.style.display = 'flex';
        if (!signedIn()) {
            resetBtn.style.display = 'none';
            message('Sign in to get an agent link. Notes saved in guest mode stay on this device, so agents cannot reach them.');
            return;
        }
        resetBtn.style.display = '';
        message('Loading...');
        call('GET').then(showLink, function (e) { message(e.message); });
    }

    agentBtn.addEventListener('click', open);
    document.getElementById('rk-agent-close').addEventListener('click', function () { overlay.style.display = 'none'; });
    resetBtn.addEventListener('click', function () {
        if (!confirmReset) {
            confirmReset = true;
            resetBtn.textContent = 'Replace link?';
            return;
        }
        confirmReset = false;
        resetBtn.textContent = 'New link';
        message('Making a new link...');
        call('POST').then(showLink, function (e) { message(e.message); });
    });
})();
