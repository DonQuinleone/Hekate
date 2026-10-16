# syntax=docker/dockerfile:1.7
# One image: the Hono server, the built web app, ffmpeg, Poppler (PDF pages) and a font for watermarks.

# Pinned by digest; Dependabot moves the pin when the image is rebuilt.
FROM node:26-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Node 26 no longer ships Corepack; install the pnpm version package.json pins.
RUN npm install -g pnpm@12.11.2 && npm cache clean --force
WORKDIR /app

# Build the web app with the full workspace.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.cjs ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @hekate/web build

# Production dependencies for the server only.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .pnpmfile.cjs ./
COPY apps/server apps/server
COPY packages packages
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter @hekate/server...

# Runtime: Node, ffmpeg and Poppler's tools; no package managers, no shell, no setuid binaries.
FROM node:26-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS runtime
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist MIGRATE_ON_START=true \
  STORAGE_LOCAL_PATH=/data/storage
COPY --from=deps /app /app
COPY --from=build /app/apps/web/dist apps/web/dist
# Local storage. A named volume mounted here inherits this ownership.
RUN mkdir -p /data/storage && chown -R node:node /data
# Last, since nothing can run after it: no binary may raise its privileges, apt and dpkg
# go (their records stay, so scanners still see every package), and so do the shells.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
  && rm -f /usr/bin/apt /usr/bin/apt-* /usr/bin/dpkg /usr/bin/dpkg-* \
  && rm -f /usr/local/bin/docker-entrypoint.sh \
  && rm -f /usr/bin/bash /usr/bin/rbash /usr/bin/dash /usr/bin/sh /bin/sh /bin/bash /bin/dash
VOLUME /data
USER node
EXPOSE 3000
# Exec forms throughout: there is no shell to run anything else.
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["apps/server/src/index.ts"]
