---
title: Captions and transcripts
description: Adding caption tracks to a video or a recording, reading them as a transcript, searching and exporting them.
---

A video or a recording can carry **caption tracks**: timed text from a sidecar file in SubRip (`.srt`), WebVTT (`.vtt`) or TTML (`.ttml`, `.dfxp`). A file can carry up to twelve, each at most 2 MB, for example English subtitles, English captions for the deaf and hard of hearing, and a French translation.

Hekate does not transcribe speech itself. If you transcribe elsewhere, add the result as a track.

## Adding a track

Open the file's **Details**, choose **Add captions…** and pick the sidecar. Then say:

- **Language:** read from the file where it says (WebVTT's `Language:` header, TTML's `xml:lang`, or a tag in its name such as `Titles.fr.vtt`); choose another, or *Not said*.
- **For:** **Subtitles** (the words, for viewers who hear them) or **Captions (SDH)** (the words and the sounds, for viewers who are deaf or hard of hearing). A name containing `.sdh.` or `.cc.` chooses captions.
- **Name in the Captions menu:** follows the language and kind ("French (SDH)") until you type your own.

Anyone whose role may upload adds tracks, and renames or removes them from each track's **…** menu. A file that cannot be read is refused with the reason, such as the timing it could not read.

## Watching with captions

The player's **Captions** menu turns a track on, one at a time. On a video the words sit low in the picture; on a recording, under the waveform. Screen readers announce each line as it changes.

## The transcript

Where a file has a track, the panel beside the player switches between **Comments** and **Transcript**. The transcript lists the track the player shows (choose another in the panel), with each line's time:

- The line being said is marked and kept in view as the file plays. Scroll the list to read ahead; **Follow playback** brings it back.
- Click a line to go to that moment.
- **Search** (the magnifier) finds a phrase whatever its case and accents, marks each match and counts them.

## Exporting

Anyone who may download from the file (at either level, or through a review that allows downloads) can export a track as SubRip, WebVTT or TTML, whichever format it came in: from the transcript's download button or the track's menu in Details. The file is named as players look for it beside the video, such as `Opening titles - Cut 3.fr.sdh.vtt`. Each export is in the access log.

Only what is said and when is exported: positions, styles and voices in the original file are not kept.
