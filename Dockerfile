# Self-hosted ReKindle: the website plus a backend that replaces Firebase and
# the Cloudflare workers. See selfhost/README.md.

# --- 1. Build the site (main, lite and legacy versions) -----------------------
FROM node:24-bookworm-slim AS site
# build-automation.js downloads the legacy build's polyfills with curl.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN node selfhost/prepare.js /src /build
WORKDIR /build
RUN (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) && node build-automation.js

# --- 2. Server dependencies ---------------------------------------------------
FROM node:24-bookworm-slim AS server-deps
WORKDIR /app/selfhost/server
COPY selfhost/server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- 3. Runtime ---------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    SITE_DIR=/app/site \
    UPSTREAM_DIR=/app/upstream \
    PLAYWRIGHT_BROWSERS_PATH=/opt/rekindle-browsers
WORKDIR /app/selfhost/server

COPY --from=server-deps /app/selfhost/server/node_modules ./node_modules
COPY selfhost/server/ ./
# Z-Library's verification requires a browser with a display. Chromium retains
# its sandbox; Xvfb provides a private display without exposing a desktop port.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth tini \
    && node node_modules/playwright-core/cli.js install --with-deps --no-shell chromium \
    && chmod -R a+rX /opt/rekindle-browsers \
    && rm -rf /var/lib/apt/lists/*
COPY selfhost/client/ /app/selfhost/client/
COPY --from=site /build/_deploy/ /app/site/

# Upstream backend code the server runs as-is.
COPY workers/ /app/upstream/workers/
COPY functions/ /app/upstream/functions/
COPY firebase-functions/index.js /app/upstream/firebase-functions/index.js
COPY rtdb-rules.json /app/upstream/rtdb-rules.json

RUN mkdir -p /data && chown -R node:node /data /app/selfhost/server
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__rk/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["tini", "--", "xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "node", "--disable-warning=ExperimentalWarning", "src/index.js"]
