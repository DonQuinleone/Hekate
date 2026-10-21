#!/usr/bin/env sh
# Back up a Docker Compose install of Hekate: the database and the media volume, as of the
# same moment (docs/backup.md). Run from the directory holding .env:
#   deploy/backup.sh [directory]            stops the app for the copy, then starts it again
#   deploy/backup.sh --live [directory]     keeps it running: only when the media is in S3
# Writes hekate-DATE.dump and hekate-storage-DATE.tar.gz. The master key is not among them:
# keep it apart, as docs/backup.md says. COMPOSE_FILE picks other Compose files.
set -eu
live=false
if [ "${1:-}" = "--live" ]; then
  live=true
  shift
fi
out=$(cd "${1:-.}" && pwd)
export COMPOSE_FILE="${COMPOSE_FILE:-deploy/compose.yml}"
media="${COMPOSE_PROJECT_NAME:-hekate}_media"
stamp=$(date -u +%Y-%m-%dT%H%MZ)

if [ "$live" = false ]; then
  echo "Stopping Hekate while the copy is made"
  docker compose stop app
  trap 'docker compose start app' EXIT
fi

echo "Dumping the database"
docker compose exec -T db pg_dump --format=custom --username=hekate hekate \
  >"$out/hekate-$stamp.dump"

echo "Copying the storage"
docker run --rm -v "$media:/data:ro" -v "$out:/backup" alpine \
  tar -czf "/backup/hekate-storage-$stamp.tar.gz" -C /data .

echo "Backed up to $out/hekate-$stamp.dump and $out/hekate-storage-$stamp.tar.gz"
