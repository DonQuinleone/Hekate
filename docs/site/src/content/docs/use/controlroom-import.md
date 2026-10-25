---
title: Importing from ControlRoom
description: Bringing a ControlRoom project file (.croom) into a Hekate project, previewed before anything changes.
---

A ControlRoom project file (`.croom`) can be brought into a Hekate project: its repertoire, venues, personnel, schedule, sessions and take log, score marks, stage plans, stage boxes and embedded score PDFs become the project's own.

:::caution[Provisional]
The import reads ControlRoom's format as far as it is known. Until it has been checked against real project files, look over the preview, and its list of what is not brought over, before importing.
:::

## Importing a project

1. In the project, open **Production**, then **Import**. It is there for those who may manage the project: workspace owners and admins, and roles that may edit the project's settings.
2. Choose the `.croom` file, or drop it on the page. It can be up to 200 MB.
3. Hekate reads it and shows what it will create, kind by kind, with a few names of each. **Nothing changes yet.**
4. Choose **Import**.

The file is read and set aside again for each step; Hekate keeps nothing of it but what the import writes. The import is all or nothing: if anything fails, the project is left as it was.

## What becomes what

| In ControlRoom | In Hekate |
| --- | --- |
| A piece | A work in the repertoire |
| Its movements | The work's tracks, in order, numbered as the score prints them (Hekate has no movements) |
| A piece without movements | A work of one track |
| An embedded score PDF | A document in the project, stored encrypted like any upload, and the work's score |
| Sessions and takes | Sessions, and takes on their tracks with ratings, notes, false starts, timecode and bars |
| Score annotations and take edits | Score marks on the track, edit points with their hand-overs |
| Categories | Score issue categories |
| Personnel, venues and the schedule | The same, in Production |
| Stage plans, their elements and stage boxes | Stage plans with what stands on them, and the patch list, a microphone linked to the channel it is plugged into |

Undone steps in the file are never imported, and neither is ControlRoom's own window layout.

## When the project already has some of it

A work, venue, person, stage plan, stage box or issue category with the same name as one in the project is listed as already there. Choose:

- **Merge into what is there** (the default): the project's own is kept. A work gains the tracks it lacks, a stage box the channels it lacks. Takes whose number the track already has are left out, as is what stands on a stage plan the project already has.
- **Import beside it**: a second one is made. Venues, stage plans and stage boxes, whose names must differ, are named "Endless Hall (2)".

## What is not brought over

Below the counts, the preview lists anything it could not use: entries Hekate would refuse (a take of no piece, a mark with no page, a take number already taken), and, under **Not brought over**, parts of the file it does not understand. Each is counted, so nothing is dropped without saying so. The same list comes back once the import is done.

The import is in the project's access log, and each score it brings is logged as an upload.
