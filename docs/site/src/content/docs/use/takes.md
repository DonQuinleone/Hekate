---
title: Sessions and takes
description: Recording sessions, the takes made in them, and importing a day's files.
---

In a music project, **takes** are the snippets recorded for a track: reference material for producers and editors, never versions of it. A take belongs to its track; it can also say which **session** (a day or a sitting) it was recorded in. Sessions live in the project's **Production** area, shown to the roles that may see takes.

## Importing a day's takes

Choose **Import takes** on the project's sessions and drop every file of the day, or a folder of them. Nothing is uploaded yet: only each file's header is read, and Hekate proposes how they fit together.

- **Takes** are grouped by their take number (from the files' iXML, or their names) or, without one, by starting at the same timecode, as a recorder writes one file per microphone.
- **The mix** a take is heard by is the file named so (Mix, Sum, LR, Stereo) or the one stereo file among mono microphones. Where none stands out, choose it.
- **Sessions** follow the day the files were recorded, else the recorder's tape, else their folder. A day that already has a session adds to it.
- **Tracks** are matched by name: the scene, the description or the folder against the project's track names, with how sure the match is.

Correct anything before importing: a take's track or mix, a session's name, or a selection of takes put on a track or left out. **Undo** steps back through the corrections. Files that cannot be placed are listed with the reason.

When the files carry no iXML, a **file-name pattern** says where the take number and the rest are: `T{take} {mic}` reads `T27_Spot.wav` as take 27 on the Spot microphone. It can name `{take}`, `{mic}`, `{tc}` (timecode), `{scene}`, `{session}` and `{track}`, and `*` matches anything.

**Import** uploads each take's mix into its track's folder and makes it the track's next take, in its session. If an import stops part way, import the same files again: the takes already made are shown as *Already imported* and skipped. For now a take brings its mix only; its other microphones follow later.
