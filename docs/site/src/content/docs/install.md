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

Set at least these in `.env`:

| Setting | What to put |
| --- | --- |
| `HEKATE_DOMAIN` | The domain people will open, such as `review.example.com`. |
| `POSTGRES_PASSWORD` | A long random password for the database. |
| `AUTH_SECRET` | 32 random characters or more: `openssl rand -hex 32`. |
| `MASTER_KEY` | 32 random bytes: `openssl rand -base64 32`. Keep a copy apart from the server; without it nothing stored can be read. |

Then start it:

```sh
docker compose -f deploy/compose.yml up -d
```

Open `https://` and your domain. The first visit asks you to create the owner's account and the first workspace; after that, accounts are by invitation.

If a setting is missing or wrong, Hekate does not start: `docker compose -f deploy/compose.yml logs app` lists every problem at once, with what would be valid. Every setting is in [Configuration](configuration/).

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
