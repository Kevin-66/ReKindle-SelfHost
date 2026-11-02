# Akinator relay container.
#
# The build context is THIS directory (`akinator-service`), not the repository
# root, so COPY paths are relative to it. Northflank: Build context
# `akinator-service`, Dockerfile path `/akinator-service/Dockerfile`.
# Local:
#   docker build -f akinator-service/Dockerfile -t rekindle-akinator akinator-service
#   docker run --rm -p 8080:8080 rekindle-akinator

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production dependencies from the lockfile first so source edits do not
# invalidate the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . ./

ENV PORT=8080
EXPOSE 8080

# node:22-slim ships an unprivileged `node` user.
USER node

CMD ["node", "server.js"]
