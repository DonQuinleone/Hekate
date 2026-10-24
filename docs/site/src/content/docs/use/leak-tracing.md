---
title: Leak tracing
description: How every downloaded recording carries an inaudible mark for its recipient, and how an owner traces a leak back to them.
---

Every recording someone downloads from Hekate, original or proxy, carries an inaudible mark made for them alone. If a copy gets out, a workspace owner can upload it and Hekate names the download it came from: who, which file, when, and through which review.

## Forensic marking

- **Off until you turn it on.** Under *Workspace settings*, *Leak tracing*, the *Audio* switch marks recordings' downloads. Listen to a marked download of your quietest material before you rely on it. Only owners see it or change it, and each change is in the access log. With the billing module on, the workspace's plan must include *Forensic marking*.
- **What a download becomes.** A WAV or AIFF original stays WAV or AIFF, a FLAC stays FLAC, with the same sample rate, bit depth and channels and the same length; the only difference is the mark. Other originals (MP3, AAC and the like) leave as FLAC, decoded once and marked, so nothing more is lost. The proxy is AAC at 256 kb/s. The download dialog says which. A WAV original keeps every chunk of its own (Broadcast Wave, iXML, ADM), so an Atmos master stays one; other originals keep their tags.
- **What it is.** Small changes of level (5 per cent) between 400 Hz and 4.6 kHz, in a pattern that follows from the workspace's key and from nothing anyone outside can know. Each channel carries it, so a stereo or mono fold-down of a surround mix carries it too. Its audibility has been measured, not listened for: it stays more than 25 dB below the music. Listen to a marked download of your most exposed material (solo piano, a quiet passage) before relying on it, and turn it off if you hear it.
- **Not yet.** Streams, videos, pictures and pages carry the visible watermark only; the *Video* and *Pages* switches say so.

## Tracing a leak

1. Open *Workspace settings*, *Leak tracing*.
2. Drop the file under *Trace a leak*, or choose it. Any file with sound that Hekate can read will do, up to 300 MB; the first ten minutes are examined.
3. Hekate compares it with every mark the workspace has made. A match shows the person, the file, the date and the review, with the chance that the match is a mistake (it is shown only when that chance is below one in a million, counting every comparison made). *Open the access log* takes you to the download's record; for a guest, *Revoke their access* ends their links and sessions.

The file is examined in a private workspace on the server and removed as soon as the trace ends; it is never stored. Every trace is in the access log as *Leak traced*, with the file's name and size and what it found.

**What it survives, as measured** (the whole pipeline on generated music: six pieces, clips of 20 seconds; decision 239 in the repository has the full table): encoding again as MP3 or AAC at 96 kb/s or more, Opus at 48 kb/s or more, and Vorbis (five times in six); resampling, mono fold-downs, changes of level and equalisation, a telephone's band, a speed change of 0.1 per cent. **What it does not:** a change of speed of one per cent; AAC at 64 kb/s is unreliable even over 30 seconds; ten seconds is not enough once a copy has been encoded again. Real recordings, recording through the air (from a speaker to a microphone) and copies mixed with other sound have not been tested. A trace that finds nothing proves nothing.
