---
title: Workspace data
description: Exporting a workspace for its owners, deleting one, and what the purge removes.
---

Operators can export any workspace, and delete one, from the instance side. A workspace's owners can do both themselves (see [Exporting and deleting a workspace](/use/export-and-delete/)); this page is for when they ask you to, or cannot.

## Exporting a workspace

Open the workspace, then its **Keys** tab, and choose *Start an export…*. The archive is the one its owners would get: every record as JSON and every file as it was uploaded, in a tar file encrypted with [age](https://age-encryption.org). Give the owner's own age public key (`age1…`) where you can, so the archive is encrypted to them and you never hold its key; otherwise a key is made and shown to you once, to pass on as you would a password.

- **Made in the background**, by the `workspace-export` job in the system lane, a table and then a file at a time. Files are read through decryption as they are written into the archive, which is encrypted before it is stored; no plaintext touches a disk. The archive is stored like any other object, encrypted with its own data key, in parts of at most 64 GiB, so it fits any backend.
- **Downloaded once per link,** through a link that works for five minutes in the session that asked for it, never through a URL anyone else could use. Every request and download is written to the workspace's access log (an operator appears as themselves, marked as an operator) and to the instance's events.
- **Kept for seven days,** then removed by the hourly `workspaces-purge` job. An export that lost its job is marked as failed after two days.
- **It counts as stored bytes** for the week it is kept, so in a workspace near its storage quota it may hold back uploads until it goes.

## Deleting a workspace

Only a suspended workspace can be deleted: suspend it in its **Settings** tab, then choose *Delete…* and type its name. A workspace its owners deleted is already suspended, with the reason that its owners are deleting it, and shows here with the day it goes.

Either way it waits **30 days**, a fixed grace period. Until then, *Keep it* cancels the deletion: one an operator suspended stays suspended until it is reinstated, while one its owners deleted opens again. Reinstating also cancels it.

## What the purge removes

When the grace period is over, the hourly `workspaces-purge` job deletes, in one transaction, every row the workspace owns: its members, projects, files, reviews, comments, keys, exports and everything else that names it, its access log included (through the log's explicit purge; it is not kept once its workspace has gone). Unfinished uploads are aborted first. Then every stored object under the workspace's prefix is removed from every backend, and whatever of its keys the process holds in memory is forgotten. The purge is written to the instance's events, which outlive the workspace.

If a backend fails part-way, the rows are already gone and what is left is an orphan, which [storage reconciliation](/install/storage/) reports and removes. Backups taken before the purge still hold the workspace, as they hold everything else, until they age out; restoring one brings it back.
