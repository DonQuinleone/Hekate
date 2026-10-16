# Domain model

The words in this document are used exactly as defined, in code, in the interface and in conversation. If a term is not here, add it before using it.

## Glossary

| Term | Meaning |
| --- | --- |
| **Workspace** | The tenant, called *organisation* in code and the API. Owns members, guests, projects and storage. |
| **Instance** | One install of Hekate, run by its **operators**. Holds one workspace or many. |
| **Operator** | An account that runs the instance: workspaces, health, logs, support. Never acts inside a workspace's content as someone else. |
| **Project** | The overall unit of work, for example an album, a film or a campaign. Contains folders, files, tracks and takes. A project's profile (Music, Video, General) only decides which tools appear; any kind of file can live in any project. |
| **Folder** | Organises files inside a project. Folders nest. |
| **File** | One uploaded object: audio, video, a PDF score, cover artwork, a document. Files are immutable; a changed file is a new file. |
| **Track** | A piece of music in review, for example *Maple Tree Rag*. A track groups the files that relate to that piece. A track has versions. |
| **Version** | One edit of a track, numbered in order (Version 1 to Version 5). A new edit is a new version, never a replacement file. |
| **Variation** | One file within a version that differs in treatment, not in edit: for example the dry mix and the wet mix of Version 4. Every version has at least one variation, and one is primary. |
| **Take** | A snippet of audio captured in the recording session, usually not a complete run of the music. Takes are reference material for the producer and editor: they show what is available for each passage and what has been stitched into the edit. A take groups its files: one per microphone, plus an optional summed mix. Takes are **not** versions and do not normally appear in review. |
| **Session** | A recording session, grouping takes (for example "Day 2 · St John's"). |
| **Deliverable** | The video equivalent of a track: something delivered and reviewed, such as "Trailer 60s" or "Episode 3". A deliverable has versions (cuts), and each version has renditions. |
| **Rendition** | One file within a video version that differs in format or treatment: 16:9 or 9:16, subtitled or clean, graded or ungraded. One is primary. |
| **Edit decision** | Which takes a version uses for which bars or time ranges, optionally imported from the editor's edit decision list (EDL). |
| **Reviewer permissions** | What one reviewer may see and do in one review: versions, comments, tools, downloads, expiry, view limits and which items. |
| **Work** | An entry in a project's repertoire: title, composer, forces, abbreviation, and its tracks in order. A single-track work is just one track. Used by the schedule, the take log and the score. |
| **Score mark** | A producer's mark on a score page made during recording: an issue (with the takes it occurred in and the take that fixed it), a T-edit such as `3T4`, a take start or end, a punch-in, a wrong-note cross, a circled dynamic, a sticky note, or freehand ink. |
| **Edit plot** | The chain of T-edits through a track, from lead-in to final take. Hekate checks that every hand-over matches and every take exists. |
| **Schedule** | The project's timetable: days, repertoire slots, breaks and venue changes, with times that chain automatically. |
| **Personnel** | Everyone on a production: artists, ensembles (sections, named members, divisi), staff and others, with session-agreement and headphone flags. Personnel can be linked to members and guests. |
| **Venue** | A place a project records in, with its address. |
| **Stage plan** | A metre-scaled plan of a venue's stage: performers, ensemble blocks, microphones, instruments, risers, cables and walls, over an optional floor-plan underlay. |
| **Patch list** | The stage boxes of a project and the input and output channel tables of each, linked to the microphones on the stage plan. |
| **Coverage** | The page and bar range of the score that a take, or a set of takes, contains. Used to answer "which takes cover bar 72?". |
| **Comment** | A note on a file, optionally anchored to a place in it. Comments can be threaded and resolved. |
| **Category** | A configurable label on a comment, such as *Noise*, *Edit*, *Balance*, *Performance*. A category can carry a default handling, for example *Noise* defers the comment to a later stage. Categories are defined per project. |
| **Deferred** | A comment set aside for a later stage of the workflow (typically noise, handled at the end). It stays open and reappears when that stage starts. |
| **Carry-over** | Linking a comment raised on one version to the version where it was addressed, with the anchor mapped across, so the reviewer can hear or see a before and after. Whoever adds a version confirms or corrects it: each open thread is carried, carried but hidden, or settled as the version lands. |
| **Version checks** | What a project asks of a new version before it lands: a true peak under the delivery profile's ceiling, an edit decision list. A producer can let a refused version through, on the record. |
| **Anchor** | Where a comment points: a time range or frame (`time`), a rectangle on a page or frame (`region`), or a bar and beat or range of bars (`bar`). A comment without an anchor is about the whole file. |
| **Review** | One request, made by someone with the authority, for one or more people to look at one or more items (tracks, versions, files). A review is either an approval or feedback. |
| **Approval** | A review that ends in a formal, logged decision from each reviewer: **Approved** or **Changes requested**. |
| **Feedback** | A review that collects comments with no formal sign-off. It ends when reviewers submit their feedback. |
| **Reviewer** | A person asked to take part in a review: a member or a guest. |
| **Guest** | An external reviewer without an account (a conductor, a soloist, a composer). Guests reach material through signed links scoped to the reviews they are part of. |
| **Group** | A named set of reviewers in a project, for example "Soloists". A review can be sent to groups as well as individuals. |
| **Workflow** | A graph of nodes and connectors, defined per project and overridable per track (decision 040). Built in the workflow builder; readable and writable as YAML. |
| **Node** | A step of a workflow: an **event** (something happens) or an **action** (something is done), each with named **outcomes**. |
| **Connector** | Wires a node's outcome to the next node, optionally with a **condition**; one that runs back is a loop and needs an "until". |
| **Stage** | A step in a workflow: an approval, a feedback round or a task (triage, editing). Stages have participants and run when their conditions are met. |
| **Status** | Where a track (or other item) stands in its workflow, for example *Editing*, *With conductor*, *Triage*, *Approved*. Statuses are defined by the workflow, not fixed by Hekate. |
| **Role** | A named set of permissions within a project, for example Producer, Engineer, Editor, Reviewer. Roles and their permissions are configurable per project. |
| **Ticket** | A question to the people who run the instance, from a workspace: a thread with a generated reference, a type and a severity limited by the plan. Only with the support module. |
| **Plan** | What a workspace pays for and is given: limits, features and the support severities it unlocks. Only with the billing module. |
| **Notification** | Something that happened, told to one member: a review asked of them, a decision on a review they asked for, a reply, a mention (`@` and their full name), a new version of a track they follow, a failed upload, a guest opening their review. Each kind reaches them in the app, by mail (at once or in a digest), or both, as they choose; reviews asked of them and mentions always reach them in the app. Guests are told by mail only. |
| **Follow** | Being told about a track or a review beyond your own part in it. Making a track or adding a version to it follows it. |
| **Error reference** | A short code (`HK-7F3A-2C`) shown with an error, by which an operator finds what happened. |

Terms deliberately **not** used: *movement* (a track is the unit), *asset* (say file, track or version), *take* for anything other than a recording-session snippet.

## Content

```
Workspace (organisation)
└── Project (profile: music | video | general)
    ├── Folder (nested)
    │   └── File
    ├── Track
    │   └── Version (1, 2, 3 …)
    │       └── Variation → File (dry mix, wet mix …; one primary)
    └── Session
        └── Take (Take 1 … Take 70)
            └── File (one per microphone, plus a summed mix)
```

- Files are the only thing stored. Tracks, versions, variations and takes organise files; they never copy them.
- A file can be a variation of exactly one version, part of exactly one take, or neither (a loose file in a folder such as cover artwork or a score PDF).
- A track can link a score file, used for bar anchors and the score view.
- Video projects use **deliverables** instead of tracks: a deliverable has versions (cuts) and each version has **renditions** (16:9, 9:16, subtitled, graded). The structure parallels tracks but is its own concept with its own tools.
- General projects use folders and files, with simple version chains on files.

## Listening and viewing

A track does not need a score. The **waveform is the primary surface** for audio; the score view is an extra pane when a score is linked and synced. Video uses the frame with a filmstrip and waveform.

Tools for engineers and producers, all working on the protected streams (`docs/security.md`):

- Waveform with zoom down to sample level, markers and loop regions
- Spectrogram, side by side with or overlaid on the waveform, coloured like iZotope RX by default (the *Cyan to orange* map). Every view setting is configurable and saved per user, with named presets: colour map (Cyan to orange, Inferno, Greyscale, Signal), frequency scale (linear, log, mel, Bark), window (Hann, Hamming, Blackman-Harris, Kaiser), FFT size, overlap, time and frequency resolution balance, amplitude range (floor and ceiling in dB), frequency range, and channel (left, right, mid, side, or each channel)
- Level metering: peak, RMS, true peak and integrated loudness (LUFS), per channel, with loudness history
- Phase correlation and stereo field (goniometer)
- **Loops:** drag a loop region on the waveform, loop a comment's anchor or a bar range in one action, nudge the in and out points, and keep the loop while switching variation or version
- **Quick comparison:** one key flips between variations (dry and wet mix) or versions at the same musical position, gapless and level-matched; pin up to four sources to number keys; blind mode hides which is which
- **Built-in QA:** see below
- Compare versions at the same musical position, using the version alignment below
- Solo and mute channels for multichannel files and takes

Analysis data (peaks, spectrogram tiles, loudness) is computed by the media worker, so the browser never needs the full-quality audio to draw it.

## Take manager

A tool for producers and editors, mostly used while editing and before material goes to stakeholders. It can also be opened from a review.

**Import and automatic organisation.** At the end of a session or a project, drop in every audio file at once. Hekate proposes an organisation, which the user confirms or corrects before anything is saved:

- Reads Broadcast Wave and iXML metadata (scene, take, tape, track names, timecode, sample rate) and file names, with configurable name patterns
- Groups files into takes: files sharing a take number and overlapping timecode are one take; one file per microphone, and a file whose channel name or level suggests a mix becomes the take's summed mix
- Groups takes into sessions by date, tape or folder
- Assigns takes to tracks by matching their audio against the track's versions, and flags what it could not place

**Coverage.** Each take, or a set of takes, can carry score references: a page and bar range (for example *p. 7, bars 64–88*). References can be entered by hand, adjusted, or proposed automatically by aligning the take's audio against a synced version of the track.

**Questions it answers.** "Any other options for bar 72?" lists every take that covers bar 72, with the take's rating and notes, which take is used in the current version, and one action to audition each at bar 72, looped and level-matched. The same lookup appears on any bar-anchored comment ("Other takes for bar 72").

**Notes and ratings.** Takes can be rated, starred (the producer's circled takes) and annotated.

**Edit decisions.** A version can record which takes it uses for which bars, imported optionally from the editor's edit decision list (EDL). It is never compulsory by default; a project can turn on an upload rule (like branch protection) that requires an edit decision list with every new version.

## Production

Hekate runs the recording itself as well as its review, bringing the maintainer's ControlRoom tool into the product natively. Production data lives in the same project as tracks, takes and reviews, so nothing is entered twice.

**Repertoire and venues.** A project's works, each with its tracks in order, composer, forces, an abbreviation for schedules, and a link to the score file with each track's printed page range (so a track opens at its own pages even inside one long PDF; printed page numbers map to PDF pages through an offset). Venues with addresses.

**Personnel.** Artists, ensembles (sections of named members with divisi, or a head-count before names are known, plus seating notes), production staff and others. Each entry records whether the session agreement is signed and whether the person needs headphones. A personnel entry can be linked to a member or a guest, so the conductor on the stage plan is the same person who reviews in an approval.

**Schedule.** A spreadsheet-style planner across days: day headings with date and venue, repertoire slots (any combination of works and tracks), breaks, get-ins and mid-day venue changes. Start times chain from the previous row unless set. Rows are ticked off during the session so everyone can see where things are. A coverage view proves every track has a slot. Exports: a typeset PDF (front page with public session information, per-day tables, an ensemble breakdown page) and an XLSX workbook. The schedule can drive the workflow (for example, a track's first review starts the day after its last slot).

**Take logging.** A keyboard-first log used live in the control room:

- One key starts the next take; numbering runs continuously, per track, or synced to the recorder
- Rate 1 to 5, count false starts, type notes, record timecode in and out and wall-clock times, mark where on the score the take starts and ends
- Lifecycle per take: idle, armed, recording, recorded, aborted
- A large-print take overview and a status-coloured session clock readable across the room; a metronome and a tuning tone (415, 432, 440, 442 Hz) on any output
- Works offline: the log is written locally first and syncs when the connection returns, because venues often have poor connectivity

Logged takes become the take manager's takes, so import (#45) matches files to log entries and coverage (#46) starts from the logged score positions.

**Score marking.** The score pane gains the producer's pencil, on single keys: issue marks and regions in configurable categories (with the takes the problem occurred in and the take that fixed it), T-edits with lead-ins, chains and overdubs, take start and end marks, punch-ins, wrong-note crosses, circled dynamics, sticky notes and ink. Display filters (invert, sepia, amber, grey) suit a dark control room. Go to bar finds a printed bar number; edit points can be stepped through in reading order; the edit plot check verifies each track's T-edit chain. Score marks feed coverage directly: a mark that says take 7 fixed bar 72 answers "any other options for bar 72?". Exports: annotated score PDF, take log and marks as CSV.

**Stage plans and patching.** Metre-scaled plans on a snapping grid with performers, ensemble blocks sized from the real head-count, microphones, pianos, timpani, risers, walls, cable runs and labels, over an optional floor-plan underlay; multi-select, align and group operations. Microphones link to the patch list so labels follow it. Stage boxes carry input and output tables. Exports: stage plan PDF (A3 or A4, rulers and scale bar) and patch list PDF and XLSX.

**Everything is versioned.** Production data uses the same event history as the rest of a project, so every change can be undone and audited.

## Quality checks

QA is built into Hekate for audio and video. The media worker checks every upload against the project's **delivery profile** and records **findings**: a check, a severity (*pass*, *info*, *warn*, *fail*), a plain-English summary, the channel and time range where it applies, and the technical numbers.

Audio checks:

- Integrity and format: container, codec, bit depth, sample rate, channel layout (mono to surround and Atmos beds), duration, truncation, embedded metadata
- Loudness (integrated LUFS, LRA) and true peak (dBTP) against the profile's targets
- Clipping, including clipped-then-gained-down peaks below 0 dBFS
- Dropouts, clicks and discontinuities
- Silence, digital-zero gaps, DC offset, channel imbalance and dead channels
- Phase correlation and mono compatibility
- Spectral bandwidth and brick-wall cut-offs (upsampled or lossy-sourced material)

Video checks:

- Format conformance: codec, profile, resolution, frame rate, scan type, colour space and range, aspect ratio, audio layout
- Black frames, frozen frames, and dropped or duplicated frames
- Interlacing and combing artefacts
- Broadcast-safe luma and chroma levels
- Letterboxing and pillarboxing against the expected aspect
- Timecode continuity
- Photosensitive flashing risk
- Programme loudness and true peak of the audio, as above

Findings appear as markers on the waveform, spectrogram and timeline, in a QA tab beside the comments, and in an exportable QA report (PDF, CSV, JSON). One action turns a finding into a comment with a category. When a new version arrives, Hekate shows which findings were fixed and which are new. Delivery profiles (streaming, CD, Apple Digital Masters, surround, Atmos, broadcast, and a workspace's own) are chosen per file, track, project or workspace; the nearest choice applies, and without any, the one a file's channels suggest (decision 059). Each project sets how hard each check bites, switches the delivery checks on or off, and adds rules of its own (decision 060).

## Comments across versions

Comments are raised on one version and often addressed in a later one. Each comment thread keeps its origin and can be **carried over**:

- When a new version arrives, open comments from the previous version are offered against it, with their anchors mapped to the new version. Each one has a **Show on this version** toggle (on by default, configurable per project) and a status the editor or producer updates: *Open*, *Fixed in V5*, *Not fixed*, *Won't fix*.
- Mapping uses the score's bar positions when the track is synced; otherwise an automatic alignment between the two versions' audio (computed by the media worker), which the editor can correct.
- Whoever resolves a comment picks the version that addresses it. The thread then offers **before and after**: play the anchored passage from the original version, then the same passage in the resolving version, level-matched.
- A comment can be carried through several versions; its history shows each one.

## Categories and deferral

Comments can be given a category with one action, such as marking a comment as **Noise**. Categories are configurable per project, each with a default handling:

- **Normal:** stays in the current round.
- **Deferred to a stage:** leaves the current round's to-do list, stays open, and returns when the named workflow stage starts (for example *Noise reduction* at the end of the process).
- **Information only:** recorded, no action expected.

Triage (producer or whoever holds the permission) can change a comment's category, defer or undefer it, and assign it.

Every project starts with *Noise* (deferred to *Noise reduction*), *Edit*, *Balance*, *Performance* and *Information* (information only); whoever edits the project's workflows can rename, add and remove them. Until workflows exist, a deferred comment waits for a stage by its name and is undeferred by hand.

**The triage view** takes a version's open comments one at a time, in the order they play, with the passage looping: a number key gives the category, then *D* defers, *A* assigns, *R* resolves and *S* skips. Ticking several makes the next key act on all of them. It ends with what was decided and, for each person with comments assigned, a button that sends them their list.

## Reviews

### Reviewer permissions

Every reviewer in a review has their own permission set. Defaults are set per workspace and per project, and any reviewer can be adjusted individually:

- **Items:** which tracks, deliverables, versions and files they can open
- **History:** whether they can see previous versions, or only the one under review
- **Comments:** see all comments; or only their own and direct replies to them; or none but their own
- **Tools:** which tools are available (spectrogram, meters, score, compare, loops, QA)
- **Download:** none, proxy only, or original; always watermarked per recipient and logged
- **Access window:** start and expiry dates, and a maximum number of views or plays
- **Actions:** comment, record an approval decision, invite others

The same model applies to members in a review (their project role sets the ceiling) and to guests (the review sets it entirely).


A review is created by someone whose role allows it. It names:

- **Items:** one or more tracks (a specific version, or the latest), and/or files.
- **Kind:** approval or feedback.
- **Reviewers:** members, guests and groups.
- **Order:** all at once, or in sequence: a series of steps, each holding one or more reviewers or groups asked together, each starting when the one before finishes.
- **Rule** (approvals only): everyone must approve, any one approval is enough, or a share of them (a percentage, rounded up to whole people; changes are requested as soon as it can no longer be reached). Any *Changes requested* decision is logged regardless.
- **Title:** optional; a request without one is named after what it asks about ("Maple Leaf Rag and 2 more").
- **Reminder:** the day before it is due, unless the requester turns it off.
- **Due date** and a message.

Each reviewer's participation has its own state (invited, viewed, in progress, submitted) and, for approvals, a decision with a timestamp. Decisions are append-only: a later decision supersedes an earlier one but never erases it.

## Workflows

A workflow is a graph of **nodes** joined by **connectors** (decision 040), plus a set of **statuses**.

- **Events** are things that happen: a version arrives, an upload passes or fails its checks, a decision is recorded, feedback is submitted, a task is done, a due date passes, a production slot ends. An event can start a flow; it never ends one.
- **Actions** are things Hekate does or asks for: ask for an approval or for feedback (members, guests, groups or roles; all at once or in order; everyone or any one), assign a task (triage, editing), notify people or roles, set a status, wait, and finish. An action never starts a flow, always follows an outcome, and nothing follows a finish.
- **Outcomes** are the named ways a node ends: an approval ends *approved* or *changes requested*, a feedback round *submitted*, a task *done*, a check *passed* or *failed*.
- **Connectors** wire an outcome to the next node and may carry a **condition** (on the item, the decision or who made it). A connector that runs back to an earlier node is a **loop**, and needs a way out: an *until* (for example, until approved, or at most three rounds).
- **Groups** frame a stage on the canvas ("Conductor rounds"), so a long flow reads as a few steps.
- **Statuses** are where an item stands (*Editing*, *With conductor*, *Triage*, *Approved*), set by actions and shown on the board.
- **Scope:** a project's workflows share one canvas, each starting from its own event; a track can override them. A new version is itself an event, so a flow decides what happens when one arrives (for example, go back to the conductor's round).
- **Text:** every workflow can be read and written as YAML, so it can be stored, shared and reviewed.

Example, a choral album:

1. Event · a version arrives on a track
2. Action · ask the conductor for feedback; on *submitted*
3. Action · assign triage to the producer, then editing to the engineer; on *done*
4. Action · ask the conductor again, looping back to 3 until the conductor has nothing more (at most three rounds)
5. Action · ask the composer for approval, then the accompanist, in order; alongside, ask the soloist and cellist for feedback
6. On the composer's and accompanist's *approved*: set the status *Approved* and finish; on *changes requested*: back to 3

## Access

Per-project roles hold one level in each area of access; a level includes the ones before it. Defaults ship with every project and can be edited:

| Area | Levels | Producer | Engineer | Editor | Reviewer | Viewer |
| --- | --- | --- | --- | --- | --- | --- |
| Files | None, View, Upload, Organise, Delete | Delete | Organise | Organise | View | View |
| Comments | None, Read, Write, Triage | Triage | Triage | Triage | Write | Read |
| Reviews | None, Respond, Request, Manage | Manage | None | None | Respond | None |
| Downloads (marked and logged) | None, Proxy, Original | Original | Original | Original | None | None |
| Sessions and takes | None, View, Edit | Edit | Edit | Edit | View | View |
| Production tools | None, View, Edit | Edit | View | View | None | None |
| Workflow | None, View, Edit | Edit | View | View | View | View |
| Roles and people | None, View, Manage | Manage | View | View | View | View |
| Project (settings; archiving and deletion) | None, Edit, Delete | Delete | None | None | None | None |

Each level stands for permissions the server checks, so a role is still a set of permissions underneath (decision 058). View files is what makes the project visible at all; Respond is recording an approval decision, and Manage in reviews is adding and removing reviewers and guests; Organise is moving and renaming, Delete removing; Triage is categorising, deferring, assigning and resolving anyone's comments; in the project, Edit is its settings and Delete is archiving it (and deleting it, once that exists).

Workspace owners and admins can do everything in every project. Guests have no role: they can see and act only on the items in the reviews they are invited to.

## Settled questions

- Carry-over: a per-comment *Show on this version* toggle with a status.
- Hardware security keys: five per account is a default the operator can raise.
- Video: deliverables, versions and renditions, a separate concept from tracks.
- Guest visibility: governed by reviewer permissions, not a fixed rule.
- Commercial DRM: later; the delivery design leaves room for it.
- Edit decisions: optional EDL import; an optional project rule can require it on upload.
- ControlRoom projects: importable later.
- ControlRoom movements map to tracks within a work.
