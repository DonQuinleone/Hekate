---
title: The database
description: Highly available PostgreSQL, connection poolers and failover.
---

Hekate keeps everything but the media in one PostgreSQL database: projects and comments, sessions, the job queue, rate limits, and every file's wrapped key. It needs PostgreSQL 18, one writable primary, and a connection that behaves as PostgreSQL does.

## Topologies

- **A managed service** (Amazon RDS or Aurora PostgreSQL, Google Cloud SQL, Azure Database for PostgreSQL, and the like) with high availability turned on. Point `DATABASE_URL` at the writer endpoint; the service moves it to the standby when the primary fails.
- **CloudNativePG** on Kubernetes: point `DATABASE_URL` at the cluster's read-write service (`<cluster>-rw`), never the read-only ones.
- **Patroni**, with HAProxy, a virtual address or another way of always reaching the current primary.
- **One PostgreSQL**, as the Compose file runs it, for a single machine. Back it up as [Backup and restore](../backup/) says.

Read replicas are not used. Every request may write, take a lock or read what it has just written, so every query goes to the primary.

## Connection poolers

Each app process opens up to ten connections, one more to listen for its replicas, and pg-boss up to four. With many replicas, a pooler in front of PostgreSQL keeps the count down.

**Session pooling** works as a direct connection does.

**Transaction pooling** (PgBouncer's `pool_mode = transaction`, and poolers like it) works too, at the pooler's defaults. Hekate never prepares statements by name, so a pooler need not track them (`max_prepared_statements` may stay at 0). One thing is slower: replicas tell each other of a change to the settings or flags with PostgreSQL's `LISTEN` and `NOTIFY`, and `LISTEN` needs a session of its own, which a transaction pooler does not keep. Each replica still reads the settings and flags again every fifteen seconds, so nothing is lost, only slower.

Migrations take a lock for their whole run, and every start that migrates takes it, even with nothing to apply, so keep migrating off the pooler. Run them over a direct connection first: one replica (or a one-off `docker compose run`) with `MIGRATE_ON_START=true` and `DATABASE_URL` pointing past the pooler, or `pnpm db:migrate` against the primary. Then start every replica that goes through the pooler with `MIGRATE_ON_START=false`: the image turns it on, and a lock taken through a transaction pooler can be left held on a pooled connection, so the next replica to start waits for it.

Everything else Hekate keeps in a connection lasts one transaction (its locks and settings), so it is safe behind a transaction pooler. That includes pg-boss, which takes only transaction-scoped locks and polls rather than listening.

## Failover

When the primary fails and a standby takes over:

- **Requests** under way when the connection drops fail, and those after it reconnect as soon as the new primary answers. People see an error for the moment of the switch, and nothing is half-written, as every change is one transaction.
- **Jobs** under way fail and are retried, each up to its retry limit; a job runs again from its start, and does what is still to do.
- **Replicas' word to each other** reconnects by itself, and each replica reads the settings and flags again as it does.
- **Readiness** (`/api/health/ready`) reports the database as down until it answers again, so a load balancer stops sending requests to a replica meanwhile.

A failover that loses committed transactions (asynchronous replication with lag) loses them for Hekate too; and storage may then hold files the database no longer names, which the daily storage reconciliation removes. Synchronous replication avoids it, at some cost in write latency.
