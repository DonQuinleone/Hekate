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

## 025. Guests sign in with single-use links and hold a separate session

A guest is a row in the organisation's `guests` table, found by email, never a Better Auth user. Asking a guest to review sends a magic link: a random token of which the database keeps only the SHA-256 hash, usable once, within three days, and revoked when a newer link is sent. Opening it spends the link atomically and starts a guest session (its own table and an httpOnly, SameSite Strict cookie) that lasts a fortnight unless revoked. Routes that guests may use (files, comments, reviews and playback) accept either a member or a guest; every other route still requires a member. A guest reaches only the files of the open reviews they are part of, may view, comment and decide on them, and never sees other reviewers' email addresses. Someone holding both a member sign-in and a guest cookie acts as the member. Revoking a guest ends their links and sessions at once.

## 026. A group is one step of a review, fixed when it is asked

Groups belong to a project and hold members and guests in order. Asking a group expands it into its people as they are at that moment, all at the same step (`review_reviewers.position`), each remembering the group they came through. In a sequence, everyone at the earliest step that is not finished acts together, and the next step starts once all of them have responded; the approval rule still counts every reviewer. Later changes to the group do not touch reviews already sent, and deleting it only drops the name. Someone named twice (alone and in a group, or in two groups) is asked once, at their first step. Members of a group must be able to see the project, and for an approval to decide, checked when the group is asked. Saving a group needs the "add or remove reviewers and guests" permission.

## 027. Deleting a folder keeps its files; a file under review stays

A folder's name is unique among its siblings (`NULLS NOT DISTINCT`, so at the top of a project too). Deleting a folder removes it and the folders inside it, and moves every file and track that was in them up to where the folder was: a folder is a way of arranging things, and removing the arrangement should not remove the work. Deleting a file is final, needs the "organise" permission, and is written to the access log in the same transaction; a file that is a variation of a track's version, or an item of any review, cannot be deleted, so what reviewers were asked about stays on the record. Its stored bytes go at the next storage reconciliation. Folder changes in a project are serialised on the project row, so two moves cannot together make a loop.

## 028. Content before chrome

Every page has one header bar: the trail back up (Projects / Joplin Rags / …) ending in the page's own name, which is its only title, with the page's actions on the right. Labels that only restate what is on screen (a project's profile, its anchor types, a status pill with no meaning) are left out. The sidebar earns its width: Reviews, with a count of those waiting on you, Projects with a short list of them, and Members; it collapses to icons (`[` or its button) and the choice is remembered. The organisation lives in the account area, where it can be switched. In a project, tracks sit among folders as a special kind of folder, and the files in a track's versions live in it rather than loose beside it. Files dropped anywhere on a project page upload to the open folder; the Upload button is the other way in. Row actions sit behind one menu shown on hover. The player opens on one waveform with the channels combined; split channels, the spectrogram (below, behind or instead of the waveform) and, later, the score are switched on from its View menu. Reviewers check new screens against established products (AGENTS.md, Interface).

## 029. A comment thread travels with the track, and is settled where it is fixed

A thread stays on the file it was raised on. Creating a version carries the previous version's unresolved threads to it, in the same transaction: each becomes a row in `comment_carries` on the new version's variation of the same name (the wet mix to the wet mix), otherwise its primary. The row holds where the thread points on that file, whether it shows there (the project decides the default; triage can hide or show it) and its status there: open, fixed, not fixed or won't fix. Fixed and won't fix resolve the thread itself; open and not fixed keep it going, so it is carried again to the next version. Until alignment between versions exists (#33), a carried anchor keeps the same times, and whoever triages can move it to the passage on the new version; before and after then plays the earlier version offset by the difference, level-matched, inside a loop around the passage. Replies written on any version join the one thread. People who cannot triage never see a thread hidden on their version.

## 030. A review grants each reviewer their own permissions

Every reviewer row holds a permission set (`review_reviewers.permissions`, validated by `reviewerPermissions` in `packages/shared`): whose comments they see (everyone's, their own and the replies to them, or only their own), whether they comment and record a decision, which tools they have (spectrogram, meters, loops) and an access window. A review can set everyone's when it is asked, and anyone who may manage reviewers can adjust one reviewer at a time. A guest gets exactly what the review grants; reaching a file through several reviews, they get the widest of them, but a decision belongs to one review. A member's project role stays the ceiling: the review can take a decision away, or close their window, but never adds to the role. The server enforces all of it: comment lists are filtered, replies into an unseen thread refused, spectrogram and loudness data refused when the tool is left out, and outside the window a guest's files, review and playback are closed. Loops are an interface tool and only hidden. Organisation and project defaults, downloads and play limits follow.
