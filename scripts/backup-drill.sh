#!/usr/bin/env sh
# The restore drill (#152), run by CI after the visual suite: back up the instance the suite
# seeded (database and storage), restore both somewhere new, and check with
# `cli.ts backup verify` that the restored database, storage and master key belong together.
# Needs E2E_DATABASE_URL, E2E_MASTER_KEY and Docker (for pg_dump matching the server).
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
pg="docker run --rm --network host -v $work:/backup postgres:18-alpine"

echo "Backing up the database and the storage"
$pg pg_dump --format=custom --file=/backup/hekate.dump "$E2E_DATABASE_URL"
cp -a "$here/apps/e2e/.state/storage" "$work/storage"

echo "Restoring into a new database and a new storage directory"
restored=$(printf '%s' "$E2E_DATABASE_URL" | sed 's#/[^/]*$#/hekate_restored#')
$pg psql "$E2E_DATABASE_URL" -c "drop database if exists hekate_restored" -c "create database hekate_restored"
$pg pg_restore --no-owner --dbname="$restored" /backup/hekate.dump
mv "$work/storage" "$work/restored-storage"

echo "Verifying the restore"
cd "$here/apps/server"
DATABASE_URL="$restored" \
  AUTH_SECRET=restore-drill-secret-restore-drill-secret \
  MASTER_KEY="$E2E_MASTER_KEY" \
  STORAGE_LOCAL_PATH="$work/restored-storage" \
  node src/cli.ts backup verify --sample 50
