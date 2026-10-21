---
title: Several replicas
description: Running more than one app process against one database, and what they must share.
---

One app process serves most studios. For more, or to keep serving while one restarts, run several against the same PostgreSQL. Everything they must agree on lives in the database: sessions, rate limits and sign-in lockouts, jobs, upload records, and the instance's settings and flags. A change an operator makes on one replica reaches the others at once, announced through PostgreSQL; each also reads them again every fifteen seconds, in case an announcement is missed.

## What every replica needs

- **The same settings, from the environment.** `AUTH_SECRET`, `MASTER_KEY`, `PUBLIC_URL`, the storage backends and every other setting, identical on each replica. The browser installer writes to one replica's settings file, so with several, configure through the environment (or a shared settings file) instead, and set `HEKATE_SETUP_CODE` if the installer is to run at all.
- **Storage every replica can reach.** S3, or an S3-compatible service, is the choice for more than one machine. Local storage works only on a filesystem every replica mounts: an upload's parts go to whichever replica takes each request.
- **Its own scratch directory, ideally.** `WORK_DIR` holds decrypted media only while a job runs, and the Compose file keeps it in memory for each container. Replicas may share one, each cleaning up only after itself.

## Roles

Every replica serves the API. `WORKER=false` keeps media processing, mail and the other background jobs off a replica, for one that should only answer requests; the scheduled jobs still run once each, whichever replica starts them. Size `WORKER_CONCURRENCY` for the machine each worker runs on.

## Starting, upgrading and stopping

Replicas that start together migrate the database once, one waiting for the other (see [Upgrades](../upgrades/)). A readiness probe on `/api/health/ready` keeps a replica out of the load balancer until it can serve. Metrics are counted in each process, so scrape every replica ([Monitoring](../monitoring/)).

## Rotating the master key

Each replica, as it starts, re-wraps every workspace key with its own `MASTER_KEY`, so a rolling restart must first teach every replica both keys:

1. On every replica in turn: keep `MASTER_KEY`, and add the new key to `MASTER_KEYS_PREVIOUS`. Each can now open keys wrapped by either.
2. On every replica in turn: make the new key `MASTER_KEY`, and move the old one to `MASTER_KEYS_PREVIOUS`. The first to start re-wraps the workspace keys; the rest find nothing to do.
3. On every replica in turn: remove the old key from `MASTER_KEYS_PREVIOUS`.

Finish each step on every replica before the next. Restarting one with step 1's settings during step 2 would re-wrap keys with the old key again: nothing breaks, as every replica still opens both, but step 2's last restart must then follow it.
