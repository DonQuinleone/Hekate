---
title: Upgrades
description: Moving to a new release.
---

Each release's notes say what changed and anything to do before or after upgrading. Read them first, and take a [backup](../backup/) before every upgrade.

```sh
git pull                                   # the Compose file names the new release
docker compose -f deploy/compose.yml pull app
docker compose -f deploy/compose.yml up -d app
```

When it starts, the app checks its settings first; if one is wrong it stops and says why, having changed nothing. It then runs any pending database migrations (`MIGRATE_ON_START`, on in the image), and checks its storage and every workspace key before it serves anything; if those fail it stops and names the problem, so fix it and start again. Migrations are not undone: to go back to the previous release once they have run, restore the backup taken before the upgrade, then set `HEKATE_VERSION` to that release.

To stay on a release while pulling other changes, set `HEKATE_VERSION` in `.env`.
