<p>
  <img src="brand/wordmark-display.svg" alt="Hekate" height="40">
</p>

**Review for sound and picture.**

Hekate is an open-source, self-hosted media review and approval system: a sovereign alternative to Dropbox Replay and Frame.io. Upload a cut, a mix or a score, invite reviewers, and collect feedback where every comment is anchored to an exact place in the media. Approve a version when it is right.

Classical music is a first-class citizen (tracks with versions and variations, bar numbers, score pages, session takes, a recording synced to its score), and Hekate works just as well for video and for general documents. It should never feel like a classical-music-only tool.

> **Status:** pre-release. The foundations are being built; nothing here is production-ready yet.

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/DonQuinleone/Hekate/badge)](https://scorecard.dev/viewer/?uri=github.com/DonQuinleone/Hekate)

## What makes it different

- **Anchored comments.** Every comment carries an anchor: a time range or frame, a region of a PDF page, or a bar and beat in a score. Feedback always points at something.
- **Approval flows.** Send reviews to members, guests and groups, at once or in order. Approvals are logged decisions; feedback is comments. Workflows, statuses and roles are configurable per project.
- **Project profiles.** A project picks a profile (Music, Video or General) which decides which tools appear. The model underneath is the same.
- **Protected by design.** Reviewers get encrypted streams and rendered pages, never the original files. Every access is logged, and watermarks identify who was given a copy.
- **Yours to run.** One app image, PostgreSQL and Caddy, deployed with Docker Compose. Store media on local disk, on any S3-compatible service, or on several at once.
- **Multi-tenant from day one.** Every record belongs to a workspace, so a hosted offering can follow without a rewrite.

## Stack

TypeScript end to end.

| Layer | Choice |
| --- | --- |
| Web | React, Vite, TanStack Router and Query, shadcn/ui on Tailwind (restyled to the Hekate system) |
| API | Hono, with types shared with the web app |
| Data | PostgreSQL with Drizzle ORM |
| Jobs | pg-boss, with a built-in ffmpeg worker for transcodes, waveforms and thumbnails |
| Media | hls.js with Hekate's own player controls, wavesurfer.js (audio), pdf.js (scores and documents) |
| Auth | Better Auth |
| Storage | Multiple configurable backends: local disk and any S3-compatible service |
| Deploy | One app image, PostgreSQL and Caddy via Docker Compose |

## Repository layout

```
apps/
  server/     Hono API, job runner and static host for the web build
  web/        React single-page app
packages/
  shared/     Domain types and validation shared by server and web (anchors, profiles)
  db/         Drizzle schema, migrations and database client
  storage/    Storage backends (local disk, S3) behind one interface
brand/        Mark, wordmark and icons (SVG)
docs/         Decisions, domain vocabulary, media security and the brand system
deploy/       Docker Compose and Caddy configuration
```

## Development

Requirements: Node.js 26, pnpm 12, and Docker for PostgreSQL.

```sh
pnpm install
docker compose -f deploy/compose.dev.yml up -d   # PostgreSQL on localhost:5432
cp .env.example .env
pnpm dev                                         # API on :3000, web on :5173
# Open http://localhost:5173 and follow the installer with the setup code the API printed.
# It keeps its settings in apps/server/data/hekate.env; set MASTER_KEY in .env to skip it.
```

Checks:

```sh
pnpm check      # lint, typecheck and tests across the workspace
```

## Self-hosting

The documentation (install, configuration, backups, the security model, and a guide to reviews and guests) is built from `docs/site` and published with each release.

```sh
cp .env.example .env    # set HEKATE_DOMAIN and POSTGRES_PASSWORD
docker compose --env-file .env -f deploy/compose.yml up -d
docker compose --env-file .env -f deploy/compose.yml logs app   # the setup code
```

Open your domain and enter the setup code: the installer checks the requirements, the database, the storage and mail, makes the master key (or takes yours), and creates the first workspace and its owner. Anything set in `.env` instead is shown as fixed and never overwritten.

The Compose file runs the released image, `ghcr.io/donquinleone/hekate`, for amd64 and arm64. Each release's image is scanned before it is published, carries an SBOM and SLSA provenance, and is signed with cosign; check the signature before you run it:

```sh
cosign verify ghcr.io/donquinleone/hekate:<version> \
  --certificate-identity-regexp '^https://github.com/DonQuinleone/Hekate/\.github/workflows/release-please\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To build the image from a checkout instead, add `-f deploy/compose.build.yml` and `--build`.

Back up the database, the storage and the master key, and check a restore with `backup verify`: see [docs/backup.md](docs/backup.md).

## Storage

Media can live in several named backends at once. Each stored object records which backend holds it, so you can add a backend or change the default without moving or breaking anything already stored. Workspace owners can choose which backend their new uploads use; otherwise `STORAGE_DEFAULT` applies.

```sh
STORAGE_BACKENDS=local,archive
STORAGE_DEFAULT=archive
STORAGE_LOCAL_PATH=/data/storage
STORAGE_ARCHIVE_DRIVER=s3
STORAGE_ARCHIVE_BUCKET=hekate-media
STORAGE_ARCHIVE_ENDPOINT=https://s3.example.com
STORAGE_ARCHIVE_FORCE_PATH_STYLE=true
STORAGE_ARCHIVE_ACCESS_KEY_ID=...
STORAGE_ARCHIVE_SECRET_ACCESS_KEY_FILE=/run/secrets/s3-secret
```

Everything is encrypted before it reaches a backend, with a key per file (see `docs/security.md`). Set `MASTER_KEY` to 32 random bytes (`openssl rand -base64 32`) and keep a copy somewhere safe, apart from the database and storage: without it, nothing stored can be read.

Every backend is checked at start-up; Hekate will not start with storage it cannot reach or write to. Storage never serves files to browsers directly: media always passes through Hekate's protected delivery. See `.env.example` for every setting.

## Security

Report a vulnerability privately, through the repository's Security tab; see [SECURITY.md](SECURITY.md) for what happens next and how findings are kept at zero.

## Licence

Hekate is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a network service, you must offer its source to the people who use it.
