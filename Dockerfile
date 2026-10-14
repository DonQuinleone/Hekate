# syntax=docker/dockerfile:1.7
# One image: the Hono server, the built web app and ffmpeg.

FROM node:26-trixie-slim AS base
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

# Runtime: Node and ffmpeg, no package managers.
FROM node:26-trixie-slim AS runtime
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist MIGRATE_ON_START=true \
  STORAGE_LOCAL_PATH=/data/storage
COPY --from=deps /app /app
COPY --from=build /app/apps/web/dist apps/web/dist
# Local storage. A named volume mounted here inherits this ownership.
RUN mkdir -p /data/storage && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
