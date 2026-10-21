---
title: Install on Docker Swarm
description: API replicas, media workers, PostgreSQL and Caddy across several machines, with the keys as Docker secrets.
---

`deploy/stack.yml` runs Hekate on a Docker Swarm of one or more machines. Request-answering replicas run anywhere, media workers run on the machines labelled for them, PostgreSQL runs on one, and Caddy serves HTTPS. Read [Several replicas](../../operate/replicas/) first: what replicas share, and what they need.

## What it needs

- **A swarm** (`docker swarm init` on the first machine, `docker swarm join` on the others), with ports 80 and 443 reaching the manager that runs Caddy, and a domain pointing at it.
- **S3, or an S3-compatible service,** for the media: every machine must reach them. Local storage is not offered here.
- **Secrets** for everything that opens the media or the database. Create them once, on a manager:

```sh
printf '%s' "$(openssl rand -base64 32)" | docker secret create hekate_master_key -
printf '%s' "$(openssl rand -hex 32)" | docker secret create hekate_auth_secret -
password=$(openssl rand -hex 24)
printf '%s' "$password" | docker secret create hekate_db_password -
printf 'postgres://hekate:%s@db:5432/hekate' "$password" | docker secret create hekate_database_url -
printf '%s' '<the S3 secret key>' | docker secret create hekate_s3_secret_key -
```

Keep a copy of the master key apart from the swarm, as [The master key](../../operate/keys/) says: Docker keeps secrets encrypted, but a swarm lost is a key lost.

- **Labels** saying where the database and the media work go:

```sh
docker node update --label-add hekate.db=true <the machine that keeps the database>
docker node update --label-add hekate.worker=true <each machine that may run media work>
```

## Deploy

```sh
export HEKATE_DOMAIN=review.example.com
export HEKATE_SETUP_CODE=7KQ2-M9XD-4HPW     # your own, three groups of four letters and digits
export S3_BUCKET=hekate-media S3_REGION=eu-west-2 S3_ACCESS_KEY_ID=…
docker stack deploy -c deploy/stack.yml hekate
```

Open `https://HEKATE_DOMAIN` and create the first owner with the setup code. With several replicas the installer is not used: everything is configured here, and the setup code is set rather than made by each replica, so every replica accepts it.

Optional settings, each from the environment `docker stack deploy` runs in: `S3_ENDPOINT` for a service other than AWS, `HEKATE_API_REPLICAS` (2), `HEKATE_WORKER_REPLICAS` (1), `HEKATE_WORKER_LANES` and `HEKATE_WORKER_CONCURRENCY` ([Roles and lanes](../../operate/replicas/#roles-and-lanes)), `HEKATE_WORK_SIZE` (8g of memory for each worker's scratch space), and `HEKATE_VERSION`. To send mail, create a `hekate_smtp_url` secret and add `SMTP_URL_FILE: /run/secrets/hekate_smtp_url` and the secret to the app's settings.

## What it runs

| Service | Replicas | Where | Does |
| --- | --- | --- | --- |
| `api` | 2 | anywhere | Answers requests (`ROLE=api`), and migrates the database as it starts, one replica at a time. |
| `worker` | 1 | `hekate.worker=true` | Runs the background jobs (`ROLE=worker`): media work, mail and the instance's own sweeps. |
| `db` | 1 | `hekate.db=true` | PostgreSQL 18, its data in a volume on that machine. |
| `caddy` | 1 | a manager | HTTPS for the domain, spreading requests across the `api` replicas. |

For a database that survives the loss of its machine, use a managed service or Patroni, remove the `db` service, and point the `hekate_database_url` secret at it ([The database](../../operate/database/)).

## Upgrades and rollbacks

`docker stack deploy` again with a new `HEKATE_VERSION` upgrades one replica at a time. Each new `api` replica starts, and is healthy, before an old one stops (`order: start-first`); each stops gracefully, drained first, within 40 seconds. A replica that fails to come up rolls the service back by itself (`failure_action: rollback`), and `docker service rollback hekate_api` does so by hand. Every release's migrations work with the release before it, so the old and new run side by side while the upgrade rolls; read the [upgrade notes](../../operate/upgrade-notes/) first all the same.

Workers update one at a time too, the old one stopping first (`order: stop-first`): its jobs finish, or go back to the queue for the next.
