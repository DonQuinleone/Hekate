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

## 010. Media security from day one

Reviewers receive encrypted, segmented streams and server-rendered tiles, never original files or plain URLs. Keys and segment URLs are short-lived and bound to the viewer's session. Files are encrypted at rest with per-file keys. Visible watermarks come first; forensic watermarking (A/B segment marking for streams, per-recipient marks on downloads) follows. Every access is logged. This is not DRM, and the design leaves room for commercial DRM on the same segments. Details in `docs/security.md`.

## 011. Waveform first; comments carry across versions

The waveform is the primary surface for audio; a score is optional. Engineer tools (spectrogram, metering, loudness, phase) are part of the product, computed by the media worker. Comments carry over between versions with mapped anchors and a before and after, and configurable categories (such as Noise) can defer a comment to a later workflow stage. Details in `docs/domain.md`.

## 012. Identity

Better Auth underpins sign-in. Members can use OIDC or SAML single sign-on, LDAP, passkeys and hardware security keys (up to five per account by default), or passwords where allowed; guests use magic links scoped to their reviews. Organisations set the policy. Details in `docs/security.md`.

## 013. Built-in QA for audio and video

Quality checks are a native part of Hekate, run by the media worker on every audio and video upload, not an import from another tool. Findings are versioned with the file, drawn on the waveform, spectrogram and timeline, and can become comments. Checks are configured by delivery profiles per project. The default spectrogram palette is the iZotope RX style *Cyan to orange* map. Details in `docs/domain.md`.

## 014. Production tools built in

Scheduling, personnel, venues, repertoire, live take logging, score marking with T-notation and edit plots, stage plans and patch lists are part of Hekate, reimplemented natively from the maintainer's ControlRoom desktop tool. They share the project's data with tracks, takes and reviews. Take logging is local-first so it works without a connection. ControlRoom's movements map to tracks within a work. Details in `docs/domain.md` (Production).

## 015. Video deliverables and reviewer permissions

Video uses deliverables, versions and renditions, a concept separate from tracks. Every reviewer has an individual permission set (items, history, comment visibility, tools, downloads, access window, view limits, actions), with defaults per organisation and project. Edit decisions are optional, imported from an EDL, and a project can require one on upload.

## 016. How work lands

All changes reach `master` through pull requests with green CI; `master` is protected. Work proceeds from the ground up, each layer complete and tested before the next is built on it.

## 017. Multiple storage backends

Storage is a set of named, configurable backends (local disk and any S3-compatible service), not a single choice. Every stored object is a blob row that records its backend and key, so backends can be added and defaults changed without migrating existing objects. An instance has a default backend; an organisation owner can choose another for new objects. Backends never issue URLs to browsers: all bytes leave through the server's protected delivery path. Every driver passes one shared conformance suite, and CI runs it against a real S3-compatible server. This refines 003's "local storage by default, optional S3".

## 018. Encryption at rest: segmented envelope encryption

Every stored object is encrypted before any backend sees it: AES-256-GCM in 64 KiB segments (the STREAM construction), with a per-object data key wrapped by a per-organisation key, itself wrapped by the instance master key. Segments keep range reads cheap for audio and video seeking. Master-key rotation re-wraps organisation keys at start-up and never rewrites objects. The master key is mandatory configuration; losing it loses the stored media, so the documentation tells operators to back it up apart from the database and storage. Details in `docs/security.md`.

## 019. Background jobs in PostgreSQL

Background work runs on pg-boss in the app process, so self-hosting still needs only PostgreSQL. Each job type has one definition (a zod schema for its data and its retry policy) shared by senders and workers, and workers validate data again when they take a job. The worker can be turned off (`WORKER=false`) for API-only replicas. Media tools run with protocol and demuxer allow-lists, time limits and a private scratch directory (`docs/security.md`). Unreadable media is recorded as such rather than retried; infrastructure failures retry with backoff.

## 020. The access log is append-only in the database

The access log is enforced append-only by PostgreSQL triggers, not only by application code: updates are always refused, and deletes need an explicit, transaction-scoped purge setting. Events reference files, people and reviews by plain id and copy the actor's name and email, so the record survives deletions. Recording is awaited, so access is refused if it cannot be logged. Details in `docs/security.md`.

## 021. Resumable uploads, encrypted per chunk

Uploads are Hekate's own small chunked protocol rather than tus: fixed 8 MiB chunks line up with the encryption segments, so each chunk is encrypted on arrival and stored directly as a multipart part (S3 multipart, or parts on local disk) and no plaintext is staged on the server. Because chunks arrive in any order, a blob's SHA-256 is computed afterwards by a job that reads the file back through decryption. Uploads are limited to 10,000 chunks (78 GiB), the S3 part limit.

## 022. Streaming: HLS AES-128 now, with surround kept intact

Proxies are HLS with fragmented MP4 segments, encrypted by Hekate itself with the HLS `AES-128` method (whole-segment AES-128-CBC) rather than CENC `cbcs`. Every browser player supports `AES-128` through hls.js; `cbcs` needs Encrypted Media Extensions and, in practice, a DRM licence server. Segments are re-encrypted, not re-encoded, so moving to `cbcs` later for commercial DRM costs a packaging job, not a transcode. Audio is delivered as a stereo AAC monitoring rendition, a lossless FLAC rendition that keeps up to eight channels, and Dolby Digital or Dolby Digital Plus passed through untouched (so Atmos in E-AC-3 survives); the player picks what the browser can play. Playback links are signed tokens bound to the viewer's sign-in session. Details in `docs/security.md`.

## 023. The player is hls.js under Hekate's own controls

Vidstack, named in 002, is deprecated and in security-only maintenance; its successor, Video.js 10, had only just reached its first release and brings many packages Hekate does not need. Hekate drives a plain media element with hls.js instead, under its own controls drawn from the design tokens. The player needs little beyond play, seek, volume and a choice of rendition, and the waveform, spectrogram and comparison tools (#34, #44) will drive the same media element directly. hls.js is loaded only when a player opens. This amends 002.

## 024. Projects are visible only to those with a role in them

A project's roles are rows in its own `project_roles` table, each a set of permissions from the fixed list in `packages/shared/src/roles.ts`. Every new project is given the defaults from `docs/domain.md`, and its creator is its first Producer. An organisation member who holds no role in a project, or whose role lacks *view*, does not see the project at all: it is missing from their list and its routes answer 404, as they do for another organisation's project. Organisation owners and admins need no role and may do everything. Every project route asks one server-side check (`can` in `apps/server/src/access.ts`); the web app hides what a role cannot do but never decides it. Playback links are checked against the project on every request, so taking a role away ends playback at once. Any member may still start a project.
