---
title: Install with Docker Compose
description: Run Hekate, PostgreSQL and Caddy on one machine.
---

Hekate runs as one app image beside PostgreSQL and Caddy, which serves it over HTTPS with a certificate of its own. You need a machine with Docker and Docker Compose, a domain name pointing at it, and ports 80 and 443 open.

## Start

```sh
git clone https://github.com/DonQuinleone/Hekate.git
cd Hekate
cp .env.example .env
```

Set two things in `.env`:

| Setting | What to put |
| --- | --- |
| `HEKATE_DOMAIN` | The domain people will open, such as `review.example.com`. |
| `POSTGRES_PASSWORD` | A long random password for the database. |

Then start it and read the setup code from its log:

```sh
docker compose --env-file .env -f deploy/compose.yml up -d
docker compose --env-file .env -f deploy/compose.yml logs app
```

The log says `Hekate is not set up yet` and gives a code such as `7KQ2-M9XD-4HPW`. Only someone who can read the server's log has it, so nobody who finds a fresh instance first can claim it.

## The installer

Open `https://` and your domain, and enter the code. The installer tests each step before it saves it, and picks up where you left off if you close the page:

1. **Requirements:** the media tools, a writable settings directory, disk and memory.
2. **Database:** reached and brought up to date.
3. **Storage:** a local directory or an S3-compatible bucket, written to and read back. See [Storage](storage/).
4. **Master key:** made in your browser, or one you bring. It opens every file: keep a copy where the server cannot reach it, apart from your backups.
5. **Mail:** SMTP, with the hosts of the common providers filled in (Amazon SES and Plunk among them), Microsoft 365 through Microsoft Graph, or Mailcoach through its API, and a test message.
6. **Address:** looked up and asked for a code only this server knows, so you know it reaches this server.
7. **First workspace:** its name, and you as its owner. After that, accounts are by invitation, and only operators make workspaces until [registration](../operate/registration/) says otherwise.

The installer keeps what it is given in `/config/hekate.env`, on a volume of its own (`settings`), readable by the server alone. Anything also set in `.env` (the database URL and the address, in the Compose file) is shown as fixed and never overwritten; set `MASTER_KEY` and `AUTH_SECRET` in `.env` too, if you would rather keep every setting there.

If a setting is wrong once installed, Hekate does not start: `docker compose --env-file .env -f deploy/compose.yml logs app` lists every problem at once, with what would be valid. Every setting is in [Configuration](configuration/).

## Try the demo

To look around before installing it anywhere, run the demo on one machine: no domain, Caddy or certificate, and a studio's work already in it. With Docker Desktop (or Docker and the Compose plugin), and nothing to write first:

```sh
git clone https://github.com/DonQuinleone/Hekate.git
cd Hekate
docker compose --env-file deploy/demo.env -f deploy/compose.yml -f deploy/compose.build.yml -f deploy/compose.demo.yml up -d --build
```

The image builds, PostgreSQL and the app start, and a one-off `seed` container fills the instance through its API, which takes a few minutes while the sample media is made and measured; `docker compose --env-file deploy/demo.env -f deploy/compose.yml -f deploy/compose.demo.yml logs -f seed` follows it and ends with the sign-ins. Then open `http://localhost:3000`.

It seeds a label, Endless Hall Records: a music project (Joplin Rags) with a track in two versions, a dry and a wet mix, its score with the producer's marks, session takes and their log, a stage plan and patch list, a schedule, personnel and repertoire, comments of every kind, tasks, workflows and reviews in every state; a video project (Opening titles) with a cut, captions and a deliverable in two renditions; a general project with a booklet signed off in two proofs; other workspaces on the instance, one of them suspended; and, for the owner as the instance's operator, plans and invoices, support tickets, incidents on the status page, API tokens and OAuth clients, all dated to mid-October 2026.

Sign in as:

| Who | Email | Password |
| --- | --- | --- |
| Alex Rivera, owner of Endless Hall Records and the instance's operator | `producer@example.test` | `correct horse battery` |
| Tomas Varga, owner of Saltmarsh Films | `owner@saltmarsh.example` | `correct horse battery` |
| Mira Solberg, owner of Lantern Pictures, which is suspended | `mira@lantern.example` | `correct horse battery` |

There is no mail server: invitations and guest links are written to the app's log (`docker compose --env-file deploy/demo.env -f deploy/compose.yml -f deploy/compose.demo.yml logs app`), so open them yourself in a private window. The demo's settings are published in `deploy/demo.env`, and `HEKATE_DEMO` makes the server refuse any address but `localhost`, so they can never run a real instance.

`down` stops it and keeps what you made; `down -v` forgets everything, and the next `up` seeds it again. Passkeys, and links opened on other devices, need HTTPS on a real domain, as above.

## The image

The Compose file runs the released image, `ghcr.io/donquinleone/hekate`, for amd64 and arm64, pinned to the release the checkout came with (`HEKATE_VERSION` picks another). Each release's image is scanned before it is published, carries an SBOM and SLSA provenance, and is signed. Check the signature before running it:

```sh
cosign verify ghcr.io/donquinleone/hekate:<version> \
  --certificate-identity-regexp '^https://github.com/DonQuinleone/Hekate/\.github/workflows/release-please\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The container runs read-only, as an unprivileged user, with every Linux capability dropped; the image holds no shell and no package manager.

## Next

- Choose where files are kept: [Storage](storage/).
- Behind a proxy other than Caddy: [Reverse proxies](proxies/).
- Before anyone relies on it: set up [backups](../operate/backup/).
