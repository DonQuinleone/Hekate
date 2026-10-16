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

A guest is a row in the organisation's `guests` table, found by email, never a Better Auth user. Asking a guest to review sends a magic link: a random token of which the database keeps only the SHA-256 hash, usable once, within three days unless the workspace chooses 14 or 30 in its settings, and revoked when a newer link is sent. Opening it spends the link atomically and starts a guest session (its own table and an httpOnly, SameSite Strict cookie) that lasts a fortnight unless revoked. Routes that guests may use (files, comments, reviews and playback) accept either a member or a guest; every other route still requires a member. A guest reaches only the files of the open reviews they are part of, may view, comment and decide on them, and never sees other reviewers' email addresses. Someone holding both a member sign-in and a guest cookie acts as the member. Revoking a guest ends their links and sessions at once.

## 026. A group is one step of a review, fixed when it is asked

Groups belong to a project and hold members and guests in order. Asking a group expands it into its people as they are at that moment, all at the same step (`review_reviewers.position`), each remembering the group they came through. In a sequence, everyone at the earliest step that is not finished acts together, and the next step starts once all of them have responded; the approval rule still counts every reviewer. Later changes to the group do not touch reviews already sent, and deleting it only drops the name. Someone named twice (alone and in a group, or in two groups) is asked once, at their first step. Members of a group must be able to see the project, and for an approval to decide, checked when the group is asked. Saving a group needs the "add or remove reviewers and guests" permission.

## 027. Deleting a folder keeps its files; a file under review stays

A folder's name is unique among its siblings (`NULLS NOT DISTINCT`, so at the top of a project too). Deleting a folder removes it and the folders inside it, and moves every file and track that was in them up to where the folder was: a folder is a way of arranging things, and removing the arrangement should not remove the work. Deleting a file is final, needs the "organise" permission, and is written to the access log in the same transaction; a file that is a variation of a track's version, or an item of any review, cannot be deleted, so what reviewers were asked about stays on the record. Its stored bytes go at the next storage reconciliation. Folder changes in a project are serialised on the project row, so two moves cannot together make a loop.

## 028. Content before chrome

Every page has one header bar: the trail back up (Projects / Joplin Rags / …) ending in the page's own name, which is its only title, with the page's actions on the right. Labels that only restate what is on screen (a project's profile, its anchor types, a status pill with no meaning) are left out. The sidebar earns its width: Reviews, with a count of those waiting on you, Projects with a short list of them, and Members; it collapses to icons (`[` or its button) and the choice is remembered. The organisation lives in the account area, where it can be switched. In a project, tracks sit among folders as a special kind of folder, and the files in a track's versions live in it rather than loose beside it. Files dropped anywhere on a project page upload to the open folder; the Upload button is the other way in. Row actions sit behind one menu shown on hover. The player opens on one waveform with the channels combined; split channels, the spectrogram (below, behind or instead of the waveform) and, later, the score are switched on from its View menu. Reviewers check new screens against established products (AGENTS.md, Interface).

## 029. A comment thread travels with the track, and is settled where it is fixed

A thread stays on the file it was raised on. Creating a version carries the previous version's unresolved threads to it, in the same transaction: each becomes a row in `comment_carries` on the new version's variation of the same name (the wet mix to the wet mix), otherwise its primary. The row holds where the thread points on that file, whether it shows there (the project decides the default; triage can hide or show it) and its status there: open, fixed, not fixed or won't fix. Fixed and won't fix resolve the thread itself; open and not fixed keep it going, so it is carried again to the next version. Until alignment between versions exists (#33), a carried anchor keeps the same times, and whoever triages can move it to the passage on the new version; before and after then plays the earlier version offset by the difference, level-matched, inside a loop around the passage. Replies written on any version join the one thread. People who cannot triage never see a thread hidden on their version.

## 030. A review grants each reviewer their own permissions

Every reviewer row holds a permission set (`review_reviewers.permissions`, validated by `reviewerPermissions` in `packages/shared`): whose comments they see (everyone's, their own and the replies to them, or only their own), whether they comment and record a decision, which tools they have (spectrogram, meters, loops) and an access window. A review can set everyone's when it is asked, and anyone who may manage reviewers can adjust one reviewer at a time. A guest gets exactly what the review grants; reaching a file through several reviews, they get the widest of them, but a decision belongs to one review. A member's project role stays the ceiling: the review can take a decision away, or close their window, but never adds to the role; their comments and tools follow the role, since they reach the same files through the project, so the review page offers only what applies. In an approval, a reviewer asked for no decision follows along: they neither hold up the order nor count towards the outcome. The server enforces all of it: comment lists are filtered, replies into an unseen thread refused, spectrogram and loudness data refused when the tool is left out, and outside the window a guest's files, review and playback are closed. Loops are an interface tool and only hidden. Organisation and project defaults, downloads and play limits follow.

## 031. Versions are aligned by their audio, and comments follow the music

Creating a version queues, for each variation of the previous version, an alignment with the variation its threads move to (`alignments`, one row per ordered pair). The media worker decodes both at 11,025 Hz mono, reduces each to fingerprints ten times a second (half the spectrum's shape in 24 log-spaced bands, half where it has just grown, silence as nothing), and matches them with dynamic time warping: once coarsely over the whole of both, then finely near that path. Either version may leave out up to half a minute at either end, so a lead-in, an intro or a tail that only one has does not drag the rest. The result is a list of time pairs, simplified to where the line bends, with a quality from how alike the matched spectra are; below 0.5 it is kept but not used. When an alignment is ready, every thread carried along it moves to where the same music is, unless someone placed it by hand, and comparison plays an aligned source at the matching moment rather than the same time. Nothing about the audio leaves the server: only the time pairs do.

## 032. Documents and pictures are shown only as pages the server drew

A PDF or a picture (JPEG, PNG, WebP, TIFF, BMP, GIF; never SVG, which can carry script) is drawn once, after upload, by the `document-render` job: Poppler for PDFs, ffmpeg for pictures, each page kept as WebP at 2000 pixels on its longest side and as a 320-pixel thumbnail, encrypted in storage like any other blob (`file_pages`). At most 300 pages of a document are drawn, and the viewer says when there are more. A reviewer asks for a document's pages and gets links bound to their session for a few hours, the same signed links that carry streams; every full page served is written to the access log as `page.render`, thumbnails are not. The original never reaches a browser this way. Region comments on pages and the per-viewer watermark burned into them follow.

## 033. Comments on a page point at a region, numbered in reading order

On a document or picture, dragging on the page with a mouse or pen draws a rectangle, and the next comment points at it: a `region` anchor in shares of the page's width and height, with the page number on a document. Without a drawing, a comment on a document points at the page shown (the whole page as a region, which reads as "P. 2"), and either can be switched to the whole file. The server refuses a page the document does not have. Open threads on part of a page are marked on it and numbered in the order the list reads (page by page, top to bottom), so a number on the page and in the list are the same thread; picking either picks both. A carried thread can be moved to a region drawn on the new version. On a touch screen a finger scrolls the page instead; drawing by touch follows.

## 034. The score sits beside the recording; bars are named, never synced

A track can link one PDF of its project as its score (`tracks.score_file_id`); the server refuses anything that is not a document. The recording's page then shows the score's pages, drawn and delivered like any document's, under the player, and links to the score's own page, where comments on it live. Recordings are not synced to their scores: in classical music, repeats, cuts, edits between takes and rubato make a bar map more trouble than help. Instead, in music projects only, a reviewer types the bars a comment is about ("25", "0" for an upbeat, or "9-12"); the comment keeps the moment of the recording they were listening to, so it plays from there, and reads "BAR 25" or "BARS 9–12". Other profiles have no bars, and the server refuses them there.

## 035. A recording has a QA view; the review screen stays with the music

A recording's file page has two views, kept in its address (`?view=qa`). Review is for listening and commenting: the player, the comments beside it, the score and Compare, with a single summary of what QA found ("−17.5 LUFS · 1 issue") that opens QA. QA holds what was measured: the quality checks, loudness and the meters, and the file's technical details. The player keeps its place in both, so switching views never stops playback. A guest has QA only when their review grants the meters.

The checks come in two kinds. Signal checks (clipping, flattened peaks, dropouts, clicks, DC offset, long silences, phase and mono fold-down) are measured once, in the same decode as the loudness analysis, and stored in `qa_findings`. Delivery checks (format, loudness, true peak, dead channels, balance) are read from those measurements against the project's delivery profile each time they are shown: Streaming, CD, Apple Digital Masters, broadcast (EBU R128), 5.1 surround or Dolby Atmos. A project without one is checked against the profile its channel count suggests, so changing profile needs no new analysis. Severity is shown by the dot's shape and fill, never by a traffic-light palette.

## 036. The prototype is the design contract

The clickable prototype in `apps/prototype`, approved in #105, is the design of the whole application: its navigation, layouts, copy, states, components and keyboard behaviour. `apps/web` builds what it shows; where building proves it wrong, the prototype changes in the same pull request. (Number 035 is held by the audio QA view in #103.)

## 037. Organisations are called workspaces

In every piece of copy (interface, email, documentation) the tenant is a **workspace**. The word "organisation" stays in code, the schema and the API (`organisation_id`, `organisationRole`, `/api/organisation`), so nothing is migrated. "Studio" was rejected because it reads as music-only.

## 038. Navigation: the sidebar carries the project, sections share one secondary list

Outside a project the sidebar holds Home, Inbox, Projects, what is waiting on you and recent items. Once a project is open, the sidebar shows a project switcher and the project's own navigation (Overview, Files, Board, Reviews, Tasks, People, Production, Settings), and the page header names the section; the project page has no tab row. Pages with sections (all settings, production) share one sticky secondary list at the left that holds its place on scroll. Tabs are kept for a third level. The player keeps its own layout. Members and workspace settings are reached from the account menu at the foot of the sidebar, not the sidebar itself. Home is a dashboard; the inbox is its own page with the bell's panel as its preview. A command palette (Ctrl or ⌘ K) replaces the search box, with a search page behind it. This supersedes the sidebar described in 028.

## 039. The instance is the same shell

Operators of an install work in the same application: the instance pages (overview, workspaces, operators, billing, support, health, queues, logs, debug tools, system information, settings, operations) appear as an Instance block in the sidebar, reached from the account menu or the fingerprint beside the bell, which is highlighted there. Operators are accounts with an instance role and always need a hardware security key. They never sign in as someone else. A workspace owner sees only their own workspace on the instance side.

## 040. Workflows are events, actions and connectors

A workflow is a graph of **nodes** and **connectors**. A node is an **event** (something happens: a version arrives, a decision is recorded, a due date passes) or an **action** (something is done: ask for an approval or feedback, assign a task, notify, set a status, wait, finish); each has named **outcomes**. A connector wires an outcome to a node and may carry a **condition**; a connector that runs back is a loop and needs a way out (an "until"). **Groups** frame a stage. The rules, checked by the builder and the engine alike: an action never starts a flow, an event never ends one, an action follows an outcome, a loop needs a stop, and nothing follows a finish. A project's workflows share one canvas; a basic view edits the same flows as a list of steps; every workflow can be read and written as YAML. This refines the stage model in `docs/domain.md` and #25.

## 041. Billing and support are modules, off by default

`HEKATE_BILLING` (off, stripe, paddle, manual) and `HEKATE_SUPPORT` (off; app, tickets in the application; link, an external desk; or mail, tickets sent to an address) are set in the environment and default to off, so a self-hosted install shows neither. `HEKATE_DOCS_URL` (default `https://docs.hekate.studio`) and `HEKATE_STATUS_URL` point the help menu at the documentation and a status page. With support on, the help menu offers the documentation, a workspace's tickets and a new ticket; a ticket's severity is limited by the workspace's plan.

## 042. Every visible error carries a reference

Any error a person can see (a 5xx, or a refusal worth a support question) carries a short reference such as `HK-7F3A-2C`, written to the structured log with the request, person, job and stack. Operators look references up in the debug tools; a ticket that quotes one links to it.

## 043. System information shows releases; the image stays immutable

The instance shows the running version and build, the update channel and the releases available with their notes and upgrade instructions. For 1.0, nothing is patched in place: an upgrade is a new image. Signed hot patches applied as overlays may come later as an explicit opt-in (#158).

## 044. Mail is plain text first, with an HTML alternative, and fetches nothing

Every message is one shape (who did what, one action, a line about why you got it) rendered from one structure into both parts of a multipart mail. The plain-text part is written as text: wrapped at 72 characters, links on their own lines, the foot after a `-- ` signature line; it is never derived from the HTML. The HTML part is laid out in tables, light colours inline and dark ones from a `prefers-color-scheme` query, and holds no images: the mark is drawn in table cells, so nothing is fetched and nothing reports that a message was opened. Every link goes to the app. A workspace may change each template's subject line, using only the placeholders that template offers. Mail about something a member is told of goes through the notifications table, which already retries; a message carrying a one-time link (a guest's link, an invitation) is sent at once and never queued, because job data holds no secrets, and the sender can send it again. Bounces are recorded once a provider that reports them is configured (#71).

## 045. One registry of keyboard shortcuts, and a map of what works here

What is on a page registers its shortcuts while it is there (`lib/shortcuts.tsx`), and one listener runs them; "?" opens a map of exactly those, grouped by where they belong. None fires while someone types in a field or while a dialog is open, Space and Enter stay with a focused control, and a change of state (playing, the loop, the sidebar, a comparison source) is announced to assistive technology. The player's keys work anywhere on its page, as in Frame.io: Space or K plays and pauses, J and L (or the arrows) jump by the chosen step, comma and full stop step a frame (a hundredth of a second for audio), I and O set the loop at the playhead and Shift+L turns it on or off; 1 to 4 pick a comparison source and C starts a comment at the playhead. Lists and the document viewer keep their keys to themselves when focused (j and k move a list) and show them on the map while they are on the page.

## 046. A second factor is asked for by the workspace, and owed before anything else

The first second factor is a code app (TOTP), because every phone already has one and it needs nothing from the instance; passkeys and hardware security keys join it (#39). A workspace requires it of nobody, of its owners and admins, or of everyone, and only someone who already has one can require it, so nobody locks themselves out; an instance can require it of every account. Someone who owes one is held at a single page that adds it (password, QR code and key, a first code, then the recovery codes) and every member route refuses them with a code the app acts on, rather than letting them work and asking later, because a requirement that can be put off protects nothing. Recovery codes are shown once and kept only as keyed hashes, like the guest links and reset codes, so a copy of the database signs no one in. A browser can be trusted for 30 days, as Linear and GitHub allow, so the second step is rare where people actually work.

## 047. A deleted account leaves what it did, as a former member's

Deleting an account keeps the record and removes the person. Comments, decisions and access log entries stay where they are, so a review's history and the log still make sense, but every one of them now reads "A former member": the account row stays only so that what was written keeps an author, and it holds no name, address, picture or preference afterwards. Sign-in, sessions, the second factor, memberships, project roles, preferences, notifications, follows, marks and saved searches go, and the address leaves every invitation that named it, in every workspace. An entry the log receives for the account after it is deleted (a request already under way) is labelled the same way by the database itself. Deleting needs a session but no workspace, so someone removed from their last one can still delete theirs. The access log stays append-only: the one change it allows is replacing the label on an account's own entries, in the transaction that deletes that account (migration 0040). Deleting needs the account's address typed out and its password, and is refused while the account is a workspace's only owner, as GitHub and Linear refuse it, so that no workspace is left with no one to run it. Words other people wrote about the person (a mention in a comment) are theirs and stay.

## 048. A session knows how it was signed in, and the rule reads the session

Each sign-in records its factor on the session: a password alone, a password and a second factor (a code, a recovery code, or a browser trusted after a code), or a passkey. A workspace's rule is then a rule about the session, not only the account: asking for a second factor is met by a code-backed or passkey session, and asking owners and admins for a hardware security key is met by a passkey session alone. An account that has a passkey but signed in with its password is not turned away; it is asked to confirm with the key (a step up, as GitHub asks for sudo mode), and only an account with no factor at all is asked to add one. Removing a code app takes what it gave from the session at once. Passkeys and hardware security keys are both WebAuthn credentials: a synced passkey and a single-device key are listed as such, each named, with when it was last used, and an account may hold up to five unless the operator raises the limit (`MAX_PASSKEYS`).

## 049. A directory signs people in to its own workspace, and never takes over an account

LDAP and Active Directory are set per workspace rather than per instance, because one instance may serve several organisations with their own directories, and a directory is trusted only about its own people. Someone signs in by naming the workspace, then their directory username and password; the directory checks the password, never Hekate. Their first sign-in makes the account and the membership, as single sign-on does in Linear and Slack, and each sign-in sets the role their groups give, so leaving a group takes effect at the next sign-in. A directory can make admins and members, never owners: owners are made by people. An address that already has an account here, made by invitation or another directory, is refused rather than linked, because linking on an address alone would let whoever controls one directory sign in as anyone. The sign-in page only offers a directory while some workspace has one turned on, and says no more than that. The first sign-in makes the account, its link to the directory and the membership in one transaction, one sign-in per address at a time, so two at once make one account and a failure part-way leaves nothing behind. An account made this way has no password here: deleting it is confirmed with the directory password, checked by binding as the person it is linked to.
