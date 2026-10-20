---
title: Upgrades
description: Moving to a new release.
---

Each release's notes say what changed, and the [upgrade notes](../upgrade-notes/) gather everything to do before or after upgrading to each release. Read them first, and take a [backup](../backup/) before every upgrade.

```sh
git pull                                   # the Compose file names the new release
docker compose -f deploy/compose.yml pull app
docker compose -f deploy/compose.yml up -d app
```

When it starts, the app checks its settings first; if one is wrong it stops and says why, having changed nothing. It then runs any pending database migrations (`MIGRATE_ON_START`, on in the image), and checks its storage and every workspace key before it serves anything; if those fail it stops and names the problem, so fix it and start again. Migrations are not undone: to go back to the previous release once they have run, restore the backup taken before the upgrade, then set `HEKATE_VERSION` to that release.

## Migrations that lose data

Most releases only add to the database. A release whose migrations drop a table or a column, change a column's type, or delete rows says so in its notes, and Hekate refuses to apply them on its own: the app stops, names each statement, and changes nothing. To go ahead:

1. Take a [backup](../backup/) and read the release's upgrade notes.
2. Start the app once with `MIGRATE_ALLOW_DESTRUCTIVE=true`.
3. Remove the setting again once it has started.

A new, empty database is never refused: there is nothing in it to lose.

## Several app replicas

Replicas that start together migrate one at a time: the first takes a lock in PostgreSQL and applies the migrations, and the others wait, then find nothing left to do.

## When the database and the app disagree

With `MIGRATE_ON_START` off, the app checks the database before it starts. If the database is behind (migrations not yet applied), it stops and names them: start once with `MIGRATE_ON_START=true`, or run `pnpm db:migrate`. If the database is ahead, because a newer release has already migrated it, the app stops whatever the setting: run that newer release again, or restore the backup taken before upgrading.

To stay on a release while pulling other changes, set `HEKATE_VERSION` in `.env`.
