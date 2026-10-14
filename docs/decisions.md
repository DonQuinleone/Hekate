# Decisions

A running record of decisions that shape Hekate. Add new entries at the bottom; do not rewrite old ones, supersede them.

## 001. Fresh start

Hekate is a new codebase. There is no data migration from the legacy application, and no code, names or branding carry over from it.

## 002. TypeScript end to end

React, Vite, TanStack Router and Query, shadcn/ui on Tailwind (restyled heavily, not stock) on the web; Hono on the server with types shared through `packages/shared`; PostgreSQL with Drizzle; pg-boss for jobs; a built-in ffmpeg worker; Vidstack, wavesurfer.js and pdf.js for media; Better Auth. Not Next.js: the app is a single-page application served by the API, which keeps deployment to one image.

## 003. Deployment

One app image plus PostgreSQL and Caddy, via Docker Compose. Local storage by default, optional S3-compatible storage. Caddy terminates TLS.

## 004. Anchored comments and project profiles

Every comment has an anchor: a time range or frame, a region on a page or frame, a bar and beat, or a track or movement. Projects choose a profile (Music, Video, General) that decides which tools appear. The data model is the same for all profiles.

## 005. Multi-tenancy from day one

Every tenant-owned row carries an `organisation_id`, and every query is scoped by it. A self-hosted install has a single organisation by default; a hosted offering can run many in one database.

## 006. Music review is the launch priority

The first complete experience is reviewing a recording against its score: bar-anchored comments, takes, movements. Video follows on the same model.

## 007. Brand: Signal

Dark, understated, one signal colour (`#F0762E`), hairlines over cards, Schibsted Grotesk and DM Mono, and a mark of two stems and a point. Chosen over three earlier, more theatrical directions that read as a classical-music-only tool. Details in `docs/brand.md`.

## 008. Licence

GNU Affero General Public License v3.0 only.

## 009. Domain vocabulary

Projects contain folders and files of any kind. Tracks have versions (edits) and variations (treatments such as dry and wet mixes). Takes are recording-session snippets kept as reference, never versions. There are no movements. Reviews are approvals (logged decisions) or feedback (comments only), run by configurable workflows with guests, groups and per-project roles. Full definitions in `docs/domain.md`; this supersedes the asset and version wording in 004.
