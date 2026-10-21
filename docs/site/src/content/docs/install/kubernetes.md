---
title: Install on Kubernetes
description: The Helm chart, with API and worker deployments, probes, autoscaling, disruption budgets, an Ingress, and PostgreSQL of your own or from CloudNativePG.
---

`deploy/helm/hekate` installs Hekate on Kubernetes 1.29 or later. Request-answering replicas and media workers are separate deployments; the database is yours or one CloudNativePG runs; the media go to S3. Read [Several replicas](../../operate/replicas/) first: what replicas share, and what they need.

## What it needs

- **Helm 3.14 or later** (Helm 4 included), and an Ingress controller with a certificate for the domain: cert-manager, say, through `ingress.annotations`.
- **PostgreSQL 18:** a managed service or a cluster of your own (`database.url`), or the [CloudNativePG](https://cloudnative-pg.io/) operator, installed first, with `database.cloudnativepg.enabled`. Behind a transaction pooler, give `database.directUrl` too ([The database](../../operate/database/)).
- **S3, or an S3-compatible service,** for the media (`storage.s3`). A `ReadWriteMany` volume works instead (`storage.volume.enabled`), if your cluster has one.
- **The keys.** Give them as values, and the chart keeps them in a Secret, or make the Secret yourself (External Secrets, Sealed Secrets) and name it in `secrets.existingSecret`, with the keys `master-key`, `auth-secret`, `setup-code` and, as needed, `database-url`, `database-direct-url`, `s3-access-key-id`, `s3-secret-access-key`, `smtp-url` and `metrics-token`. The setup code is a key too: until the first owner exists, it is what takes the instance. Keep a copy of the master key outside the cluster, as [The master key](../../operate/keys/) says: a cluster lost is a key lost.

## Install

```yaml
# hekate.yaml
publicUrl: https://review.example.com
secrets:
  existingSecret: hekate-keys
database:
  cloudnativepg:
    enabled: true
storage:
  s3:
    bucket: hekate-media
    region: eu-west-2
ingress:
  className: nginx
  host: review.example.com
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
    nginx.ingress.kubernetes.io/proxy-body-size: 16m
```

```sh
kubectl create secret generic hekate-keys \
  --from-literal=master-key="$(openssl rand -base64 32)" \
  --from-literal=auth-secret="$(openssl rand -hex 32)" \
  --from-literal=setup-code=7KQ2-M9XD-4HPW \
  --from-literal=s3-access-key-id='<the S3 access key>' \
  --from-literal=s3-secret-access-key='<the S3 secret key>'
helm install hekate deploy/helm/hekate -f hekate.yaml
```

Open the address and create the first owner with the setup code (your own, three groups of four letters and digits). The browser installer is not used on Kubernetes: everything is configured in values, and the setup code is set rather than made by each replica, so every replica accepts it. Behind the Ingress, client addresses come from `X-Forwarded-For`; reached any other way, set `trustProxy` to say whether a proxy you trust sets it.

Every value is described in the chart's `values.yaml`, and any other setting ([Configuration](../configuration/)) goes in `env`, by name.

## What it runs

| Resource | Does |
| --- | --- |
| Deployment `api` | Answers requests (`ROLE=api`), 2 replicas; the first to start migrates the database, the others wait on the same lock. |
| Deployment `worker` | Runs the background jobs (`ROLE=worker`): media work, mail and the instance's own sweeps. `worker.lanes` picks its lanes ([Roles and lanes](../../operate/replicas/#roles-and-lanes)). |
| Job `migrate` | Before each upgrade rolls out, migrates the database (`cli.ts migrate`), so no new replica waits on it. |
| Service and Ingress | Requests to the `api` pods, with TLS; `ingress.wildcard` adds `*.host`, for workspace subdomains once they come. |
| HorizontalPodAutoscalers | When turned on (`api.autoscaling`, `worker.autoscaling`): on CPU, and for workers on the jobs waiting (`hekate_lane_jobs_waiting`) through an external metrics adapter such as prometheus-adapter. |
| PodDisruptionBudget | Keeps one `api` replica up while nodes are drained. |
| CloudNativePG `Cluster` | When turned on: PostgreSQL with a primary and a standby it fails over to. |

Every pod runs as an unprivileged user with a read-only filesystem and no capabilities. Its scratch space for decrypted media is in memory (`api.workSize`, `worker.workSize`), never on a disk.

## Upgrades and rollbacks

`helm upgrade` with the new chart runs the migration Job first, then replaces the `api` replicas one at a time, each new one ready before an old one stops; each stops gracefully, drained first, within 40 seconds. Workers are replaced one at a time, the old one stopping first: its jobs finish, or go back to the queue for the next. Every release's migrations work with the release before it, so the old and new run side by side while the upgrade rolls; read the [upgrade notes](../../operate/upgrade-notes/) first all the same.

A release refuses a database that a later release has migrated, so `helm rollback hekate` alone works only when the upgrade migrated nothing. After one that did, going back means restoring the backup taken before it, as with Compose ([Disaster recovery](../../operate/recovery/#a-release-goes-wrong)): take one before every upgrade. A migration that drops or rewrites data needs `migrations.allowDestructive`, set in the same `helm upgrade`.

## Backups

The same three things as anywhere ([Backup and restore](../../operate/backup/)): the database, the media and the master key. With CloudNativePG, use its backups to object storage; otherwise, your database service's own, or `pg_dump` from a pod:

With `DATABASE_URL` set to the database's address:

```sh
kubectl run pg-dump --rm -i --image=postgres:18-alpine --restart=Never -- \
  pg_dump --format=custom "$DATABASE_URL" > hekate.dump
```

Version the S3 bucket, and keep the master key apart from both. To check a restore, run `kubectl exec deploy/hekate-api -- node apps/server/src/cli.ts backup verify`.
