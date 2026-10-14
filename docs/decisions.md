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
