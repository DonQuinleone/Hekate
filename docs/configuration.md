# Configuration

<!-- Written by `pnpm --filter @hekate/server config:reference` from apps/server/src/config.ts. Do not edit by hand. -->

Hekate is configured through environment variables, in `.env` for the Compose file. Every one is checked at start-up: if any is missing or wrong, Hekate lists them all, says what would be valid, and does not start.

A setting marked as secret may instead name a file that holds it, with `_FILE` added to its name (for Docker secrets): `AUTH_SECRET_FILE=/run/secrets/auth_secret`.

## Server

| Setting | Default | What it does |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to production by the app image. |
| `PORT` | `3000` | The port the server listens on. |
| `PUBLIC_URL` | `http://localhost:3000` | The address people open Hekate at. Links in emails, sign-in callbacks and passkeys are bound to it. Example: `https://review.example.com`. |
| `TRUST_PROXY` | `false` | Behind a reverse proxy (Caddy in the Compose file), take client addresses from X-Forwarded-For. |
| `METRICS_TOKEN` | unset | Turns on `/metrics` for Prometheus (#70): a scraper sends it as a bearer token. Unset, there is no `/metrics`. Example: `(openssl rand -hex 32)`. Or `METRICS_TOKEN_FILE`, naming a file that holds it. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | Sends traces and logs to this OpenTelemetry collector over OTLP/HTTP (#162): a span for each request, job and media tool run, and every log line. Unset, nothing is sent. Example: `http://otel-collector:4318`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Headers sent with every export, as name=value pairs separated by commas: a collector's credentials, say. Example: `authorization=Bearer%20(token)`. Or `OTEL_EXPORTER_OTLP_HEADERS_FILE`, naming a file that holds it. |
| `OTEL_SERVICE_NAME` | `hekate` | The service name traces and logs carry: worth setting where several instances send to one collector. |
| `WORKSPACE_SUBDOMAINS` | `false` | Each workspace also answers at its own name under PUBLIC_URL's host, such as `endless-hall.review.example` (#176). Needs a wildcard DNS record, and a certificate for every name: the subdomains Caddyfile asks the server which names to get one for. One sign-in reaches every workspace someone belongs to: the session cookie is sent to every name under that host, so give Hekate a host of its own (`review.example`, not `example.com`), with no other service beneath it. |
| `TRUSTED_ORIGINS` | unset | Extra origins allowed to call the API with credentials, comma separated: the Vite dev server, say. Example: `http://localhost:5173`. |
| `WEB_DIST` | unset | Directory holding the built web app, served with a single-page fallback. Set in the app image. |
| `HEKATE_SETTINGS_FILE` | unset | The file the installer writes its settings to, read at every start beneath the environment (which wins). Set to /config/hekate.env in the app image; data/hekate.env otherwise. Example: `/config/hekate.env`. |
| `HEKATE_SETUP_CODE` | unset | The code that opens the installer and creates the first owner, three groups of four letters and digits. Leave unset: the server makes a new one at each start and prints it in its log. |
| `WEBHOOK_TRUSTED_ORIGINS` | unset | Origins on a private network (a chat server or receiver inside your own network), comma separated, that workspaces' channels, webhooks and own mail may reach (#161): `https://host` for a webhook or Mailcoach, `smtp://host:port` for an SMTP server. Public ones need nothing; anything else on a private address is refused. Example: `https://hooks.internal.example,smtp://mail.internal.example:587`. |
| `SHUTDOWN_DRAIN_SECONDS` | `5` | Told to stop, how long a process says it is not ready while still serving, for the load balancer to take it out of rotation first. |
| `SHUTDOWN_TIMEOUT_SECONDS` | `30` | Told to stop, how long a process has in all to drain, finish the requests and jobs under way and close. Give the orchestrator a longer grace period (the Compose file allows 40 s). |

## Database

| Setting | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | **required** | The PostgreSQL connection URL. Example: `postgres://hekate:secret@db:5432/hekate`. Or `DATABASE_URL_FILE`, naming a file that holds it. |
| `DATABASE_DIRECT_URL` | unset | A connection to the primary that bypasses a transaction pooler, for what needs a session of its own: migrations, and replicas telling each other of a change. Unset, DATABASE_URL serves for both. Example: `postgres://hekate:secret@primary:5432/hekate`. Or `DATABASE_DIRECT_URL_FILE`, naming a file that holds it. |
| `MIGRATE_ON_START` | `false` | Run pending migrations at start-up. On in the app image. |
| `MIGRATE_ALLOW_DESTRUCTIVE` | `false` | Let an upgrade apply a migration that drops or rewrites data. Hekate refuses one until this is set: take a backup and read the upgrade notes first, then start once with it and unset it again. |

## Security

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTH_SECRET` | **required** | Signs sessions and tokens, and keys the hashes of recovery codes. At least 32 random characters. Example: `(openssl rand -hex 32)`. Or `AUTH_SECRET_FILE`, naming a file that holds it. |
| `MASTER_KEY` | **required** | The instance master key for encryption at rest: 32 random bytes, base64 encoded. It wraps every workspace key; losing it loses every stored file, so back it up apart from the database and storage. Example: `(openssl rand -base64 32)`. Or `MASTER_KEY_FILE`, naming a file that holds it. |
| `MASTER_KEYS_PREVIOUS` | unset | Earlier master keys, comma separated, kept only while rotating (docs/security.md). Or `MASTER_KEYS_PREVIOUS_FILE`, naming a file that holds it. |

## Sign-in

| Setting | Default | What it does |
| --- | --- | --- |
| `PASSWORD_LEAK_CHECK` | `true` | Check new passwords against Have I Been Pwned, sending only the first five characters of a hash. Turn off on an instance without internet access. |
| `REQUIRE_SECOND_FACTOR` | `false` | Ask every account for a second factor, whatever its workspaces say. People without one are asked at their next sign-in. |
| `OPERATOR_SECURITY_KEY` | `true` | Operators reach the instance side only from a session signed in with a passkey or hardware security key. Turn off only for testing. |
| `MAX_PASSKEYS` | `5` | How many passkeys and hardware security keys one account may hold. |
| `SSO_TRUSTED_ORIGINS` | unset | Origins of identity providers on a private network (an internal Keycloak, say), comma separated, that single sign-on may reach. Public ones need nothing. Example: `https://login.internal.example`. |

## Mail

| Setting | Default | What it does |
| --- | --- | --- |
| `SMTP_URL` | unset | The SMTP server to send mail through. Without it, mail is written to the log instead. Example: `smtp://user:pass@mail.example.com:587`. Or `SMTP_URL_FILE`, naming a file that holds it. |
| `MAIL_FROM` | `Hekate <hekate@localhost>` | The sender of every message. |
| `MAIL_GRAPH_TENANT` | unset | Microsoft 365, instead of SMTP: the directory (tenant) ID of an app registration granted Mail.Send, which sends as the MAIL_FROM mailbox through Microsoft Graph. With MAIL_GRAPH_CLIENT_ID and MAIL_GRAPH_CLIENT_SECRET. Example: `contoso.onmicrosoft.com`. |
| `MAIL_GRAPH_CLIENT_ID` | unset | Microsoft 365: the app registration's application (client) ID. Example: `00000000-0000-0000-0000-000000000000`. |
| `MAIL_GRAPH_CLIENT_SECRET` | unset | Microsoft 365: a client secret of the app registration. Or `MAIL_GRAPH_CLIENT_SECRET_FILE`, naming a file that holds it. |
| `MAIL_MAILCOACH_URL` | unset | Mailcoach, instead of SMTP: the address of the Mailcoach account whose transactional API sends mail. With MAIL_MAILCOACH_TOKEN. Example: `https://endlesshall.mailcoach.app`. |
| `MAIL_MAILCOACH_TOKEN` | unset | Mailcoach: an API token allowed to send transactional mail. Or `MAIL_MAILCOACH_TOKEN_FILE`, naming a file that holds it. |
| `MAIL_WEBHOOK_SECRET` | unset | Bounce reports (#161): what proves a report came from the instance's mail provider, so Hekate stops sending to addresses that bounced for good or complained. Resend's webhook signing secret, Mailgun's HTTP webhook signing key, SendGrid's verification key, or SparkPost's webhook user:password. The provider's webhook goes to /api/hooks/mail/instance. Or `MAIL_WEBHOOK_SECRET_FILE`, naming a file that holds it. |

## Media

| Setting | Default | What it does |
| --- | --- | --- |
| `WORKER` | `true` | Run background jobs (media processing, mail, reminders) in this process. Turn off for API-only replicas. |
| `ROLE` | unset | What this process does: all (requests and background jobs), api (requests only) or worker (background jobs, answering only health and metrics). Unset, WORKER decides: all, or api when it is false. Example: `worker`. |
| `WORKER_LANES` | unset | The lanes of background jobs a worker takes (transcode, analyse, pages, mail, system), each with how many of each kind of its jobs to run at once if not the default (analyse:2 runs up to two measurements, two analyses, two alignments and two checksums). Unset, it takes every lane. Example: `transcode:4,analyse:2,pages`. |
| `WORKER_CONCURRENCY` | `2` | Jobs of each kind of media work run at once in this process (probing, analysing, pages and so on, each up to this many; streaming renditions and alignments half as many). ffmpeg is CPU-heavy; about half the cores is a good start. |
| `WORK_DIR` | unset | Scratch space for decrypted media while a job runs, or a page or download is marked; a tmpfs keeps it off disk. Defaults to hekate-work in the system's temporary directory. Example: `/tmp/hekate-work`. |
| `ADM_RENDERER_PATH` | unset | Where the EBU ADM Renderer (ear) and its Python packages are installed, to render an ADM master's objects for listening. The image sets it; without it, only an ADM master's bed is heard. Example: `/opt/ear`. |
| `VIDEO_LADDER` | `1080:6000,720:3000,480:1200` | The video ladder: each rung an even height in pixels and a bitrate in kbit/s, highest first. A video gets the highest rungs at or below its own height, as many as VIDEO_RUNGS allows. Example: `2160:16000,1080:6000,720:3000`. |
| `VIDEO_RUNGS` | `2` | The most rungs of the ladder one video is encoded at. Each is another encode, twice over with VIDEO_ROYALTY_FREE. |
| `VIDEO_ROYALTY_FREE` | `av1` | A royalty-free encoding beside H.264 at every rung, with Opus sound, for browsers that play it: AV1, VP9 (faster to encode, larger), or off. |
| `VIDEO_HARDWARE` | unset | A VAAPI render node (Intel or AMD) to encode H.264 on. Pass the device to the container; a rendition the GPU cannot encode is encoded in software instead. Example: `/dev/dri/renderD128`. |
| `STORAGE_RECONCILE` | `remove` | What the daily storage reconciliation does with bytes and blobs nothing uses, once a second run a day later still finds them: remove them, or only report them. |

## Modules

| Setting | Default | What it does |
| --- | --- | --- |
| `HEKATE_BILLING` | `off` | Billing for a hosted offering (decision 041). Off for a self-hosted install, which shows none. |
| `STRIPE_SECRET_KEY` | unset | With HEKATE_BILLING=stripe (#178): the Stripe account's secret key, or a restricted key allowed customers, products, Checkout, the customer portal and subscriptions. Test mode only for now. Example: `sk_test_…`. Or `STRIPE_SECRET_KEY_FILE`, naming a file that holds it. |
| `STRIPE_WEBHOOK_SECRET` | unset | With HEKATE_BILLING=stripe: the signing secret of the webhook endpoint added in Stripe for /api/hooks/billing/stripe, which proves each event came from Stripe. Example: `whsec_…`. Or `STRIPE_WEBHOOK_SECRET_FILE`, naming a file that holds it. |
| `STRIPE_TAX` | `false` | With HEKATE_BILLING=stripe: work out tax with Stripe Tax, from the address and tax id collected at checkout. Stripe Tax must be set up in the account first. |
| `HEKATE_SUPPORT` | `off` | Support: off; app, tickets in the application; link, an external help desk; or mail, tickets sent to an address (decision 041). |
| `HEKATE_SUPPORT_ADDRESS` | unset | Where support goes: the help desk's address when HEKATE_SUPPORT is link, or the mailbox when it is mail. Example: `support@example.com`. |
| `HEKATE_UPDATE_CHECK` | `false` | Check the project's public releases once a day, for System information and the Overview. Nothing about the instance is sent. Off by default: the instance asks nothing of anyone. |
| `HEKATE_BUILD` | `dev` | The commit the image was built from. Set by the image; leave it alone. |
| `HEKATE_DOCS_URL` | `https://docs.hekate.studio` | Where the help menu's documentation link goes. |
| `HEKATE_STATUS_URL` | unset | A status page for the help menu to link to; none when unset. |

## Storage

Storage backends are named in `STORAGE_BACKENDS` (default `local`), and each is configured by settings carrying its name: for a backend called `archive`, `STORAGE_ARCHIVE_DRIVER` and so on. `STORAGE_DEFAULT` names the backend new files go to (the first listed, unless set). Every backend is checked at start-up; Hekate will not start with one it cannot reach or write to.

| Setting | Default | What it does |
| --- | --- | --- |
| `STORAGE_BACKENDS` | `local` | The backends, comma separated: lower-case letters, digits and hyphens. |
| `STORAGE_DEFAULT` | the first listed | Where new files go. |
| `STORAGE_<NAME>_DRIVER` | `local` or `s3` for backends of those names | `local` or `s3`. |
| `STORAGE_<NAME>_PATH` | `data/storage` for `local` | Local: the directory objects are kept in. |
| `STORAGE_<NAME>_BUCKET` | **required** for S3 | S3: the bucket. |
| `STORAGE_<NAME>_REGION` | unset | S3: the region. |
| `STORAGE_<NAME>_ENDPOINT` | unset | S3: the endpoint, for an S3-compatible service other than AWS. |
| `STORAGE_<NAME>_FORCE_PATH_STYLE` | `false` | S3: address the bucket in the path, as most S3-compatible services need. |
| `STORAGE_<NAME>_ACCESS_KEY_ID` | unset | S3: the access key; set with the secret, or neither to use the environment's credentials. Or `_FILE`. |
| `STORAGE_<NAME>_SECRET_ACCESS_KEY` | unset | S3: the secret key. Or `_FILE`. |
| `STORAGE_<NAME>_PREFIX` | unset | S3: a prefix for every object, to share a bucket. |

Whatever the backend, it holds only ciphertext: every file is encrypted with its own key before it is written (docs/security.md).
