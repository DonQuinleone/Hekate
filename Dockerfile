# syntax=docker/dockerfile:1.7
# One image: the Hono server, the built web app and ffmpeg.

FROM node:26-trixie-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Node 26 no longer ships Corepack; install the pnpm version package.json pins.
RUN npm install -g pnpm@12.11.2 && npm cache clean --force
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @hekate/web build

FROM base AS runtime
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist MIGRATE_ON_START=true
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server apps/server
COPY packages packages
COPY apps/web/package.json apps/web/
COPY --from=build /app/apps/web/dist apps/web/dist
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter @hekate/server...
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/index.ts"]
