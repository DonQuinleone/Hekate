---
title: Reviews and comments
description: Asking for approval or feedback, and commenting on an exact place in the media.
---

A **review** asks people to look at files: a track's version, a cut, a score. It is one of two kinds.

- **Approval:** each reviewer records a decision, *Approved* or *Changes requested*, and every decision is logged.
- **Feedback:** comments only, with no formal sign-off.

Reviewers can be members of the workspace, **guests** from outside it (who need no account), or **groups**. They can be asked all at once or in order, each step starting when the one before it is decided.

## Comments

Every comment belongs to a file, and most point at a place in it:

- a **time** in audio or video: a moment, a range, or a frame;
- a **region** of a page or a frame: drag a box over the bar, the shot or the line;
- a **bar** in a score: a bar and beat, or a range of bars.

Clicking a comment takes the player or the page to its place. Replies keep a conversation together, and a comment can be resolved when it is dealt with. When a new version arrives, open comments can be carried across to it.

## Exporting comments to an editing system

Editors can take a file's comments into the application they edit in, as markers. Open the file, choose **Export comments…** from its **…** menu, and pick the application. People who can triage feedback (engineers and editors, by default) can export, and every export is written to the access log.

| Application | What Hekate writes |
| --- | --- |
| Pro Tools | A MIDI file with a marker for each thread |
| Nuendo | A CSV marker list (File, Import, CSV Marker) |
| Reaper | A region and marker list (Region/Marker Manager, Import) |
| DaVinci Resolve | A marker EDL (Timelines, Import, Timeline Markers from EDL) |
| Final Cut Pro | An FCPXML project with a to-do marker for each thread, done where it is resolved |
| Premiere Pro | A Final Cut 7 XML sequence carrying the markers |
| Avid Media Composer | A marker text file (Markers window, Import Markers) |
| CSV, plain text | Every thread, with its place, author, status and replies |

Open threads are exported unless you choose all of them, and replies can follow their thread. Times are timecode from 00:00:00:00 or, as most editing timelines start, from 01:00:00:00, at the video's own frame rate or one you choose; a spreadsheet can take seconds or samples instead. A marker's name says who wrote the comment and, where one was named, the bar. Comments with no time (on a page, or on the whole file) only fit a CSV or plain text, and the dialog says how many a marker list leaves out. Choose Latin-1 for older systems that cannot read UTF-8.

## Playing media

Audio and video play through Hekate's own player, as encrypted segments decrypted in the browser for that session alone. The space bar or K plays and pauses, J and L step back and forward, I and O set a loop, and C starts a comment at the playhead; press ? on any page for every shortcut there.
