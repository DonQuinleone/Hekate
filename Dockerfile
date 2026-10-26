# syntax=docker/dockerfile:1.7
# One image: the Hono server, the built web app, ffmpeg, Poppler (PDF pages), fonts for
# watermarks and for the PDFs Hekate writes (decision 238), and the EBU ADM Renderer for an ADM
# master's objects (decision 140).

# Pinned by digest; Dependabot moves the pin when the image is rebuilt.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS base
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

# The EBU ADM Renderer and its hash-pinned wheels, installed with pip here so that neither pip
# nor any build tool reaches the runtime, which needs only Debian's Python of the same version.
FROM python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS ear
COPY tools/ear /tools/ear
RUN /tools/ear/install.sh /opt/ear

# Runtime: Node, ffmpeg, Poppler's tools and Python; no package managers, no shell, no setuid binaries.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime
RUN apt-get update \
  && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends ffmpeg poppler-utils fonts-dejavu-core ca-certificates \
    fonts-droid-fallback python3 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /usr/local/lib/node_modules/corepack /usr/local/bin/corepack
WORKDIR /app
# The commit the image was built from, shown in System information (#158).
ARG HEKATE_BUILD=dev
ENV HEKATE_BUILD=$HEKATE_BUILD
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist MIGRATE_ON_START=true \
  STORAGE_LOCAL_PATH=/data/storage HEKATE_SETTINGS_FILE=/config/hekate.env \
  ADM_RENDERER_PATH=/opt/ear \
  PDF_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
  PDF_FONT_BOLD=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf \
  PDF_FONT_FALLBACK=/usr/share/fonts-droid-fallback/truetype/DroidSansFallback.ttf
COPY --from=ear /opt/ear /opt/ear
COPY --from=deps /app /app
COPY --from=build /app/apps/web/dist apps/web/dist
# Local storage and the installer's settings. A named volume mounted here inherits this ownership.
RUN mkdir -p /data/storage /config && chown -R node:node /data /config && chmod 700 /config
# Last, since nothing can run after it: no binary may raise its privileges, apt and dpkg
# go (their records stay, so scanners still see every package), and so do the shells.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
  && rm -f /usr/bin/apt /usr/bin/apt-* /usr/bin/dpkg /usr/bin/dpkg-* \
  && rm -f /usr/local/bin/docker-entrypoint.sh \
  && rm -f /usr/bin/bash /usr/bin/rbash /usr/bin/dash /usr/bin/sh /bin/sh /bin/bash /bin/dash
VOLUME /data /config
USER node
EXPOSE 3000
# Exec forms throughout: there is no shell to run anything else.
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["apps/server/src/index.ts"]
