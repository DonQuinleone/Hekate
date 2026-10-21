---
title: "Disaster recovery"
description: "Recovery objectives, what to do when each part is lost, and the scripted restore."
editUrl: https://github.com/DonQuinleone/Hekate/edit/master/docs/recovery.md
---

<!-- Copied from docs/recovery.md at build time; edit it there. -->

What to do when part of an install is lost, and how much each loss can cost. It builds on [Backup and restore](../../operate/backup/): read that first, as every scenario here ends in a restore from those backups.

## Objectives

An install is three things, and each has its own recovery point (how much may be lost) and recovery time (how long until people work again). The recovery points below are what this runbook is written for, with a daily backup: set your own, and back up as often as yours needs. The recovery time is what a restore takes on your machine, so time one in a drill and plan with that.

| Component | Recovery point | Recovery time | What sets it |
| --- | --- | --- | --- |
| Database | 24 hours | Restoring the dump | How often `deploy/backup.sh` runs. Back up hourly for an hour; for minutes, archive PostgreSQL's write-ahead log as well. |
| Storage, local | The database's | Unpacking the archive | Copied with the database, as of the same moment. |
| Storage, S3 | The database's | Restoring the bucket's versions | Bucket versioning, kept as long as the dumps. |
| Master key | None: it must never be lost | Minutes | Kept apart from the backups, in at least two places. Without it no file can be opened again by anyone. |

A restore always goes back to one backup: the database and the storage as of the same moment, opened by the master key of that time. Mixing a database from one day with storage from another loses whatever changed between them, and `backup verify` says so.

## The scripted restore (Docker Compose)

`deploy/backup.sh` makes the backup, and `deploy/restore.sh` restores it. Run both from the directory holding `.env`.

```sh
deploy/backup.sh /srv/backups
# hekate-2026-10-21T0300Z.dump and hekate-storage-2026-10-21T0300Z.tar.gz

deploy/restore.sh /srv/backups/hekate-2026-10-21T0300Z.dump \
  /srv/backups/hekate-storage-2026-10-21T0300Z.tar.gz
```

The restore stops Hekate, replaces the database and the media volume, and runs `backup verify`. Only if the database, the storage and the master key belong together does it start Hekate again; otherwise Hekate stays stopped and the `FAIL` lines say why. With the media in S3, pass `-` for the storage archive, having restored the bucket's versions of the dump's time first.

The backup stops Hekate while it copies, so that the dump and the media agree. With the media in S3, `deploy/backup.sh --live` keeps it running.

The master key is not among the backup's files. The restore uses the key in `.env`, or failing that, in the settings volume (`/config/hekate.env`).

On Kubernetes the steps are the same, run with `kubectl`; a script for them comes with the Helm chart.

## Scenarios

### The database is lost or damaged

The disk failed, a volume was deleted, or a mistake wrote over data that matters.

1. Pick the latest backup from before the damage.
2. Restore it with `deploy/restore.sh`, giving the dump and the storage archive of the same backup. Restoring the database alone, over newer storage, would leave files uploaded since then in the storage with nothing naming them. They are harmless, and the daily storage reconciliation removes them.
3. Tell people what was lost: everything since the backup's time.

### The storage is lost

The media volume or the bucket is gone, or files in it were damaged.

1. With local storage, restore the latest backup with `deploy/restore.sh`, database and storage together. Restoring the storage alone, under a newer database, leaves the database naming files that are not there, and `backup verify` fails.
2. With S3, restore the bucket's object versions as of the latest dump, then run `deploy/restore.sh` with that dump and `-`.

### The master key is lost

`.env` and the settings volume are gone, or the key was changed by mistake.

1. Find the key where it was kept apart: a password manager or a sealed envelope. If it was rotated, the previous keys go in `MASTER_KEYS_PREVIOUS` (see [Keys](../keys/)).
2. Set it as `MASTER_KEY` in `.env`, and start Hekate. It checks every workspace key at start, and refuses to serve with a key that does not open them.
3. If no copy of the key exists, the files cannot be recovered by anyone, Hekate included. That is what makes a stolen backup useless; it also makes a lost key final.

### The machine is lost

The host is gone, with its volumes.

1. On a new host, install Docker, check out the same release as before, and put back `.env`.
2. Put back the settings volume, from its copy kept apart (see [Backup and restore](../../operate/backup/)). An install set up in the browser keeps the master key, `AUTH_SECRET` and any storage credentials there, not in `.env`, and nothing starts or verifies without them:

   ```sh
   docker compose -f deploy/compose.yml create app
   docker run --rm -i -v hekate_settings:/config alpine \
     sh -c 'cat > /config/hekate.env && chown 1000:1000 /config/hekate.env && chmod 600 /config/hekate.env' \
     < hekate-settings.env
   ```

   Without that copy, set every one of those settings in `.env` instead: the master key from where it was kept apart, a new `AUTH_SECRET` (everyone signs in again), and the storage settings.
3. Copy the latest backup's files to the host, and run `deploy/restore.sh` with them.
4. Point the domain at the new host. Caddy gets a certificate when the first request arrives.

### A release goes wrong

A new release fails to start, or misbehaves once it does.

1. If it stopped at start, it says why, having changed nothing ([Upgrades](../upgrades/)): fix the setting, or go back by setting `HEKATE_VERSION` to the previous release.
2. If it has migrated the database, the previous release refuses to run against it. First set `HEKATE_VERSION` in `.env` to the previous release, as `deploy/restore.sh` starts Hekate when it is done; then restore the backup taken before the upgrade with it. What was done on the new release since is lost.
3. Report what went wrong, with the server's log, so the next release fixes it.

## Drills

CI restores a backup on every pull request: after the visual suite seeds an instance, `scripts/backup-drill.sh` dumps it, restores it somewhere new and verifies it. Once a quarter, and whenever `deploy/` changes, the recovery drill (`.github/workflows/recovery-drill.yml`) does the same with the Compose scripts against the app image. It seeds an instance, runs `deploy/backup.sh`, throws the volumes away, runs `deploy/restore.sh` into a new stack, and checks that Hekate verifies and serves again.

Run a drill of your own too, on a spare machine: a backup no one has restored is a hope, not a backup.
