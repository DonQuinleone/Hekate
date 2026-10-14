# AGENTS.md

Guidance for anyone, human or agent, working in this repository. Read it before changing code.

## Product

Hekate is an open-source (AGPL-3.0), self-hosted media review and approval system: a sovereign alternative to Dropbox Replay and Frame.io.

- **Music first, never music only.** Classical music is first-class (tracks with versions and variations, bar numbers, score pages, session takes, a recording synced to its score). Video and general documents must work just as well. Nothing in the interface or the copy should make Hekate feel like a classical-music-only tool.
- **Launch priority:** the music review experience.
- **Fresh start.** There is no data migration from the legacy application, and no code, names or branding carry over from it.
- **Multi-tenancy from day one.** Every tenant-owned table has an `organisation_id`. Every query is scoped to an organisation. A hosted offering may follow; nothing should need rewriting for it.

## Core model

The vocabulary is fixed and defined in `docs/domain.md`. Read it before naming anything.

- **Project** contains **folders** and **files** of any kind. The **profile** (`music`, `video`, `general`) only decides which tools appear.
- **Track** (a piece of music) has **versions** (successive edits, numbered), and each version has one or more **variations** (files differing in treatment, such as dry and wet mixes; one is primary).
- **Take** means a recording-session snippet and nothing else. Takes are grouped in **sessions** and hold one file per microphone plus an optional summed mix. They are reference material for producers and editors, not versions.
- There are no movements.
- **Comments** belong to a file and may carry an **anchor**: `time` (range or frame), `region` (normalised rectangle on a page or frame) or `bar` (bar and beat, or bar range). Anchors are defined once in `packages/shared`.
- **Reviews** are either an **approval** (each reviewer records a logged *Approved* or *Changes requested*) or **feedback** (comments, no formal sign-off). Reviewers are members, **guests** (external, no account) or **groups**, all at once or in order.
- **Workflows** (stages, statuses, transitions, notifications) are built per project and overridable per track. **Roles** and their permissions are configurable per project.

## Stack (decided; do not substitute without discussion)

TypeScript end to end. React, Vite, TanStack Router and Query, shadcn/ui on Tailwind (heavily restyled, never stock). Hono API with shared types. PostgreSQL with Drizzle. pg-boss for jobs. A built-in ffmpeg worker. Vidstack, wavesurfer.js and pdf.js for media. Better Auth. Multiple storage backends (local disk, S3-compatible). Deployed as one app image plus PostgreSQL and Caddy via Docker Compose. Not Next.js.

## Repository

pnpm workspace.

| Path | Purpose |
| --- | --- |
| `apps/server` | Hono API. Also serves the built web app and runs job workers in production. |
| `apps/web` | React single-page app. |
| `packages/shared` | Domain types and zod schemas shared by server and web. No runtime dependencies beyond zod. |
| `packages/db` | Drizzle schema, migrations and client. Server-only. |
| `packages/storage` | Storage backends (local disk, S3) behind one interface, with a shared conformance suite. Server-only. |
| `brand/` | Mark, wordmark and icons. SVG is the source of truth. |
| `docs/` | Decisions (`docs/decisions.md`) and the brand system (`docs/brand.md`). |
| `deploy/` | Compose files and Caddy configuration. |

Commands:

```sh
pnpm install
pnpm dev          # server and web in watch mode
pnpm check        # lint + typecheck + test, run before every commit
pnpm build
pnpm db:generate  # create a migration after changing the schema
pnpm db:migrate
```

## Toolchain and supply chain

- Node.js 26, pnpm 12 (pinned in `packageManager`), PostgreSQL 18. Keep everything on its latest release; Dependabot opens weekly grouped updates.
- pnpm refuses versions published less than a day ago (`minimumReleaseAge`) and runs install scripts only for packages in `allowBuilds`.
- GitHub Actions are pinned to commit SHAs with the version in a comment.
- Trivy scans the repository and the image in CI and fails on fixable high or critical findings.
- Releases: Conventional Commits drive Release Please, which opens the release PR and writes `CHANGELOG.md`.

## Conventions

- **Language:** British English everywhere: code comments, docs, UI copy, commit messages (colour, organisation, licence as a noun, behaviour).
- **Punctuation:** never use em-dashes. Use commas, colons, semicolons or parentheses.
- **Branches:** the default branch is `master`, which is protected: every change lands through a pull request with green CI. Include screenshots in pull requests for visual work.
- **Order:** build from the ground up; finish and test each layer before building on it.
- **Commits:** Conventional Commits (`feat(web): …`, `fix(server): …`, `chore: …`). Small and focused.
- **Types:** strict TypeScript. No `any` without a comment explaining why. Validate every request body with the shared zod schemas.
- **Tenancy:** never write a query against a tenant-owned table without an `organisation_id` condition.
- **Identifiers:** UUIDv7 primary keys, generated in the application.
- **Time:** store timestamps as `timestamptz`; media positions as seconds (double) plus an optional frame number.
- **Runtime:** the server runs its TypeScript sources directly with Node's type stripping (no build step). Use `.ts` extensions in relative imports and only erasable syntax: no `enum`, `namespace` or parameter properties.
- **Tests:** Vitest. API tests run against a real PostgreSQL when `DATABASE_URL` is set (CI provides one). Put domain logic in pure functions and test them.
- **Privacy:** do not record personal names, email addresses or other personal details of contributors in files, commits or docs. The maintainer is known only as DonQuinleone.

## Media security

Unreleased material is the product's cargo. Read `docs/security.md` before touching storage, delivery or players.

- Never add a route that returns a stored file, or a URL that works outside the viewer's session. Media goes through the protected delivery path (encrypted segments, signed short-lived URLs, a session-bound key endpoint).
- Originals reach a browser only through the download permission, watermarked per recipient, and logged.
- Files are encrypted at rest with per-file keys; storage holds ciphertext only.
- Log every key issue, page render and download in the access log.

## Design system

See `docs/brand.md` for the full system. In short: dark, modern, understated. Near-black ground, one signal colour used sparingly, hairlines over cards and shadows, type doing the work, no ornament. The mark is two stems and a point. Use the CSS tokens in `apps/web/src/styles/tokens.css`; do not hard-code colours.

## Review guidelines

For anyone reviewing a pull request, human or agent. Review against this file and `docs/`; they are the source of truth. Report what is wrong and why, with the file and line, and suggest a fix. Do not restate the diff or praise it.

### Blocking: flag these as high priority

- **Tenancy.** Any read, update or delete on a tenant-owned table without an `organisation_id` condition (use `inOrg`). A new tenant table without `organisation_id`, or one added to `globalTables` without a clear reason. An organisation id taken from the request body or path instead of the session (`c.var.organisationId`).
- **Authorisation.** A route under `/api` that skips `requireSession` and `requireOrganisation` without being deliberately public. Role checks missing on actions that change members, invitations, settings or content, or checks done in the web app only. Members able to act on another organisation's ids.
- **Media security** (`docs/security.md`). A route or URL that returns a stored file or original media; presigned or public storage URLs reaching a browser; plaintext written to storage once encryption at rest exists; keys or segment URLs that are long-lived or not bound to the session; key issues, page renders or downloads not written to the access log.
- **Secrets and personal data.** Credentials, tokens or keys in code, tests, fixtures, logs or error messages. Real names, email addresses or other personal details of contributors anywhere in the repository. Tokens stored in the database without hashing where a hash would do.
- **Input validation.** A request body, query or parameter used without a zod schema. Shared shapes defined twice instead of in `packages/shared`.
- **Data safety.** A migration that drops or rewrites data without saying so in the pull request; schema changes without a generated migration; a migration edited after it has merged.
- **Supply chain.** New dependencies that are unmaintained, duplicate an existing one, or need install scripts (only `allowBuilds` packages may run them). Actions not pinned to a commit SHA. Anything that weakens `minimumReleaseAge`, Trivy or the CI checks. Build tools or package managers added to the runtime image.
- **Correctness.** Races in check-then-act code (claims, invitations, approvals) that should be atomic or transactional; unhandled promise rejections; streams not closed or errors swallowed.

### Important: flag these too

- **Vocabulary.** Names that contradict `docs/domain.md`: project, folder, file, track, version, variation, take, session, comment, anchor, review, workflow. There are no movements; takes are never versions.
- **Tests.** New behaviour without a test, especially tenancy and permission rules (prove another organisation and a lesser role are refused). Domain logic that belongs in a pure, tested function.
- **Runtime.** Non-erasable TypeScript in server code (`enum`, `namespace`, parameter properties) or relative imports without `.ts`; `any` without a comment.
- **Design system.** Hard-coded colours instead of tokens; stock shadcn styling; copy or UI that makes Hekate read as a classical-music-only tool.
- **Pull request hygiene.** Visual changes without screenshots; titles that are not Conventional Commits.

### Style: mention once, never block

- British English (colour, organisation, licence as a noun, behaviour) in code, comments, docs and UI copy.
- No em-dashes anywhere; use commas, colons, semicolons or parentheses.

### Not worth a comment

Formatting and import order (Biome enforces them), personal preference between equivalent approaches, and speculative problems with no realistic path from a caller or input. Do not ask for features outside the pull request's issue.
