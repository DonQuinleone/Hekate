# Hekate prototype: screen inventory

Every screen and state the clickable prototype will show, for every kind of user. Proposed for approval before anything is built. Sample data is fictional throughout: Endless Hall Records, the projects *Joplin Rags* (music) and *Opening titles* (video), and four people (Mira Solberg, Tomas Varga, Ines Arlow, Alex Rivera).

Issue numbers in the last column show where each of the 67 issues (open and closed) is represented. Everything built so far, everything planned in conversation, and the ControlRoom, Argus and Hekate-Legacy feature sets are folded in.

## 1. The people you can be

A switcher in the bottom-right corner sets who you are. The data never changes; what you see and may do does. Where a role cannot do something, the prototype shows what that person actually meets: a control that is absent, a page that answers "not found", a review with only their own comments.

| Switcher entry | Who | What the prototype shows |
| --- | --- | --- |
| Instance admin | Alex Rivera as the operator of this install | The instance: tenants (organisations), their usage and state, instance settings, operations; no project content unless also a member. |
| Owner | Alex Rivera, organisation owner | Everything in the organisation: every project, its settings, security policy, storage, the access log. |
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
- **Takes shared to a comment**: a producer attaches takes to a comment ("other options for bar 72"), choosing specific takes, every take covering the passage, or all but the ones left out; a reviewer with no take access hears exactly those, nothing else, and a guest only through a thread their review shows them.
- **Personal preferences**: within what they are given, each person shows or hides what they want (the spectrogram view, split channels, loudness monitoring, the metadata editor) and picks a theme.
- **Sections of the recording page** appear or vanish by that matrix: a conductor sees player, versions, variations, score and her comments; an engineer also sees QA, meters, takes and the spectrogram view.
- **Review-time ceilings**: a member's project role is the most a review can grant; a guest gets exactly what the review grants.

## 3. Screens

Each screen lists its states. Every screen is designed at desktop (1440) and phone (390) width. "Round" is when it is built (section 4).

### 3.1 Arriving

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Sign in | Email and password or passkey; "Continue with" single sign-on when the organisation sets it; a directory username when LDAP is configured; second-factor and security-key prompts; a recovery code instead of the app's code, with "trust this browser for 30 days"; adding a code app before anything else when the workspace asks for one. | Wrong password; too many attempts; wrong or used code; SSO required (password hidden); passkey prompt; security key required by the organisation; second factor required; session expired. | #5 #37 #38 #39 #125 |
| Installer | A full installer: requirements, database, storage backend, the master key and its backup, mail (SMTP and the providers that offer it, Amazon SES and Plunk among them; Microsoft 365 through Microsoft Graph; Mailcoach through its API; or the log), the public address, then the first organisation and owner. | A failed check; validation (12-character passwords). | #5 #9 #17 #71 |
| Invitation | Accept an invitation: create the account, or sign in to accept. | Expired; already used; signed in as someone else. | #59 |
| Sign up | Make a workspace without an operator, as the instance's registration allows: the email first, confirmed by a link; at the link, the workspace's name and subdomain and the owner's account (or sign in, for an address with one); a trial when billing is on. "Make a workspace" from sign-in with open sign-up. | Link sent; invite-only; closed; link expired, used or withdrawn; subdomain taken; too many tries. | #184 |
| Guest link | Opening a magic link: either the review opens at once, or (per organisation setting) the guest enters their email, receives a code and enters it before the review opens; who you are and how long the link lasts. | Expired; used; revoked; outside the access window ("opens 20 Oct"); view or play limit reached; "open the link in your email" when signed out. | #24 #55 |
| Guest home | A guest's reviews, nothing else. | Empty (no open reviews). | #24 |
| Status page | `/status`, for anyone, signed in or not: what is happening now (each open incident with its updates), each service (App and API, Database, Storage, Processing, Mail) with its state and 90 days as bars over its uptime, and past incidents. Never names a workspace, a person or a version. | Every service running; an incident open (the switcher's failed state); nothing measured yet (empty); loading. | #183 |
| Not found and refused | A project or file you cannot see answers "not found"; an action you may not take is absent, or refused if reached by address. | 404; refused; a hidden project missing from the list. | #23 |

### 3.2 Home and navigation

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Shell | Sidebar: Reviews with a count waiting on you, Projects with a short list, Members, Production (music projects); collapses to icons ("[" and a button, remembered); organisation in the account menu with a switch; search; notifications; connection and version at the foot. | Collapsed; phone (bottom bar and sheet); long organisation and project names; API unreachable. | #4 #6 #59 |
| Dashboard (home) | Waiting on you: reviews to decide, feedback to give, comments to triage, comments assigned to you; upcoming due dates; recent activity; uploads processing. | Empty (new organisation); loading. | canvas note |
| Reviews (mine) | Every review you are in or asked for: waiting on you, in progress, finished; state dots. | Empty; long list; filters. | #22 |
| Notifications | Decisions, replies, new versions, stage changes, assignments; mark read. | Empty. | #25 |
| Search | Across projects, files, tracks, comments and people; advanced search by field (type, duration, size, frame rate, tags, uploader, comment text) with saved searches. | No results; a saved search. | #6, legacy |

### 3.3 Projects

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Projects list | Rows: name, profile, members, what is waiting; archive and templates. | Empty (create your first project); loading; archived. | #6, legacy |
| New project | Name, profile (music, video, general: decides which tools appear), the roles it starts with. | Validation. | #2 |
| Project overview | The project's dashboard: due dates, what waits on whom, recent activity, next stage per track or deliverable, uploads processing. | Empty project; long lists. | canvas note |
| Project files | The file manager: folders, tracks among folders as a special kind of folder, files; list and grid with configurable columns; Upload button and drop anywhere; "attach to" after upload (a version's variation, a take, loose); row menus on hover (rename, move, tag, pin, favourite, mark viewed, delete); bulk selection; breadcrumb; sort and filters (type, unviewed, with comments, mine, favourites, tags), which look across the whole project, each result saying where it lives, shown as removable chips under the toolbar; pins keep things at the top of their folder, and an unviewed file carries a dot. | Empty folder; uploading (resumable, per-file progress, retry); processing (probing, analysing, rendering pages); failed upload; failed processing; long names; thousands of files; a file under review that cannot be deleted. | #8 #10 #19 #20 #27 |
| Project board | Where everything stands: columns per workflow status, each card a track or deliverable with who it waits on, the next stage and the due date; a timeline view approximating a Gantt from the schedule and due dates. | Empty; a track with no workflow. | #26, canvas note |
| Project reviews | Reviews in this project: state, due, reviewers responded; request a review. | Empty. | #22 |
| Project people | Members and their roles, groups, guests; invite; change role; remove. | A pending invitation; empty groups. | #23 #24 |
| Project settings | Name, profile, archive, save as a template (roles, categories, delivery profile, QA rules and version checks, a copy; the workspace's templates listed, removable by whoever saved one or an admin; new projects start from a template or another project), delivery profile (project default, overridable per track and file), comment anchors (pages, bars, beats on or off, also per track), comment categories, carry-over default (show on this version), playback normalisation (off, optional, forced), tool access matrix, roles, workflow, asset security, storage backend for new files, danger zone (archive; delete, asked for by someone who may delete and confirmed by a second workspace owner, typing the project's name, then archived and removed after seven days unless kept; move to another workspace, asked for by someone who may delete it, typing its name and their password, moved at once where they run both workspaces, otherwise approved by a second member and accepted by the other workspace). | Validation; a role in use cannot be deleted; a deletion asked for and waiting for an owner; a sole owner confirming a day later; a project to be deleted, with "Keep it"; a move waiting for its approval and acceptance, with Withdraw, Refuse and Approve. | #7 #23 #31 #35 #36 #43 #55 #56 #98 #240 |
| Roles | The permission matrix per role with the five defaults; add, rename, delete a role. | The last role with "manage roles" cannot lose it. | #23 #80 |
| Workflow builder | A canvas of stages (approval, feedback, task) and statuses with connections for transitions and dependencies; a stage editor (kind, participants, order, rule, due offset, notifications); statuses grouped to do, in progress, done; templates (Simple approval, Conductor first, Parallel stakeholders); duplicate from another project; simulation stepping through outcomes; activate; per-track override. Legible however it is drawn: each connector says its outcome and condition in a chip at its start, cut short where steps sit close, and loops run beneath in lanes of their own; Tidy up (Shift T, or a workflow's menu) lays every workflow out again with nothing overlapping, with Undo. Upload workflows too: rules on what arrives and prerequisite checks (a true peak ceiling, loudness, format, an edit decision list) that warn or refuse. | Default workflow; invalid graph; simulating; a track overriding the project. | #25 #26 |
| Comment categories | Name, colour, key, default handling (normal, deferred to a stage, information only); defaults Noise, Edit, Balance, Performance. | Default set. | #36 |
| Delivery profile | Streaming, CD, Apple Digital Masters, broadcast, 5.1, Atmos, custom (loudness target and tolerance, true peak ceiling, rates, bit depth, layout); the project default, and the override on a track or file. | Suggested from the layout when unset; custom editor; a track differing from its project. | #41 #43 |
| Asset security | Visible watermark (position, opacity, scope, preview), audio and video forensic marking on streams and downloads, download rules, who may delete. | Off; marking on. | #31 #32 |
| Tasks | A task list in the project: title, assignee, priority, status, due date, related files and deliverables, made by hand or from a comment; filters (mine, unassigned, overdue, done); export. | Empty; overdue. | legacy |
| Upload request | A link for someone outside to upload into a folder: name, what is wanted, destination (a folder, or as the next version of a track), file limit, expiry, password, an address to email the link to; the visitor's upload page; what arrived. | Expired; limit reached; files arrived. | legacy |

### 3.4 Music: tracks, versions and variations

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Track | A track as a folder: versions in order, each with its variations and the primary marked, who uploaded and when, the note; workflow status and the next stage; the score linked; add version; add variation; set primary; follow it by choice (Follow, Following), to be told of new versions. | No versions; one; many; a version still processing; processing failed. | #20 #25 |
| New version | Upload one or more files as the next version, variations named, a primary chosen, a note; optional edit decision list; the upload workflow's checks run before it lands; restart the workflow from a chosen stage; carry over open comments with their mapped anchors to confirm or correct. Replace a version's file, for those permitted, when an export was wrong. | A check refused (true peak over the ceiling, EDL required); resuming an interrupted upload; carry-over list; replacing with comments kept. | #10 #25 #35 #56 |
| Recording: Review | The player on one combined waveform; View menu: split channels, spectrogram below, behind or instead, colour map and scale presets; channel layout for surround and Atmos (lane per channel, LFE distinct, solo, mute, level, downmix switch, "hearing: stereo downmix" label, binaural); version and variation switches keeping the position; loop (drag, nudge, pre and post roll, loop a comment or bar range); quick comparison (sources on keys 1 to 4, level-matched, aligned, blind mode); playback rate; zoom into the waveform and spectrogram (=, −, 0 to fit), the playhead kept in view a page at a time; the normalisation toggle where allowed; the loudness chip opening QA; the comment column with Open, Resolved and Deferred, category filters, carried threads, before and after; the composer with its anchor (at playhead, range, whole file) and the reference fields page, bar and beat typed as the reviewer reads them ("25", "0" for an upbeat, "9-12"), never derived from the time and never on the scrub bar, each switchable off per project and track; the channel a comment is about, on a recording of two channels or more; a category and the keyboard map on "?"; where a recording has caption tracks (narration, an interview), the Captions menu shows the words under the waveform and the transcript sits beside the comments. | Loading peaks; processing; analysis failed; no comments; long threads; a thread hidden on this version; a reviewer seeing only their own comments; a reviewer without the spectrogram; a surround file; blind comparison in progress; normalised playback. | #11 #12 #14 #15 #33 #34 #35 #36 #44 #74 #98 |
| Recording: QA | Findings worst first against the delivery profile (clipping, true peak, dropouts, clicks, silence, DC offset, balance, phase, bandwidth, format), each playing from where it is, passes folded away, one action making a comment with a category; loudness (integrated, range, true peak, short-term history); meters at the playhead (peak, RMS, mid, side, correlation between any two channels, per channel, the stereo field as a goniometer draws it); format; embedded metadata (bext, iXML, ID3, artwork); markers on the waveform; what changed since the previous version (fixed, new); report export (PDF, CSV, JSON) stamped with project and engineer details; the profile chooser. | No findings; analysis running; file not analysable; profile unset (suggested); diff with nothing changed; a reviewer without QA. | #41 #43 #74, canvas note |
| Score beside the recording | The score's pages as paper on the desk, under or beside the player; thumbnails; go to page and go to bar; the score's own comments; region comments. | No score linked; rendering; more than 300 pages. | #12 #29 |
| Comment thread | A thread in full: anchor, replies with mentions, category, assignee, to-do with done, attached file, deferred to a stage, carried from a version with status (open, fixed in V5, not fixed, won't fix) and "show on this version", before and after player, other takes for this bar, loop this, resolve, edit, history across versions. | Resolved; deferred; carried with a moved anchor; a reply you cannot see. | #14 #35 #36 #46 |
| Triage | A view made for speed: the queue of a version's open comments one at a time with the passage playing, single keys to categorise, defer, assign, resolve and skip (the player keeps J, K and L; arrows move), bulk actions on a selection, what returns when a stage starts, and a closing summary that sends each person their list. Carrying is chosen when the next version is made. | Nothing to triage; a long queue; done. | #36, comment |
| Compare versions | Two versions aligned by their audio, the alignment path and quality, comments mapped across, findings fixed and new; blind A/B between them. | Alignment running; alignment too poor to use; blind. | #33 #43 #44 |
| Comment export and import | A version's comments as a timed list for a target application (Pro Tools, Nuendo, Reaper, Final Cut Pro, DaVinci Resolve, Premiere Pro, Avid, CSV, plain text), scope (open threads or all, with or without replies), time base (timecode from 00:00:00:00 or 01:00:00:00 at a frame rate; seconds or samples for CSV and plain text), encoding (UTF-8, Latin-1); a preview of the file itself; a printable sheet; import of a marker list in the same formats with an author and colour mapping, each thread it brings saying the list it came from. | Nothing to export; threads without a time left out of a marker list; an import with unmatched rows. | #99 #134, legacy |
| Listen together | One member leads and everyone who joins hears what they play, as they play it (play, pause, seeking, rate, and which file, version or variation), each through their own protected stream and permissions. One control in the file page's header: live rooms in the project to join, "Start leading"; leading, who is listening, Copy link, End for everyone; following, Leave. A strip above the player only when there is something to do (the browser waits for a tap; the leader is on another file), a pill elsewhere in the app, and the link's page with Join. Members only. | No one joined yet; leader on another file; the browser waits for a tap; ended or not yours (the link's page). | #200 |
| Recorders and the DAW | The take log reads a recorder live in the control room's browser, through one adapter per kind (a DAW over MIDI timecode and machine control; a Sound Devices recorder, or any other, from its timecode out into an audio input). One quiet control beside the log's status opens the connection: the recorder, its input, and whether it starts and stops takes (never, when the DAW records, when it rolls); the browser asks for MIDI, MIDI system messages or the audio input only then. Only the browser that connects drives takes; the others see who does. In the player's View menu, "Follow the DAW": playback chases the DAW's MIDI timecode, from where the file starts on its timeline. | Not connected; connected and reading timecode; someone else drives (take over); refused by the browser; Safari, without Web MIDI. | #51 #58 #450 |

### 3.5 Video: deliverables, cuts and renditions

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Deliverable | A track in a video project, in video words (decision 138): cuts in order ("Cut 3"), renditions per cut with one primary, each shown by its shape and codec, read from the file, and whether it is subtitled or clean, graded or ungraded, as its people said (Describe the renditions); no takes or score; the H.264 and the royalty-free (AV1 or VP9) stream marked. | No cuts; renditions not yet described; a rendition still encoding. | #16 |
| Video: Review | The frame with filmstrip and waveform, SMPTE timecode and frame number (drop-frame aware), frame stepping and JKL shuttle, go to timecode, mattes and safe areas, a Captions menu of caption tracks (each with its language and kind: subtitles or captions for the deaf and hard of hearing), a transcript beside the comments (follows playback, a click seeks, searched, exported as SubRip, WebVTT or TTML), range and region comments and drawing (box, circle, line, arrow, freehand, text), rendition switch, compare cuts side by side and by wipe, the per-viewer watermark overlay, audio layout (stereo, 5.1, Atmos bed) with solo and mute. | Processing; failed; long comment list; a guest with a visible watermark. | #16 #31 #44 #74 |
| Video: QA | Format conformance, black and frozen frames, dropped or duplicated frames, interlacing, broadcast-safe levels, letterboxing, timecode continuity, flashing risk, programme loudness; markers on the timeline; report. | No findings; running. | #42 #43 |

### 3.6 Documents, pictures and other files

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Document | Pages the server drew, thumbnails, zoom, region comments numbered in reading order (drawn by dragging with a mouse or pen, or, with Draw on, by a finger or two taps on opposite corners), page comments, whole-file comments; watermark for guests; a loose file's simple version chain (V1, V2, chosen as a track's versions are, and New version in the file's menu, taking its place in the list). | Rendering; more than 300 pages; a picture (one page); failed render; an earlier version. | #29 #149 |
| Other file | A file with no viewer: what it is, details and whole-file comments; a simple version chain. | No preview. | #19 #149 |
| File details | Format, size, checksum, uploaded by, storage backend, encrypted at rest, renditions, pages, analysis state, this file's access log. | Processing. | #7 #28 #30 |
| Download | The download permission at work: proxy or original, watermarked per recipient and logged; the confirmation. | No permission (absent); refused. | #32 #55 |

### 3.7 Sessions and takes (the take manager)

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Sessions | The project's sessions (Day 2, St John's) with dates, venue and the tracks each recorded (many to many: a track may span several sessions). | Empty; importing. | #21 |
| Take import | Drop every session file; the proposed tree (sessions, takes by take number and timecode, one file per microphone, the summed mix, assignment to tracks by matching audio) with confidence, bulk fixes and undo; file-name patterns. | Unplaced files; a grouping to fix; progress for thousands of files. | #45 |
| Session | The tracks it recorded, and their takes logged that day: number, rating, starred, false starts, notes, timecode, coverage (page and bar range), microphones, used in which version. A take belongs to its track, not the session. | Empty session; a take with no coverage. | #21 |
| Take | Play a take with its microphones (solo, mute, summed mix), loop, rating and notes, coverage, its place in the score; quick-compare takes; share to a comment. | Processing. | #21 #44 |
| Other options for bar 72 | From a bar comment ("Other takes"): every take covering the thread's first bar, starred first, then by rating, with its bars and notes, each opening in the player looped on that bar; a link to all the track's takes; which the version's edit decision list uses there; Audition, hearing a take at the bar against the recording from the thread's moment, looped and level-matched, 1 and 2 flipping between them; sharing chosen takes to the thread. Takes shared on a bar thread open looped on its bar too, and are auditioned from the thread's attached takes the same way. | None cover it; a take without bars or length (opens from its start, no Audition); a thread without a moment (no Audition). | #46 |
| Take coverage | A track's takes (its Takes view): which cover which bars, as a grid across the track; gaps; a bar to find the takes covering it; all or the best; add takes by dropping or choosing files (each a scratch mix for now); edit a take's label, rating, star, notes, page, bars and in and out points. Bars are optional: a take without them says so. Edit decisions: the latest version's edit decision list (CMX 3600), each edit's place in the version, the take it comes from, where in the take and which bars, and what the list names that is no take; the takes it uses marked "in V3" with their bars under the lane; the timecode rate where the list does not say it. A version's list is imported, replaced or taken off from its menu. | No takes; no coverage entered; a take without bars; no edit decision list; an edit from no take of this track; a place in the take not known. | #21 #46 #56 |
| Edit decisions | Which takes a version uses for which bars, imported from an EDL (CMX 3600, Pyramix, Sequoia), matched to takes; a lane under a version's waveform naming each stretch's take and bars, the edit playing lit, a click going to the start of an edit; the upload rule reading the list a new version brings: refused when it holds no edits, or ends past the version's end (most often another version's list). | No EDL (no lane); an unmatched event (named as the list names it); a list refused. | #56 |

### 3.8 Reviews

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Request a review | Items (tracks at a version or the latest, deliverables, files), kind (approval, feedback), reviewers (members, guests, groups), order (all at once, in sequence), rule (everyone, any one), due date, message, permissions for everyone and per reviewer (items, history, comments, tools, download, access window, view limit, actions). | Validation; a guest with no email; a group that cannot see the project. | #22 #24 #55 |
| Review page: approval | The decision as the raised object: approve or request changes with a note, appended to the record; the items with opened state; reviewers and their decisions in order; the log; actions (remind, change due date, invite a guest, re-send or revoke a guest link, copy link, cancel); follow it by choice, to be told of decisions and feedback. | In review; your decision recorded; changes requested; approved; cancelled; sequence waiting on an earlier step; a reviewer asked for no decision; due date passed. | #22 #24 |
| Review page: feedback | The same page with no decision: items, comments, submit feedback; what others wrote where the permission allows. | In progress; submitted; everyone submitted. | #22, canvas note |
| Review as a guest | No sidebar; items, player, own comments and replies, the decision, the watermark, the access window, the link's expiry. | Expired; view limit; outside the window. | #24 #31 #55 |
| Reviewer permissions | Adjust one reviewer: items, history, comments, tools, download, window, limit, actions. | A member's ceiling greyed. | #55 |
| Share | The same system as a review with a share kind instead: items, people (members and guests), permissions, expiry, download and view limit, a message; no decision and no feedback to submit; who opened what. | Open; expired; limit reached. | comment |
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
| Take log (live) | Keyboard-first: Space starts the next take; numbering continuous, per track or synced to the recorder; rating 1 to 5, false starts, notes, timecode in and out, wall-clock times, score start and end; lifecycle idle, armed, recording, recorded, aborted; the large-print overview; the session clock with its countdown; metronome and tuning tone (415, 432, 440, 442 Hz); to-do and notes; the keyboard map on "?"; CSV export. A live view for a track, shared by everyone in the room and optionally synced to a DAW, with a view per person on the same data: the engineer's (take log, timecode, the patch list), the producer's (clock, timer, to-do, quick reference notes, the score) and the logger's (the spreadsheet and the wall clock). | Offline (written locally, synced later, conflicts per field); synced to the recorder; a take aborted; two people on different views. | #51 #58, comment |
| Score marking | The producer's pencil on the score pane: issue marks and regions in categories on single keys, with the takes affected and the take that fixed them; T-edits (3T4, lead-in T3, chains, overdubs); take start and end; punch-ins; wrong-note crosses; circled dynamics; sticky notes; ink; the inspector; single, two-up and continuous layouts; filters (invert, sepia, amber, cyan, grey); go to page and bar; step through edit points; the edit plot check; swap the score keeping marks; exports (annotated PDF, marks CSV). | No marks; an edit plot with a broken chain. | #52 |
| Stage plan | Metre-scaled plans, one a venue or layout, with grid and snapping: performers and ensemble blocks sized from the head-count, microphones linked to the patch list (labelled by it), instruments and objects, risers, walls, cables, labels, label groups; an optional floor-plan underlay; marquee, align, rotate, resize, duplicate, undo and redo; a list of what is on the stage, as layers; export PDF (A3 or A4, rulers, scale bar). | No plan; an empty plan; no underlay. | #53 |
| Patch list | Stage boxes with input and output tables (source, device, cable or channel, notes), linked to microphones; exports (PDF, XLSX). | Empty. | #54 |
| Project import | Import a ControlRoom project (.croom): what will be created, counts per kind, conflicts, errors. | Nothing to import; conflicts. | #57 |

### 3.11 Organisation, settings and operations

| Screen | What it shows | States | Issues |
| --- | --- | --- | --- |
| Members | Members with organisation roles, pending invitations (resend, revoke), guests (name, email, label; revoke); invite. | Empty invitations; the last owner cannot be removed. | #24 #59 |
| Organisation settings | Name, defaults for reviewer permissions and tool access, comment categories, delivery profiles (what they ask of the sound, and of a video's picture: codec, size, frame rate, scan, colour, range), storage backend; switch organisation; for owners, an export of everything (records as JSON and every file, in one archive encrypted with age to a key shown once, kept a week, downloaded through a one-time link) and deleting the workspace (asked for by one owner, confirmed by a second typing its name, a sole owner a day later; then closed to everyone and purged after 30 days unless kept). | Validation; an export being made, ready, failed or removed; the key shown once; a deletion asked for and waiting for another owner. | #7 #42 #55 #186 |
| Branding | The workspace's logo (PNG, JPEG or WebP, drawn again at up to 512 pixels; replace, remove) and accent (a swatch and its hexadecimal, its contrast on the dark ground and the darker cut light themes show), with a preview in each theme. Shown on the sign-in page at the workspace's own address, on guest pages (the logo where Hekate's lockup would be, the accent in place of the signal) and in its email; Hekate's lockup stays in the app. | No logo; an accent too dark to read on the dark ground, refused saying how far short it falls. | #185 |
| Security | Sign-in policy: methods allowed, second factor required of nobody, owners and admins, or everyone (refused until the admin has one), security key required; SSO providers (OIDC, SAML: metadata, certificate, attribute and group-to-role mapping, enforce with break-glass); LDAP (server, TLS, bind, search, mapping, test connection). | SSO test failed; LDAP test failed; enforced. | #5 #37 #38 |
| Account | Name, email, a code app (set up with password, QR and key, a first code, then recovery codes shown once; removed with the password), passkeys and security keys (named, last used, revoke, up to five), recovery codes (how many unused; new ones replace them), sessions, notification preferences (instant or digest, per event, subscriptions). | A key added; limit reached. | #39, legacy |
| API tokens and connected apps | A member's own API tokens (scopes, expiry, last use, shown once; rename, change scopes, revoke) and the applications they connected to the workspace through OAuth, each with what it may do (in words, and scope by scope) and Disconnect; where developers register an application. | No tokens; no connected apps; a token shown once; what an app may do. | #198 #447 |
| API and OAuth clients | The workspace's OAuth clients (confidential with a secret, or public with PKCE; redirect addresses matched exactly; the scopes each may ask for; how many have it connected): register, edit, rotate the secret (shown once), who has connected, delete. Service tokens, the scopes, and the API log. | No clients; a client's id and secret shown once; who has connected; nobody yet. | #198 #447 |
| OAuth consent | An application a workspace registered asks a member for access: the application, the workspace, the scopes asked with what each allows, where the answer goes; Allow or Cancel; who is signed in. | Refused (an application not registered, or an address it did not register: shown, sent nowhere); signed out (sign in, then back). | #447 |
| Appearance and preferences | Theme (the brand in dark and light, Catppuccin, Dracula, Gruvbox, Rosé Pine, Osaka Jade, Kanagawa, Solarized), density (comfortable or compact, for every list), and which of the tools you are given are shown (spectrogram, split channels, loudness monitoring, metadata editor). | Default. | comment |
| Instance: tenants | For the instance admin: organisations with members, projects, storage and state; create, suspend, usage; instance settings (registration, defaults, limits). | One tenant; many; suspended. | #3, comment |
| Instance: status page | In the instance's Support section, for every operator whatever the support module says: the open incidents and the latest resolved, Post an incident (title, what it touches, how badly, where it stands, the first update, and when it began for one posted after the fact), an incident's updates through to Resolve, Remove, and where the help menu links (this instance's page, or another address). The desk's tile says whether anything is open; the help menu shows the status and marks an open incident; the Support page lists each open incident before a ticket is written. | Nothing posted; an incident open; linked elsewhere. | #182 #183 |
| Workspace suspended | For a member whose workspace the operators suspended: the reason, their other workspaces, sign out. | With other workspaces; without. | #174 |
| Workspace being deleted | For a member whose workspace its owners are deleting: the day it goes; for its owners, Keep it and its export. | An export ready; being made; none. | #186 |
| Notifications and integrations | An event system with channels out of the box: SMTP, SparkPost, Resend, Mailgun, SendGrid, Postal, Google Workspace, Microsoft 365, Slack, Discord, Microsoft Teams and a generic webhook (signed, its secret shown once), each with its fields and a test; which events go where; API keys; an MCP endpoint. | Test failed; a channel paused after failures; log-only in development. | #59 #71, comment |
| Transfers | Projects moving in from, or out to, another workspace: what each waits for (a second member's approval, the other workspace's acceptance), Withdraw, Refuse, Approve and Accept, each confirmed with the project's name and a password; those settled (moved, refused, withdrawn, lapsed); the workspace's address, for someone moving a project here. | Nothing waiting; a move waiting on this workspace. | #240 |
| Storage | Backends (local disk, S3-compatible), default for new objects, usage per project, reconciliation (last run, orphaned, removed, missing bytes needing a person; report only). | Missing bytes found. | #7 #67 |
| Leak tracing | Forensic marking on streams and downloads; upload a suspected leak; the matching access or "no mark found". | Match; no match; scanning. | #32 |
| Access log | Every key issue, stream, page render, download, guest sign-in, decision and export, with person, review, address and agent; filters by project, file, review, person, action, time; CSV export. | Empty; long. | #30 |
| Operations | Connected, version, worker on or off, queue depth, encryption and key rotation state, Prometheus endpoint, backups and upgrade notes. | Worker off; key rotation pending. | #4 #9 #17 #28 #62 #70 |

## 4. From Hekate-Legacy

What the tool you use today has, checked against this inventory. Folded in above: the dashboard's "waiting on you", advanced and saved searches, configurable file columns, tags, pins, favourites and viewed state, bulk actions, project archive and templates, drawing tools and shuttle on video, mattes and safe areas, mentions, to-dos and attachments on comments, comment import in the DAW and NLE formats, printable comments, notification digests and subscriptions, per-file history, a guest filtered to one reviewer's comments, the reviewer capabilities (comments: full, own threads, read-only, none; download; versions; navigate), approval quorum ("a percentage of reviewers"), reminders and the completion summary, the review report with first access and submitted times.

Checked against your comments:

| Legacy feature | What it does | Proposed |
| --- | --- | --- |
| Share links outside a review | A link per file or folder with password, expiry, view limit, download hidden, comments allowed, versions accessible, relink to latest; per-recipient stats. | In: a share kind beside approval and feedback, on the same system (3.8). |
| Upload requests | An inbound link into a folder for outsiders to upload, with a limit and expiry. | In: upload requests (3.3). |
| Tasks | Tasks with assignee, priority, status, deadline, related files and deliverables, created from a comment. | In: a task list in every project (3.3). |
| Trash and restore | Deleted files kept for a retention period, restorable, per project or all. | Out: backups and a restricted delete permission instead. |
| Synced sessions | A leader drives followers' playback over websockets (play, seek, file change). | In: listen together (3.4), over server-sent events. |
| Captions and transcripts | Caption tracks, transcription, transcript search, caption export (SRT, WebVTT, TTML). | In without transcription: caption tracks uploaded to a video or a recording, the Captions menu, the transcript with search, export in all three formats (3.5, #201). No speech-to-text. |
| Aliases and relationships | A shortcut to a file with its own comment thread; links between files, tasks and comments. | Out; tracks and reviews cover the use. |
| Encoding profiles and overlays | Admin-chosen H.264 profiles; burned-in overlays (title, timecode, date) at upload. | Out; renditions are fixed and the per-viewer watermark replaces burned-in overlays. |
| Branding | Custom logo and colours per instance and per user. | After 1.0, with multi-tenancy. Themes for people are in (Appearance). |
| Webhooks | Per-user and instance webhooks on file, comment, task and workflow events. | In: the event system with channels and a generic webhook (3.11). |
| Private files | A personal space outside projects. | Out. |

## 5. Rounds

Reviews and approvals are the core product and the utmost priority; everything else is designed, and the core is built fast.

- **Round one:** the shell and switcher, home, the reviews list, the review pages (approval, feedback, share, as a guest, the request form, reviewer permissions), the recording page (Review and QA) with the score, loops, comparison, takes and the comment thread, projects, files and the track, and every state of those.
- **Round two:** video, documents, the board and the workflow builder, triage and categories, carry-over and version comparison, exports, normalisation, members and groups.
- **Round three:** the production tools, organisation settings, security, mail, storage, watermarking, leak tracing, the access log, operations, and every remaining state.

## 6. Settled in round one

1. **Shadows:** yes, only for what floats, at the weight shadcn gives them. `docs/brand.md` to be amended.
2. **Spectrogram:** a view of the player on Review; QA is investigation (metrics, metadata, analysis) on the same player.
3. **Bars:** pages, bars and beats are core reference fields on comments, switchable off per project and track; nothing derives them from time and nothing shows them on the scrub bar; timecode is what the player deals in.
4. **Project views:** overview first, then files, board and workflow.
5. **ControlRoom's hidden model:** surfaced, as the live take log above sets out.
6. **Legacy features:** settled per row in section 4.
7. **Also from your comments:** an instance admin and tenants; a full installer; configurable guest verification; per-track delivery profiles; asset security with audio marking; upload workflow checks; replace a version; a triage view; blind A/B in comparison; takes shared by selection, by passage or by exclusion; personal preferences and themes; the event system with channels, an API and an MCP endpoint.
