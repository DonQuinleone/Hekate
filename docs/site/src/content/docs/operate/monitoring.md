---
title: Monitoring
description: Liveness and readiness probes, Prometheus metrics at /metrics, what each one says, and a Grafana dashboard.
---

Hekate tells Prometheus how it is doing at `/metrics`, in the text exposition format. It is off until you give it a token.

## Probes

Three endpoints answer without signing in, for Compose, Kubernetes, a load balancer or the image's own `HEALTHCHECK`. Each names a state and no more: no host, bucket or address.

| Endpoint | Answers | Use it for |
| --- | --- | --- |
| `/api/health/live` | 200 while the process answers at all. | A liveness probe: restart the container when it stops answering. |
| `/api/health/ready` | 200 when the database and every storage backend can be used; 503 when either cannot, or while the installer runs. | A readiness probe: send no requests to a replica until it is ready. |
| `/api/health` | 200 with the release when the database answers; 503 when it does not. | The image's `HEALTHCHECK`. |

`/api/health/ready` also says how the job worker and mail are (`ok`, `stale`, `failed` or `off`), in `checks`. Neither makes a replica unready: a load balancer taking every replica out for want of mail would only make things worse. A worker is `stale` when none has finished a job in ten minutes, which usually means none is running. Mail is `off` when it goes to the log rather than SMTP. The answer is kept for ten seconds, so probes every few seconds do not each write to storage.

```yaml
# Kubernetes
livenessProbe:
  httpGet: { path: /api/health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /api/health/ready, port: 3000 }
  periodSeconds: 10
```

## Turn it on

Set `METRICS_TOKEN` to at least 32 random characters (`openssl rand -hex 32`) in `.env`, or name a file holding it with `METRICS_TOKEN_FILE`, and restart. Without it there is no `/metrics` at all. A scraper sends the token as a bearer; anything else is refused.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: hekate
    scheme: http
    static_configs:
      - targets: ["app:3000"]
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/hekate-metrics-token
```

Scrape the app directly, on the Compose network (`app:3000`), where you can. Through Caddy it works too, over HTTPS with the token, since the proxy passes every path on. Each process keeps its own counts, so scrape every replica, as Prometheus expects.

## What it says

Workspaces are named by their id, never their name, and routes by their pattern (`/api/files/:id`), never the path asked for, so a scrape holds no personal data and its series stay few.

| Metric | Type | Labels | What |
| --- | --- | --- | --- |
| `hekate_build_info` | gauge | version | The running version; always 1. |
| `hekate_http_requests_total` | counter | route, method, status | API requests answered. |
| `hekate_http_request_duration_seconds` | histogram | route | How long API requests took. |
| `hekate_http_errors_total` | counter | route | Server errors (5xx); each has an error reference in the log. |
| `hekate_jobs_waiting`, `hekate_jobs_active` | gauge | queue | Jobs waiting and running, read from the queue at each scrape. |
| `hekate_jobs_failed_total` | counter | queue | Job attempts that failed in this process; a job retries before it is marked failed. |
| `hekate_job_duration_seconds` | histogram | queue, outcome | How long job attempts took. |
| `hekate_uploads_bytes_total` | counter | workspace | Bytes of uploads completed. |
| `hekate_uploads_refused_total` | counter | workspace, rule | New versions refused by a project's upload rules (`true_peak`, `edl`). |
| `hekate_storage_bytes` | gauge | backend, workspace | Bytes stored, read at each scrape. |
| `hekate_media_keys_issued_total` | counter | workspace | Stream keys issued to players. |
| `hekate_page_renders_total` | counter | workspace | Pages and pictures drawn for a viewer. |
| `hekate_downloads_total` | counter | workspace | Downloads, marked for whoever asked. |
| `hekate_database_up` | gauge | | Whether the database answered during the scrape. |
| `hekate_mail_sent_total`, `hekate_mail_failed_total` | counter | | Messages the mail server took, and would not take. |
| `hekate_signins_total`, `hekate_signins_refused_total` | counter | method | Sign-ins by password, passkey, directory or single sign-on, and those refused. |

Key issues, page renders and downloads are counted as they are written to the access log, which stays the record of who saw what; the metrics only say how much.

## Grafana

`deploy/grafana/hekate.json` in the repository is a dashboard for these: requests and errors, response times, queues, storage and the access-log counts. Import it (Dashboards, New, Import) and choose your Prometheus data source.
