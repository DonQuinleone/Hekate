# Hekate prototype: screen inventory

Every screen and state the clickable prototype will show, for every kind of user. Proposed for approval before anything is built. Sample data is fictional throughout: Endless Hall Records, the projects *Joplin Rags* (music) and *Opening titles* (video), and four people (Mira Solberg, Tomas Varga, Ines Arlow, Alex Rivera).

Issue numbers in the last column show where each of the 67 issues (open and closed) is represented. Everything built so far, everything planned in conversation, and the ControlRoom, Argus and Hekate-Legacy feature sets are folded in.

## 1. The people you can be

A switcher in the bottom-right corner sets who you are. The data never changes; what you see and may do does. Where a role cannot do something, the prototype shows what that person actually meets: a control that is absent, a page that answers "not found", a review with only their own comments.

| Switcher entry | Who | What the prototype shows |
| --- | --- | --- |
| Owner | Alex Rivera, organisation owner | Everything: every project, organisation settings, security policy, storage, the access log. |
| Admin | Ines Arlow, organisation admin | Everything in every project and the settings, but cannot remove the last owner or delete the organisation. |
| Producer | Mira Solberg, Producer on Joplin Rags | Upload, organise, request reviews, triage, decide, edit workflows, manage roles, run the production tools. |
| Engineer | Tomas Varga, Engineer on Joplin Rags | Upload, organise, comment, triage; QA, meters, spectrogram and takes on; no reviews, no roles. |
| Editor | Tomas Varga, Editor on Opening titles | As Engineer, in the video project: cuts, renditions, edit decisions. |
| Reviewer (member) | Ines Arlow, Reviewer on Joplin Rags | View, comment, decide; no upload, no triage; QA and takes only where the project's tool access grants them. |
| Viewer (member) | Alex Rivera as a Viewer on Opening titles | View and play only: no comment box, no decision, no download. Opening titles is the only project in their list. |
| Approval reviewer | Ines Arlow, asked to approve *Album masters* | The review page with a decision to record, the items, the order and the log. |
| Feedback reviewer | Tomas Varga, in the *Mix notes* feedback round | The same page with no decision: submit feedback instead. |
| Guest | Mira Solberg as a conductor with no account | Arrives by magic link; no sidebar; only her reviews and their items; only her own comments and replies to them; the takes shared with her on a comment; versions and variations to listen to; a visible watermark on pages and video. |
| Group member | Ines Arlow through the *Soloists* group | A review sent to a group in sequence: her step, the group named on her card, waiting while the earlier step finishes. |

Names repeat across roles because the sample cast is four people; the switcher says who you are at every moment.

Beside the role, the switcher carries prototype-only settings: **shadows** (only for what floats, or none, to settle the brand question), **width** (desktop, phone), and **state** (as the data is, empty, loading, processing, failed, refused, expired, long names and long lists), so any screen can be seen in any state.

## 2. Modularity: what each person is given

Flexibility is a core aspect, so the prototype makes it visible rather than assuming it.

- **Tool access** is a matrix per project: for each role, which tools are on (QA, meters, spectrogram, score, takes, compare, loops, normalisation toggle, download, production tools). Organisation defaults, overridable per project, per role, per person or group, and per review for its reviewers. A recording engineer has QA; a conductor does not.
- **Comment visibility** per reviewer: everyone's comments; own and replies to them; only own.
- **Takes shared to a comment**: a producer attaches chosen takes to a comment ("other options for bar 72"), and a reviewer with no take access hears exactly those, nothing else.
- **Sections of the recording page** appear or vanish by that matrix: a conductor sees player, versions, variations, score and her comments; an engineer also sees QA, meters, takes and the spectrogram view.
- **Review-time ceilings**: a member's project role is the most a review can grant; a guest gets exactly what the review grants.

## 3. Screens

Each screen lists its states. Every screen is designed at desktop (1440) and phone (390) width. "Round" is when it is built (section 4).

### 3.1 Arriving

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Sign in | Email and password or passkey; "Continue with" single sign-on when the organisation sets it; a directory username when LDAP is configured; second-factor and security-key prompts. | Wrong password; too many attempts; SSO required (password hidden); passkey prompt; security key required by the organisation; session expired. | #5 #37 #38 #39 |
| First-run setup | Create the first organisation and owner. | Validation (12-character passwords). | #5 |
| Invitation | Accept an invitation: create the account, or sign in to accept. | Expired; already used; signed in as someone else. | #59 |
| Guest link | Opening a magic link: the review opens, with who you are and how long the link lasts. | Expired; used; revoked; outside the access window ("opens 20 Oct"); view or play limit reached; "open the link in your email" when signed out. | #24 #55 |
| Guest home | A guest's reviews, nothing else. | Empty (no open reviews). | #24 |
| Not found and refused | A project or file you cannot see answers "not found"; an action you may not take is absent, or refused if reached by address. | 404; refused; a hidden project missing from the list. | #23 |

### 3.2 Home and navigation

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Shell | Sidebar: Reviews with a count waiting on you, Projects with a short list, Members, Production (music projects); collapses to icons ("[" and a button, remembered); organisation in the account menu with a switch; search; notifications; connection and version at the foot. | Collapsed; phone (bottom bar and sheet); long organisation and project names; API unreachable. | #4 #6 #59 |
| Dashboard (home) | Waiting on you: reviews to decide, feedback to give, comments to triage, comments assigned to you; upcoming due dates; recent activity; uploads processing. | Empty (new organisation); loading. | canvas note |
| Reviews (mine) | Every review you are in or asked for: waiting on you, in progress, finished; state dots. | Empty; long list; filters. | #22 |
| Notifications | Decisions, replies, new versions, stage changes, assignments; mark read. | Empty. | #25 |
| Search | Across projects, files, tracks, comments and people. | No results. | #6 |

### 3.3 Projects

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Projects list | Rows: name, profile, members, what is waiting. | Empty (create your first project); loading. | #6 |
| New project | Name, profile (music, video, general: decides which tools appear), the roles it starts with. | Validation. | #2 |
| Project overview | The project's dashboard: due dates, what waits on whom, recent activity, next stage per track or deliverable, uploads processing. | Empty project; long lists. | canvas note |
| Project files | The file manager: folders, tracks among folders as a special kind of folder, files; list and grid; Upload button and drop anywhere; "attach to" after upload (a version's variation, a take, loose); row menus on hover (rename, move, delete); breadcrumb; sort and filter. | Empty folder; uploading (resumable, per-file progress, retry); processing (probing, analysing, rendering pages); failed upload; failed processing; long names; thousands of files; a file under review that cannot be deleted. | #8 #10 #19 #20 #27 |
| Project board | Where everything stands: columns per workflow status, each card a track or deliverable with who it waits on, the next stage and the due date; a timeline view approximating a Gantt from the schedule and due dates. | Empty; a track with no workflow. | #26, canvas note |
| Project reviews | Reviews in this project: state, due, reviewers responded; request a review. | Empty. | #22 |
| Project people | Members and their roles, groups, guests; invite; change role; remove. | A pending invitation; empty groups. | #23 #24 |
| Project settings | Name, profile, delivery profile, comment categories, carry-over default (show on this version), playback normalisation (off, optional, forced), upload rules (require an edit decision list), tool access matrix, roles, workflow, watermark, storage backend for new files, danger zone. | Validation; a role in use cannot be deleted. | #7 #23 #31 #35 #36 #43 #55 #56 #98 |
| Roles | The permission matrix per role with the five defaults; add, rename, delete a role. | The last role with "manage roles" cannot lose it. | #23 #80 |
| Workflow builder | A canvas of stages (approval, feedback, task) and statuses with connections for transitions and dependencies; a stage editor (kind, participants, order, rule, due offset, notifications); statuses grouped to do, in progress, done; templates (Simple approval, Conductor first, Parallel stakeholders); duplicate from another project; simulation stepping through outcomes; activate; per-track override. | Default workflow; invalid graph; simulating; a track overriding the project. | #25 #26 |
| Comment categories | Name, colour, key, default handling (normal, deferred to a stage, information only); defaults Noise, Edit, Balance, Performance. | Default set. | #36 |
| Delivery profile | Streaming, CD, Apple Digital Masters, broadcast, 5.1, Atmos, custom (loudness target and tolerance, true peak ceiling, rates, bit depth, layout). | Suggested from the layout when unset; custom editor. | #41 #43 |
| Watermark | Position, opacity, scope (guests only, everyone), preview. | Off. | #31 |

### 3.4 Music: tracks, versions and variations

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Track | A track as a folder: versions in order, each with its variations and the primary marked, who uploaded and when, the note; workflow status and the next stage; the score linked; add version; add variation; set primary. | No versions; one; many; a version still processing; processing failed. | #20 #25 |
| New version | Upload one or more files as the next version, variations named, a primary chosen, a note; optional edit decision list; restart the workflow from a chosen stage; carry over open comments with their mapped anchors to confirm or correct. | Rule refused (EDL required); resuming an interrupted upload; carry-over list. | #10 #25 #35 #56 |
| Recording: Review | The player on one combined waveform; View menu: split channels, spectrogram below, behind or instead, colour map and scale presets; channel layout for surround and Atmos (lane per channel, LFE distinct, solo, mute, level, downmix switch, "hearing: stereo downmix" label, binaural); version and variation switches keeping the position; loop (drag, nudge, pre and post roll, loop a comment or bar range); quick comparison (sources on keys 1 to 4, level-matched, aligned, blind mode); playback rate; the normalisation toggle where allowed; the loudness chip opening QA; the comment column with Open, Resolved and Deferred, category filters, carried threads, before and after; the composer with its anchor (at playhead, range, bar, whole file), bars typed ("25", "0" for an upbeat, "9-12"), pages and beats optional, a category and the keyboard map on "?". | Loading peaks; processing; analysis failed; no comments; long threads; a thread hidden on this version; a reviewer seeing only their own comments; a reviewer without the spectrogram; a surround file; blind comparison in progress; normalised playback. | #11 #12 #14 #15 #33 #34 #35 #36 #44 #74 #98 |
| Recording: QA | Findings worst first against the delivery profile (clipping, true peak, dropouts, clicks, silence, DC offset, balance, phase, bandwidth, format), each playing from where it is, passes folded away, one action making a comment with a category; loudness (integrated, range, true peak, short-term history); meters at the playhead (peak, RMS, mid, side, correlation, per channel, goniometer); format; embedded metadata (bext, iXML, ID3, artwork); markers on the waveform; what changed since the previous version (fixed, new); report export (PDF, CSV, JSON) stamped with project and engineer details; the profile chooser. | No findings; analysis running; file not analysable; profile unset (suggested); diff with nothing changed; a reviewer without QA. | #41 #43 #74, canvas note |
| Score beside the recording | The score's pages as paper on the desk, under or beside the player; thumbnails; go to page and go to bar; the score's own comments; region comments. | No score linked; rendering; more than 300 pages. | #12 #29 |
| Comment thread | A thread in full: anchor, replies, category, assignee, deferred to a stage, carried from a version with status (open, fixed in V5, not fixed, won't fix) and "show on this version", before and after player, other takes for this bar, loop this, resolve, edit, history across versions. | Resolved; deferred; carried with a moved anchor; a reply you cannot see. | #14 #35 #36 #46 |
| Triage | For those who may: a version's open comments to categorise, defer, undefer, assign, resolve and carry, with bulk actions; what returns when a stage starts. | Nothing to triage. | #36 |
| Compare versions | Two versions aligned by their audio, the alignment path and quality, comments mapped across, findings fixed and new. | Alignment running; alignment too poor to use. | #33 #43 |
| Comment export | A version's comments as a timed list for a target application (Pyramix, SADiE, Pro Tools, Sequoia, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, CSV), scope (this version, open only, by category). | Nothing to export. | #99 |
| DAW synchronisation | The take log's "synced to recorder" state and a connected-client indicator, as a placeholder for the post-1.0 client. | Not connected. | #58 |

### 3.5 Video: deliverables, versions and renditions

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Deliverable | Like a track: cuts in order, renditions per cut (16:9, 9:16, subtitled, clean, graded; one primary), the H.264 and the royalty-free (AV1 or VP9) rendition marked. | No cuts; a rendition still encoding. | #16 |
| Video: Review | The frame with filmstrip and waveform, SMPTE timecode and frame number, frame stepping, range and region and drawing comments, rendition switch, compare cuts side by side and by wipe, the per-viewer watermark overlay, audio layout (stereo, 5.1, Atmos bed) with solo and mute. | Processing; failed; long comment list; a guest with a visible watermark. | #16 #31 #44 #74 |
| Video: QA | Format conformance, black and frozen frames, dropped or duplicated frames, interlacing, broadcast-safe levels, letterboxing, timecode continuity, flashing risk, programme loudness; markers on the timeline; report. | No findings; running. | #42 #43 |

### 3.6 Documents, pictures and other files

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Document | Pages the server drew, thumbnails, zoom, region comments numbered in reading order, page comments, whole-file comments; watermark for guests. | Rendering; more than 300 pages; a picture (one page); failed render. | #29 |
| Other file | A file with no viewer: details and whole-file comments; a simple version chain. | No preview. | #19 |
| File details | Format, size, checksum, uploaded by, storage backend, encrypted at rest, renditions, pages, analysis state, this file's access log. | Processing. | #7 #28 #30 |
| Download | The download permission at work: proxy or original, watermarked per recipient and logged; the confirmation. | No permission (absent); refused. | #32 #55 |

### 3.7 Sessions and takes (the take manager)

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Sessions | The project's sessions (Day 2, St John's) with dates, venue and take counts. | Empty; importing. | #21 |
| Take import | Drop every session file; the proposed tree (sessions, takes by take number and timecode, one file per microphone, the summed mix, assignment to tracks by matching audio) with confidence, bulk fixes and undo; file-name patterns. | Unplaced files; a grouping to fix; progress for thousands of files. | #45 |
| Session | Takes in order: number, rating, starred, false starts, notes, timecode, coverage (page and bar range), microphones, used in which version. | Empty session; a take with no coverage. | #21 |
| Take | Play a take with its microphones (solo, mute, summed mix), loop, rating and notes, coverage, its place in the score; quick-compare takes; share to a comment. | Processing. | #21 #44 |
| Other options for bar 72 | From a bar comment: every take covering the bar with rating, stars and notes, which is in the current version, audition at the bar looped and level-matched; share chosen takes to the thread. | None cover it; takes not aligned. | #46 |
| Take coverage | Which takes cover which bars, as a grid across the track; gaps; proposed ranges to accept. | No coverage entered. | #46 |
| Edit decisions | Which takes a version uses for which bars, imported from an EDL (CMX 3600, Pyramix, Sequoia), matched to takes; a lane on the waveform and score; the check that every hand-over matches. | No EDL; an unmatched event. | #56 |

### 3.8 Reviews

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Request a review | Items (tracks at a version or the latest, deliverables, files), kind (approval, feedback), reviewers (members, guests, groups), order (all at once, in sequence), rule (everyone, any one), due date, message, permissions for everyone and per reviewer (items, history, comments, tools, download, access window, view limit, actions). | Validation; a guest with no email; a group that cannot see the project. | #22 #24 #55 |
| Review page: approval | The decision as the raised object: approve or request changes with a note, appended to the record; the items with opened state; reviewers and their decisions in order; the log; actions (remind, change due date, invite a guest, re-send or revoke a guest link, copy link, cancel). | In review; your decision recorded; changes requested; approved; cancelled; sequence waiting on an earlier step; a reviewer asked for no decision; due date passed. | #22 #24 |
| Review page: feedback | The same page with no decision: items, comments, submit feedback; what others wrote where the permission allows. | In progress; submitted; everyone submitted. | #22, canvas note |
| Review as a guest | No sidebar; items, player, own comments and replies, the decision, the watermark, the access window, the link's expiry. | Expired; view limit; outside the window. | #24 #31 #55 |
| Reviewer permissions | Adjust one reviewer: items, history, comments, tools, download, window, limit, actions. | A member's ceiling greyed. | #55 |
| Groups | A project's groups and their people in order. | Empty. | #24 |

### 3.9 Workflow

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Track workflow | Where a track is: stages done, current, waiting on whom, next; the history of transitions; restart from a stage. | No workflow; overridden; restarted. | #25 |
| Stage notifications | Who is told on entering a stage or status, in the app and by mail. | None. | #25 |

### 3.10 Production (from ControlRoom)

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Repertoire | Works with title, composer, forces, abbreviation, notes, tracks in order (numbers as typed: "1", "I", "2a"), the score file with each track's printed page range and the page offset; alphabetical or schedule order. | Empty; a work with one track. | #48 |
| Venues | Venues with multi-line addresses. | Empty. | #48 |
| Personnel | Artists, ensembles, staff, others; session agreement and headphone flags; links to members and guests; the ensemble breakdown (sections, named members with divisi, or a head-count, seating notes). | Empty; an ensemble before names are known. | #49 |
| Schedule | Day rows (label, date, venue), repertoire slots, breaks, get-ins, venue changes; times chaining from the previous row; durations; personnel and notes; ticked off live and fading for everyone; "run timer to slot end"; coverage view; exports (PDF with front page and ensemble breakdown, XLSX). | Empty; a track with no slot; today's day live. | #50 |
| Take log (live) | Keyboard-first: Space starts the next take; numbering continuous, per track or synced to the recorder; rating 1 to 5, false starts, notes, timecode in and out, wall-clock times, score start and end; lifecycle idle, armed, recording, recorded, aborted; the large-print overview; the session clock with its countdown; metronome and tuning tone (415, 432, 440, 442 Hz); to-do and notes; the keyboard map on "?"; CSV export. Two views of the same log: the logger's spreadsheet and the producer's score, clock and take number. | Offline (written locally, synced later, conflicts per field); synced to the recorder; a take aborted. | #51 #58 |
| Score marking | The producer's pencil on the score pane: issue marks and regions in categories on single keys, with the takes affected and the take that fixed them; T-edits (3T4, lead-in T3, chains, overdubs); take start and end; punch-ins; wrong-note crosses; circled dynamics; sticky notes; ink; the inspector; single, two-up and continuous layouts; filters (invert, sepia, amber, cyan, grey); go to page and bar; step through edit points; the edit plot check; swap the score keeping marks; exports (annotated PDF, marks CSV). | No marks; an edit plot with a broken chain. | #52 |
| Stage plan | Metre-scaled plan with grid and snapping: performers and ensemble blocks sized from the head-count, microphones linked to the patch list, instruments and objects, risers, walls, cables, labels, label groups; an optional floor-plan underlay; marquee, align, rotate, resize, undo; export PDF (A3 or A4, rulers, scale bar). | Empty; no underlay. | #53 |
| Patch list | Stage boxes with input and output tables (source, device, cable or channel, notes), linked to microphones; exports (PDF, XLSX). | Empty. | #54 |
| Project import | Import a ControlRoom project (.croom): what will be created, counts per kind, conflicts, errors. | Nothing to import; conflicts. | #57 |

### 3.11 Organisation, settings and operations

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Members | Members with organisation roles, pending invitations (resend, revoke), guests (name, email, label; revoke); invite. | Empty invitations; the last owner cannot be removed. | #24 #59 |
| Organisation settings | Name, defaults for reviewer permissions and tool access, comment categories, delivery profiles, storage backend; switch organisation. | Validation. | #7 #55 |
| Security | Sign-in policy: methods allowed, second factor required, security key required; SSO providers (OIDC, SAML: metadata, certificate, attribute and group-to-role mapping, enforce with break-glass); LDAP (server, TLS, bind, search, mapping, test connection). | SSO test failed; LDAP test failed; enforced. | #5 #37 #38 |
| Account | Name, email, passkeys and security keys (named, last used, revoke, up to five), recovery codes, sessions, notification preferences. | A key added; limit reached. | #39 |
| Mail | Provider (SMTP, Google Workspace, Microsoft 365, SparkPost, Mailgun, SendGrid, Mailcoach, Plunk, Postal, Amazon SES) with its fields, from address, test send. | Test failed; log-only in development. | #59 #71 |
| Storage | Backends (local disk, S3-compatible), default for new objects, usage, reconciliation (last run, orphaned, removed, missing bytes needing a person; report only). | Missing bytes found. | #7 #67 |
| Leak tracing | Forensic marking on streams and downloads; upload a suspected leak; the matching access or "no mark found". | Match; no match; scanning. | #32 |
| Access log | Every key issue, stream, page render, download, guest sign-in, decision and export, with person, review, address and agent; filters by project, file, review, person, action, time; CSV export. | Empty; long. | #30 |
| Operations | Connected, version, worker on or off, queue depth, encryption and key rotation state, Prometheus endpoint, backups and upgrade notes. | Worker off; key rotation pending. | #4 #9 #17 #28 #62 #70 |

## 4. Rounds

- **Round one:** the shell and switcher, home and the dashboards, projects and files, the track, the recording page (Review and QA) with the score, loops, comparison and takes, the comment thread, the review pages, the guest experience, and every state of those. The two open questions settled.
- **Round two:** video, documents, the board and the workflow builder, triage and categories, carry-over and version comparison, exports, normalisation, members and groups.
- **Round three:** the production tools, organisation settings, security, mail, storage, watermarking, leak tracing, the access log, operations, and every remaining state.

## 5. Questions for round one

1. **Shadows.** The prototype implements "shadows only for what floats" (menus, popovers, dialogs, the paper of a score) with a switch to the brand's current "no drop shadows", so both can be compared on the same screens. Proposed: amend `docs/brand.md` to the former.
2. **Spectrogram on Review.** Your canvas note says the spectrogram belongs on the main review page as a view option, and the brief says technical detail lives on QA. Read together: the spectrogram, split channels and colour maps are **views of the player** on Review, from its View menu (decision 028); meters, loudness history, format, metadata and findings are **QA**. The loudness chip on Review opens QA.
3. **Bars.** "We're not having bars" and "support pages, bars and beats, all optional" are read together as: no bar ruler on the waveform; bars, beats and pages typed into comments, each optional; the score beside the recording for reference.
4. **Project views.** Your note asks for a dashboard, a file manager, a board (Kanban, approximate Gantt) and a workflow screen. All four are in 3.3. Proposed: a project opens on its overview.
5. **ControlRoom's hidden model.** Take lifecycle, timecode in and out, wall-clock times, score start and end, numbering modes, the unused mark kinds (take start and end, wrong-note cross, circled dynamic) and category editing exist in ControlRoom's data but not its interface. The prototype surfaces all of them, as the issues ask; say if any should stay hidden.
