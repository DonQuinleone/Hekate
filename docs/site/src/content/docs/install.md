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

## Try it on a laptop

To look around before installing it anywhere, run it on one machine with no domain, Caddy or certificate. With Docker Desktop (or Docker and the Compose plugin):

```sh
git clone https://github.com/DonQuinleone/Hekate.git
cd Hekate
cp .env.example .env    # then set POSTGRES_PASSWORD in it
docker compose --env-file .env -f deploy/compose.yml -f deploy/compose.build.yml -f deploy/compose.laptop.yml up -d --build
docker compose --env-file .env -f deploy/compose.yml logs app    # the setup code
```

Open `http://localhost:3000` and enter the code. Choose **Log only (development)** for mail: invitations and guest links are then written to the app's log (`logs -f app`) rather than sent, so you can open them yourself in a private window. The installer warns that the address is not HTTPS, which is expected here.

`down` stops it and keeps what you made; `down -v` forgets everything, back to the installer. Passkeys, and links opened on other devices, need HTTPS on a real domain, as above.

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
