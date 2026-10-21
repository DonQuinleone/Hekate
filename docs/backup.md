# Backup and restore

Three things make a Hekate install, and losing any one of them loses the media:

- **the database** (PostgreSQL): projects, comments, reviews, and every file's wrapped key;
- **the storage** (a local directory or an S3 bucket): the files themselves, encrypted;
- **the master key** (`MASTER_KEY`): it opens the workspace keys, which open the files.

When the installer made the key, it is in the settings file, `/config/hekate.env` on the `settings` volume, with the rest of what the installer was given; it was also shown once, to be stored elsewhere. Back the settings volume up as you would the key itself.

Back up all three, and keep the master key apart from the other two. `deploy/backup.sh` and `deploy/restore.sh` script the steps below; [Disaster recovery](docs/recovery.md) says when to use them. A copy of the database and the storage without the key is useless to whoever takes it; that is the point. Lose the key, and so is your own copy.

## Backing up (Docker Compose)

Run these from the directory holding `.env`. The database and the storage must be copied as of the same moment: a file deleted between the two copies would be named by the dump yet missing from the storage. So with local storage, stop Hekate for the backup (the database stays up):

```sh
docker compose -f deploy/compose.yml stop app
```

1. **The database**, as one consistent snapshot:

   ```sh
   docker compose -f deploy/compose.yml exec -T db \
     pg_dump --format=custom --username=hekate hekate > hekate-$(date +%F).dump
   ```

2. **The storage**, copied after the dump finishes:
   - local storage, the `media` volume:

     ```sh
     docker run --rm -v hekate_media:/data:ro -v "$PWD":/backup alpine \
       tar -czf /backup/hekate-storage-$(date +%F).tar.gz -C /data .
     ```

   - S3: turn on bucket versioning and keep versions, deleted ones included, at least as long as you keep database dumps. A restore then reads the objects as they were at the dump's time, so with S3 Hekate can keep running while you take the dump.

   Then start Hekate again: `docker compose -f deploy/compose.yml start app`.

3. **The master key**, once, and again whenever it is rotated: store `MASTER_KEY` (and any `MASTER_KEYS_PREVIOUS`) in a password manager or a sealed envelope, not beside the backups.

With S3, files uploaded after the dump may be in the bucket but not the database; they are harmless, and the daily storage reconciliation removes them after a restore.

## Restoring

1. Stop Hekate: `docker compose -f deploy/compose.yml stop app`.
2. Restore the database into an empty one:

   ```sh
   docker compose -f deploy/compose.yml exec -T db dropdb --username=hekate --if-exists hekate
   docker compose -f deploy/compose.yml exec -T db createdb --username=hekate hekate
   docker compose -f deploy/compose.yml exec -T db \
     pg_restore --no-owner --username=hekate --dbname=hekate < hekate-2026-10-16.dump
   ```

3. Restore the storage: unpack the archive into the `media` volume, or point the S3 bucket at the versions of the dump's time.
4. Set the same `MASTER_KEY` in `.env`.
5. **Verify before anyone uses it:**

   ```sh
   docker compose -f deploy/compose.yml run --rm app apps/server/src/cli.ts backup verify
   ```

   It checks that every workspace key opens with the master key, that every file the database records is in its storage, and that a random sample of files (`--sample 50` for more) reads back, decrypts and matches its checksum. It changes nothing. A `FAIL` line names what is wrong: a different master key, a storage copy from the wrong day, or a backend that is not configured.

6. Start Hekate: `docker compose -f deploy/compose.yml start app`.

## What CI checks

After the visual suite seeds an instance, CI runs `scripts/backup-drill.sh`: it dumps the database, copies the storage, restores both into a new database and directory, and runs `backup verify` against the restore. A change that breaks restoring breaks the build.
