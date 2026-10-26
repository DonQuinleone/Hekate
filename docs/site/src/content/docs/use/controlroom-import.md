---
title: Importing from ControlRoom
description: Bringing a ControlRoom project file (.croom) into a Hekate project, previewed before anything changes.
---

A ControlRoom project file (`.croom`) can be brought into a Hekate project: its repertoire and scores, venues, personnel, schedule, take log and to-dos, score marks, stage plans, stage boxes and attached files become the project's own.

The import reads the file as ControlRoom itself does when it opens one: the project as it stands, never what was undone, and the same names for everything. It reads files of ControlRoom's schema 1, the only one ControlRoom writes.

## Importing a project

1. In the project, open **Production**, then **Import**. It is there for those who may manage the project: workspace owners and admins, and roles that may edit the project's settings.
2. Choose the `.croom` file, or drop it on the page. It can be up to 200 MB.
3. Hekate reads it and shows what it will create, kind by kind, with a few names of each. **Nothing changes yet.**
4. Choose **Import**.

The file is read and set aside again for each step; Hekate keeps nothing of it but what the import writes. The import is all or nothing: if anything fails, the project is left as it was.

## What becomes what

| In ControlRoom | In Hekate |
| --- | --- |
| A work in the repertoire | A work |
| Its movements | The work's tracks, in order, numbered as the score prints them, with their printed pages (Hekate has no movements) |
| A work without movements | A work of one track |
| An embedded score PDF | A document in the project, stored encrypted like any upload, and the work's score, with its page offset |
| A score no work in the repertoire covers, with marks or takes on it | A work of its own, named after the file |
| The session (the whole file) | One session, named after it, with the session notes, and numbered per track where each score kept its own take numbers |
| The take log | Takes on the tracks they were recorded under, with their ratings, notes, false starts, timecode in and out, aborted takes marked so |
| Takes recorded under no work and no score | Takes on a track made for them, named after the session |
| To-dos | The session's to-dos, in the same order |
| Marks on a score | Score marks on the track whose printed pages they are on: issues and regions with the takes they occurred in and the take that fixed them, T-edits as edit points (a chain such as 3T4T5 is an edit point for each hand-over), overdubs, punch-ins, take starts and ends, wrong notes, circled dynamics, sticky notes and ink |
| Mark categories | Score mark categories, the ones the marks use, in the nearest of Hekate's colours |
| Personnel | Personnel: artists, staff, ensembles with their sections and named players, and others; the session agreement and headphones carried over. The session's conductor, producer and engineer are added where the personnel does not name them |
| Venues | Venues |
| The schedule | Schedule days and their rows: repertoire slots, breaks, get-ins and venue changes, ticked off where they were |
| Stage boxes | Stage boxes and their patch list |
| Stage plans | Stage plans of the same size, with what stands on them (a microphone linked to the channel it is plugged into, a performer or ensemble to the personnel), and the floor-plan underlay under the stage |
| Attached files | Files in the project, stored encrypted like any upload |

Undone steps in the file are never imported, and neither is ControlRoom's own window layout or the page it had open.

## When the project already has some of it

A work, venue, person, stage plan, stage box or issue category with the same name as one in the project is listed as already there. Choose:

- **Merge into what is there** (the default): the project's own is kept. A work gains the tracks it lacks, a stage box the channels it lacks. Takes whose number the track already has are left out, as is what stands on a stage plan the project already has.
- **Import beside it**: a second one is made. Venues, stage plans and stage boxes, whose names must differ, are named "Endless Hall (2)".

## What is not brought over

Below the counts, the preview lists anything it could not use: entries Hekate would refuse (a take number already taken, a sticky note with nothing written on it), and, under **Not brought over**, what the file holds that Hekate has no place for, each counted, so nothing is dropped without saying so. That includes:

- ControlRoom's own window layouts, and the score, page and zoom it had open.
- The letterhead, front page and author of ControlRoom's exports, and the paper a stage plan is exported on.
- The session's personal notes, which ControlRoom never prints: the import does not share them with the project.
- The keys that place a mark of each category (Hekate's are 1 to 9), and categories no mark uses (ControlRoom adds six to every project).
- A movement's own forces and abbreviation, which player of a section sits in which division (the section keeps how it divides), a stage element's own colour, and a plan's link to its venue.

A file written by a newer ControlRoom may hold events or fields this import does not know: they are listed too, and where one may have changed how the file's entries refer to each other, the preview says to look it over before importing.

The same list comes back once the import is done. The import is in the project's access log, and each file it brings is logged as an upload.
