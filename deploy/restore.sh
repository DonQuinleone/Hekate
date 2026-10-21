#!/usr/bin/env sh
# Restore a Docker Compose install of Hekate from deploy/backup.sh's files (docs/recovery.md).
# Run from the directory holding .env, with the same MASTER_KEY in .env or the settings volume:
#   deploy/restore.sh hekate-DATE.dump hekate-storage-DATE.tar.gz
#   deploy/restore.sh hekate-DATE.dump -     the media is in S3: restore the bucket's versions
#                                            of the dump's time first
# It replaces the database and the media volume, checks with `backup verify` that the database,
# the storage and the master key belong together, and starts Hekate only if they do.
# COMPOSE_FILE picks other Compose files.
set -eu
if [ $# -ne 2 ]; then
  sed -n '2,9p' "$0"
  exit 2
fi
dump=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
[ -f "$dump" ] || { echo "No database dump at $1" >&2; exit 2; }
storage=""
if [ "$2" != "-" ]; then
  storage=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
  [ -f "$storage" ] || { echo "No storage archive at $2" >&2; exit 2; }
fi
export COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose.yml}"
media="${COMPOSE_PROJECT_NAME:-hekate}_media"

echo "Stopping Hekate"
docker compose stop app
docker compose up -d --wait db

echo "Restoring the database"
docker compose exec -T db dropdb --username=hekate --if-exists hekate
docker compose exec -T db createdb --username=hekate hekate
docker compose exec -T db pg_restore --no-owner --exit-on-error --username=hekate \
  --dbname=hekate <"$dump"

if [ -n "$storage" ]; then
  echo "Restoring the storage"
  # Compose makes the volume, on a new machine, so it stays Compose's own.
  docker compose create --quiet-pull app >/dev/null
  docker run --rm -v "$media:/data" -v "$(dirname "$storage"):/backup:ro" alpine \
    sh -c "find /data -mindepth 1 -delete && tar -xzf '/backup/$(basename "$storage")' -C /data \
      && chown -R 1000:1000 /data"
fi

echo "Verifying the restore"
if ! docker compose run --rm --no-deps app apps/server/src/cli.ts backup verify; then
  echo "The restore does not verify: Hekate stays stopped. See docs/recovery.md." >&2
  exit 1
fi

echo "Starting Hekate"
docker compose up -d --wait
