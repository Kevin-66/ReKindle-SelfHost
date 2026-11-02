#!/usr/bin/env python3
"""Local static server for ReKindle visual testing.

Cloudflare Pages serves extensionless URLs, and theme.js may reload a page from
/jumpy.html to /jumpy. Plain `python3 -m http.server` 404s those. This server
falls back to `<path>.html` and is threaded so a slow page cannot block the
screenshot loop.

Usage:
    python3 scripts/serve-local.py [port] [root]
"""
import http.server
import os
import socketserver
import sys
import urllib.parse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..')
os.chdir(os.path.abspath(ROOT))


class Handler(http.server.SimpleHTTPRequestHandler):
    def _resolve(self):
        """Map a request path inside the served root, or return None.

        SimpleHTTPRequestHandler follows ".." and absolute paths; this check
        (after percent-decoding, which is what the handler itself does) keeps
        every request under the project root and blocks NUL-byte tricks.
        """
        path = urllib.parse.urlsplit(self.path).path
        decoded = urllib.parse.unquote(path)
        if '\x00' in decoded:
            return None, path
        root = os.path.realpath(os.getcwd())
        target = os.path.realpath(os.path.join(root, decoded.lstrip('/')))
        if target != root and not target.startswith(root + os.sep):
            return None, path
        return target, path

    def do_GET(self):
        target, path = self._resolve()
        if target is None:
            self.send_error(403, 'Forbidden')
            return
        if path != '/' and not os.path.exists(target):
            if os.path.exists(target + '.html'):
                self.path = path + '.html'
        return super().do_GET()

    def log_message(self, *args):
        pass


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    print('ReKindle local server: http://127.0.0.1:%d' % PORT)
    ThreadingServer(('127.0.0.1', PORT), Handler).serve_forever()
