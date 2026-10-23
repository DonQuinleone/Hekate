---
title: Exporting and deleting a workspace
description: How a workspace's owners take everything it holds away, and how they delete it.
---

A workspace's owners can take away everything it holds, at any time, and can delete it. Both are in **Settings, General**, for owners only; admins and members do not see them.

## Exporting

*Start an export…* makes one archive of the whole workspace:

- **Its records, as JSON:** projects, folders, tracks, versions, takes, comments, reviews and decisions, workflows, tasks, members, guests and the access log, one file per table (or per 5,000 rows of a larger one). Wrapped keys, sealed secrets and the hashes of links and codes are left out: they mean nothing outside this instance. `records/people.json` names the members.
- **Its files, as they were uploaded:** every file by project and folder, every comment's attachment and every caption file. These are the originals, without watermarks, so keep the archive as you would keep them.
- **`manifest.json`** lists every file with its path, size and SHA-256, and the record files of each table. `README.txt` says the same in words.

The archive is a tar file encrypted with [age](https://age-encryption.org). Leave the key field empty and a key is made for this export and **shown once**: copy it, store it where you keep passwords, and tick that you have before closing. Hekate keeps no copy, so without it the archive cannot be opened, by you or by anyone else. If you have an age key of your own, paste its public key (`age1…`) instead and nothing is shown.

The export is made in the background; a large workspace can take a while. When it is ready, *Download* fetches it through a link that works once, for five minutes, in your session. The archive is kept for **seven days**, then removed. One export is made at a time.

To open it, save the key to a file and run:

```sh
age -d -i key.txt endless-hall-export-2026-10-20.tar.age | tar -x
```

(`rage`, or any other implementation of age, works too.) Every export asked for and every download is in the workspace's access log.

## Deleting

*Delete this workspace* takes two owners, as deleting a project does:

1. One owner asks. The other owners are told, in the app and by mail.
2. Another owner confirms, typing the workspace's name. A workspace with only one owner has no second to ask, so its owner confirms their own request, but only a day after asking.

Once confirmed, the workspace closes at once to every member and guest: they see that it is being deleted, and when. Thirty days later its members, projects, files, reviews, keys, exports and access log are removed, and its stored files with them. Until then any owner can **keep it**, which opens it again exactly as it was, and can still export it: export before you confirm, or during those thirty days, if you want a copy. A paid plan stops at the end of the period already paid for.

The instance's operators can also export a workspace, and delete one they have suspended, from the instance side; see [Workspace data](/operate/workspace-data/).
