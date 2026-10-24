---
title: Monitoring
description: Liveness and readiness probes, Prometheus metrics at /metrics, what each one says, traces and logs to an OpenTelemetry collector, the System health page and a Grafana dashboard.
---

Hekate tells Prometheus how it is doing at `/metrics`, in the text exposition format. It is off until you give it a token.

## Probes

Three endpoints answer without signing in, for Compose, Kubernetes, a load balancer or the image's own `HEALTHCHECK`. Each names a state and no more: no host, bucket or address.

| Endpoint | Answers | Use it for |
| --- | --- | --- |
| `/api/health/live` | 200 while the process answers at all. | A liveness probe: restart the container when it stops answering. |
| `/api/health/ready` | 200 when the database and every storage backend can be used; 503 when either cannot, or while the installer runs. | A readiness probe: send no requests to a replica until it is ready. |
| `/api/health` | 200 with the release when the database answers; 503 when it does not. | The image's `HEALTHCHECK`. |

`/api/health/ready` also says how the job worker and mail are (`ok`, `stale`, `failed` or `off`), in `checks`. Neither makes a replica unready: a load balancer taking every replica out for want of mail would only make things worse. A worker is `stale` when none has finished a job in ten minutes, which usually means none is running. Mail is `off` when it goes to the log rather than to SMTP or a provider. The answer is kept for ten seconds, so probes every few seconds do not each write to storage.

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
| `hekate_worker_lanes`, `hekate_worker_lanes_busy` | gauge | | Jobs this process may run at once, and is running now. |
| `hekate_uploads_bytes_total` | counter | workspace | Bytes of uploads completed. |
| `hekate_uploads_refused_total` | counter | workspace, rule | New versions refused by a project's upload rules (`true_peak`, `edl`). |
| `hekate_storage_bytes` | gauge | backend, workspace | Bytes stored, read at each scrape. |
| `hekate_media_keys_issued_total` | counter | workspace | Stream keys issued to players. |
| `hekate_page_renders_total` | counter | workspace | Pages and pictures drawn for a viewer. |
| `hekate_downloads_total` | counter | workspace | Downloads, marked for whoever asked. |
| `hekate_database_up` | gauge | | Whether the database answered during the scrape. |
| `hekate_mail_sent_total`, `hekate_mail_failed_total` | counter | | Messages the mail server took, and would not take. |
| `hekate_webhook_deliveries_total` | counter | `channel`, `status` | Each attempt to send an event to a workspace's channel: `slack`, `discord`, `teams` or `webhook`, and `delivered` or `failed`. |
| `hekate_signins_total`, `hekate_signins_refused_total` | counter | method | Sign-ins by password, passkey, directory or single sign-on, and those refused. |

Key issues, page renders and downloads are counted as they are written to the access log, which stays the record of who saw what; the metrics only say how much.

## Traces and logs

Hekate sends traces and logs to an OpenTelemetry collector of your choosing, over OTLP/HTTP, once you name one. Nothing is sent until you do, and nothing goes anywhere else.

```sh
# .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
# Optional: a collector's credentials, as name=value pairs separated by commas (or OTEL_EXPORTER_OTLP_HEADERS_FILE).
OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer%20…
# Optional: worth setting where several instances send to one collector.
OTEL_SERVICE_NAME=hekate-endless-hall
```

Hekate adds `/v1/traces` and `/v1/logs` to the address itself, so give the collector's base address. The instance's **Settings**, under Address and mail, shows the address in use (without any user, password or query string in it), or Off. Any backend that takes OTLP works behind it: Grafana Tempo and Loki, Jaeger, Honeycomb, SigNoz and others.

| Span | Named | Carries |
| --- | --- | --- |
| A request | Its method and route, such as `GET /api/files/:id` | The method, route and status. A 5xx marks it failed. A caller's `traceparent` is continued. |
| A job | `job` and its queue, such as `job document-render` | The queue, the job's id and the attempt. A failure marks it, with the error. |
| A media tool run | The tool, such as `ffmpeg` | How many arguments it had, never what they were: they hold file names and titles. |

Routes are named by their pattern, never the path asked for, and a job's data stays out of its span, as with the metrics. Every line the server writes to its log is also sent as a log record, in the trace it was written in, so a collector can show a request's lines beside its spans; the log on stdout is unchanged.

An error reference (in **Debug tools**) carries the trace it happened in, so you can go from the reference someone quotes to the trace, and from a failed span to the reference in its log line.

## System health

Without Prometheus, operators still see the machine on the instance side's **System health** page: processor, memory, disk and database connections now; requests, latency, errors, queue depth, busy worker lanes and uploads over the last hour or day; each service's state; and each storage backend, the master key and the last reconciliation, which an operator can also run there and then. Every running process writes what it measured each minute to the database, and the rows go after a day, so the page needs no token and nothing beyond PostgreSQL. Processor and memory are the machine's (or the container's host's) as the process sees them; the disk is the one holding local storage.

## Grafana

`deploy/grafana/hekate.json` in the repository is a dashboard for these: requests and errors, response times, queues, storage and the access-log counts. Import it (Dashboards, New, Import) and choose your Prometheus data source.
