# Domain model

The words in this document are used exactly as defined, in code, in the interface and in conversation. If a term is not here, add it before using it.

## Glossary

| Term | Meaning |
| --- | --- |
| **Organisation** | The tenant. Owns members, guests, projects and storage. |
| **Project** | The overall unit of work, for example an album, a film or a campaign. Contains folders, files, tracks and takes. A project's profile (Music, Video, General) only decides which tools appear; any kind of file can live in any project. |
| **Folder** | Organises files inside a project. Folders nest. |
| **File** | One uploaded object: audio, video, a PDF score, cover artwork, a document. Files are immutable; a changed file is a new file. |
| **Track** | A piece of music in review, for example *Maple Tree Rag*. A track groups the files that relate to that piece. A track has versions. |
| **Version** | One edit of a track, numbered in order (Version 1 to Version 5). A new edit is a new version, never a replacement file. |
| **Variation** | One file within a version that differs in treatment, not in edit: for example the dry mix and the wet mix of Version 4. Every version has at least one variation, and one is primary. |
| **Take** | A snippet of audio captured in the recording session, usually not a complete run of the music. Takes are reference material for the producer and editor: they show what is available for each passage and what has been stitched into the edit. A take groups its files: one per microphone, plus an optional summed mix. Takes are **not** versions and do not normally appear in review. |
| **Session** | A recording session, grouping takes (for example "Day 2 · St John's"). |
| **Comment** | A note on a file, optionally anchored to a place in it. Comments can be threaded and resolved. |
| **Category** | A configurable label on a comment, such as *Noise*, *Edit*, *Balance*, *Performance*. A category can carry a default handling, for example *Noise* defers the comment to a later stage. Categories are defined per project. |
| **Deferred** | A comment set aside for a later stage of the workflow (typically noise, handled at the end). It stays open and reappears when that stage starts. |
| **Carry-over** | Linking a comment raised on one version to the version where it was addressed, with the anchor mapped across, so the reviewer can hear or see a before and after. |
| **Anchor** | Where a comment points: a time range or frame (`time`), a rectangle on a page or frame (`region`), or a bar and beat or range of bars (`bar`). A comment without an anchor is about the whole file. |
| **Review** | One request, made by someone with the authority, for one or more people to look at one or more items (tracks, versions, files). A review is either an approval or feedback. |
| **Approval** | A review that ends in a formal, logged decision from each reviewer: **Approved** or **Changes requested**. |
| **Feedback** | A review that collects comments with no formal sign-off. It ends when reviewers submit their feedback. |
| **Reviewer** | A person asked to take part in a review: a member or a guest. |
| **Guest** | An external reviewer without an account (a conductor, a soloist, a composer). Guests reach material through signed links scoped to the reviews they are part of. |
| **Group** | A named set of reviewers in a project, for example "Soloists". A review can be sent to groups as well as individuals. |
| **Workflow** | A configurable sequence of stages, statuses and transitions, defined per project and overridable per track. Built in a Jira-style workflow builder. |
| **Stage** | A step in a workflow: an approval, a feedback round or a task (triage, editing). Stages have participants and run when their conditions are met. |
| **Status** | Where a track (or other item) stands in its workflow, for example *Editing*, *With conductor*, *Triage*, *Approved*. Statuses are defined by the workflow, not fixed by Hekate. |
| **Role** | A named set of permissions within a project, for example Producer, Engineer, Editor, Reviewer. Roles and their permissions are configurable per project. |

Terms deliberately **not** used: *movement* (a track is the unit), *asset* (say file, track or version), *take* for anything other than a recording-session snippet.

## Content

```
Organisation
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
- Video and general projects use the same tracks, versions and variations model. Only the interface labels change by profile (to be confirmed: see open questions).

## Listening and viewing

A track does not need a score. The **waveform is the primary surface** for audio; the score view is an extra pane when a score is linked and synced. Video uses the frame with a filmstrip and waveform.

Tools for engineers and producers, all working on the protected streams (`docs/security.md`):

- Waveform with zoom down to sample level, markers and loop regions
- Spectrogram, side by side with or overlaid on the waveform, coloured like iZotope RX by default (the *Cyan to orange* map shared with Argus). Every view setting is configurable and saved per user, with named presets: colour map (Cyan to orange, Inferno, Greyscale, Signal), frequency scale (linear, log, mel, Bark), window (Hann, Hamming, Blackman-Harris, Kaiser), FFT size, overlap, time and frequency resolution balance, amplitude range (floor and ceiling in dB), frequency range, and channel (left, right, mid, side, or each channel)
- Level metering: peak, RMS, true peak and integrated loudness (LUFS), per channel, with loudness history
- Phase correlation and stereo field (goniometer)
- **Loops:** drag a loop region on the waveform, loop a comment's anchor or a bar range in one action, nudge the in and out points, and keep the loop while switching variation or version
- **Quick comparison:** one key flips between variations (dry and wet mix) or versions at the same musical position, gapless and level-matched; pin up to four sources to number keys; blind mode hides which is which
- **QA by Argus:** every uploaded audio file is analysed by the Argus engine (dropouts, clicks, clipping, true peak and loudness against a delivery profile, phase, spectral cut-offs, metadata). Findings appear as markers on the waveform and spectrogram, in a QA tab beside the comments, and in an exportable QA report. A finding can be turned into a comment with one action
- Compare versions at the same musical position, using the version alignment below
- Solo and mute channels for multichannel files and takes

Analysis data (peaks, spectrogram tiles, loudness) is computed by the media worker, so the browser never needs the full-quality audio to draw it.

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

## Reviews

A review is created by someone whose role allows it. It names:

- **Items:** one or more tracks (a specific version, or the latest), and/or files.
- **Kind:** approval or feedback.
- **Reviewers:** members, guests and groups.
- **Order:** all at once, or in sequence (each reviewer or group starts when the previous one finishes).
- **Rule** (approvals only): everyone must approve, or any one approval is enough. Any *Changes requested* decision is logged regardless.
- **Due date** and a message.

Each reviewer's participation has its own state (invited, viewed, in progress, submitted) and, for approvals, a decision with a timestamp. Decisions are append-only: a later decision supersedes an earlier one but never erases it.

## Workflows

A workflow is a directed graph of **stages** plus a set of **statuses**.

- **Stage kinds:** `approval`, `feedback`, or `task` (a human step such as "Producer triages feedback" or "Engineer edits").
- **Start conditions:** a stage starts when the stages it depends on reach a given outcome. Examples: conductor round 2 starts after conductor round 1 is submitted; the accompanist round starts only after the composer's feedback.
- **Participants:** members, guests, groups or roles.
- **Transitions:** on completion (or on a specific outcome such as *Changes requested*), the item moves to a status and optionally starts other stages.
- **Notifications:** on entering a stage or status, notify roles or people (the engineer when edits are needed, the producer when feedback needs triage).
- **Scope:** a project has a default workflow; a track can override it. A new version can restart the workflow from a chosen stage.

Example, a choral album:

1. Feedback · Conductor, round 1
2. Task · Producer triages, then Engineer edits
3. Feedback · Conductor, round 2
4. Approval · Composer
5. Approval · Accompanist (after the composer)
6. Feedback · Soloist and Cellist (in parallel with 4 and 5)
7. Status *Approved* when 4 and 5 approve

## Access

Per-project roles carry permissions. Defaults ship with every project and can be edited:

| Permission | Producer | Engineer | Editor | Reviewer | Viewer |
| --- | :-: | :-: | :-: | :-: | :-: |
| View files and tracks | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upload files, versions, takes | ✓ | ✓ | ✓ | | |
| Organise folders and tracks | ✓ | ✓ | ✓ | | |
| Comment | ✓ | ✓ | ✓ | ✓ | |
| Request reviews | ✓ | | | | |
| Add or remove reviewers and guests | ✓ | | | | |
| Triage feedback (resolve, assign) | ✓ | ✓ | ✓ | | |
| Record an approval decision | ✓ | | | ✓ | |
| Edit workflows | ✓ | | | | |
| Manage roles and members | ✓ | | | | |

Organisation owners and admins can do everything in every project. Guests have no role: they can see and act only on the items in the reviews they are invited to.

## Open questions

1. (Answered) Carry-over: toggle per comment on each new version, with a status.
2. (Answered) Security keys: five per account is a default the operator can raise, not a maximum.
3. Do video and general projects use tracks, versions and variations under different names (for example *Cut* for video, *Item* for general), or should video have its own term?
4. Do takes need anything beyond grouping and playback for now: for example marking which takes were used in which version, or bar ranges per take?
5. Should guests be able to see each other's comments within a review, or only their own and the team's replies?
