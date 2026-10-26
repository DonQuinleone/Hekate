# syntax=docker/dockerfile:1.7
# One image: the Hono server, the built web app, ffmpeg, Poppler (PDF pages), fonts for
# watermarks and for the PDFs Hekate writes (decision 238), and the EBU ADM Renderer for an ADM
# master's objects (decision 140). Alpine throughout, holding only what Hekate runs (decision 244).

# Every stage starts from the same image, pinned by digest, so all of them are one Alpine
# release; Renovate moves the pin when the image is rebuilt.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# Node 26 no longer ships Corepack; install the pnpm version package.json pins.
RUN npm install -g pnpm@12.11.2 && npm cache clean --force
WORKDIR /app

# Build the web app with the full workspace.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
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
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server apps/server
COPY packages packages
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile --filter @hekate/server...

# The EBU ADM Renderer and its hash-pinned wheels (musllinux), installed with pip here so that
# neither pip nor any build tool reaches the runtime. Alpine's own python3, as the runtime has.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS ear
RUN apk add --no-cache python3 py3-pip
COPY tools/ear /tools/ear
RUN /tools/ear/install.sh /opt/ear

# Runtime: Node, ffmpeg, Poppler's tools and Python; no package manager, no shell, no setuid
# binaries, and no program Hekate does not run.
FROM node:26-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS runtime
# The fonts keep the faces Hekate and Poppler use: DejaVu's Sans, Sans Mono and Serif, upright
# and bold, and Droid Sans Fallback alone from Droid's non-Latin fonts.
RUN apk upgrade --no-cache \
  && apk add --no-cache ffmpeg poppler-utils font-dejavu font-droid-nonlatin ca-certificates python3 \
  && find /usr/share/fonts/dejavu -type f ! \( -name DejaVuSans.ttf -o -name DejaVuSans-Bold.ttf \
    -o -name DejaVuSansMono.ttf -o -name DejaVuSansMono-Bold.ttf -o -name DejaVuSerif.ttf \
    -o -name DejaVuSerif-Bold.ttf \) -delete \
  && find /usr/share/fonts/droid-nonlatin -type f ! -name DroidSansFallback.ttf -delete \
  && fc-cache -f \
  && rm -rf /usr/lib/python3*/ensurepip \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack
WORKDIR /app
# The commit the image was built from, shown in System information (#158).
ARG HEKATE_BUILD=dev
ENV HEKATE_BUILD=$HEKATE_BUILD
ENV NODE_ENV=production PORT=3000 WEB_DIST=/app/apps/web/dist MIGRATE_ON_START=true \
  STORAGE_LOCAL_PATH=/data/storage HEKATE_SETTINGS_FILE=/config/hekate.env \
  ADM_RENDERER_PATH=/opt/ear \
  PDF_FONT=/usr/share/fonts/dejavu/DejaVuSans.ttf \
  PDF_FONT_BOLD=/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf \
  PDF_FONT_FALLBACK=/usr/share/fonts/droid-nonlatin/DroidSansFallback.ttf
COPY --from=ear /opt/ear /opt/ear
COPY --from=deps /app /app
COPY --from=build /app/apps/web/dist apps/web/dist
# Local storage and the installer's settings. A named volume mounted here inherits this ownership.
RUN mkdir -p /data/storage /config && chown -R node:node /data /config && chmod 700 /config
# Last, since nothing can run after it, and in Node, since the shell is among what goes: every
# program but node, ffmpeg, ffprobe, pdfinfo, pdftoppm, pdftotext and python3 is removed (apk,
# busybox and its applets with them; apk's records stay, so scanners still see every package),
# and no file may raise its privileges.
RUN --mount=type=bind,source=scripts/image-harden.mjs,target=/harden.mjs ["node", "/harden.mjs"]
VOLUME /data /config
USER node
EXPOSE 3000
# Exec forms throughout: there is no shell to run anything else.
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["node"]
CMD ["apps/server/src/index.ts"]
