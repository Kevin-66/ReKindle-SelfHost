#!/bin/sh
# Start the Z-Library catalogue browser (Dockerfile.zlibrary-browser).
# Zeabur starts containers as root, and Chromium will not run its sandbox as root
# ("Chromium sandboxing failed!"); the sandbox must stay on. So drop to the
# unprivileged node user first, then give Chromium a private virtual display.
set -e
cd /app
if [ "$(id -u)" = 0 ]; then
    exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node \
        xvfb-run -a --server-args="-screen 0 1280x800x24" node /app/service.mjs
fi
exec xvfb-run -a --server-args="-screen 0 1280x800x24" node /app/service.mjs
