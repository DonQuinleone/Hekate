# AGENTS.md

Guidance for anyone, human or agent, working in this repository. Read it before changing code.

## Product

Hekate is an open-source (AGPL-3.0), self-hosted media review and approval system: a sovereign alternative to Dropbox Replay and Frame.io.

- **Music first, never music only.** Classical music is first-class (bar numbers, score pages, tracks, movements, takes, a recording synced to its score). Video and general documents must work just as well. Nothing in the interface or the copy should make Hekate feel like a classical-music-only tool.
- **Launch priority:** the music review experience.
- **Fresh start.** There is no data migration from the legacy application, and no code, names or branding carry over from it.
- **Multi-tenancy from day one.** Every tenant-owned table has an `organisation_id`. Every query is scoped to an organisation. A hosted offering may follow; nothing should need rewriting for it.

## Core model

- **Organisation** owns members, projects and storage.
- **Project** has a **profile**: `music`, `video` or `general`. The profile decides which tools and anchor types appear; the underlying model is shared.
- **Asset** is a piece of media in a project (recording, video, score PDF, document). An asset has **versions** (takes, mixes, cuts). One version can be approved.
- **Comment** always has an **anchor**. Anchor kinds:
  - `time`: a range in seconds (an instant when start equals end), optionally with a frame number.
  - `region`: a rectangle on a PDF page or a video frame, in normalised 0 to 1 coordinates.
  - `bar`: a bar and beat, or a range of bars, in a score-synced recording.
  - `section`: a track or movement.
  Anchors are defined once in `packages/shared` and validated on both sides of the wire.

## Stack (decided; do not substitute without discussion)

TypeScript end to end. React, Vite, TanStack Router and Query, shadcn/ui on Tailwind (heavily restyled, never stock). Hono API with shared types. PostgreSQL with Drizzle. pg-boss for jobs. A built-in ffmpeg worker. Vidstack, wavesurfer.js and pdf.js for media. Better Auth. Local storage with optional S3. Deployed as one app image plus PostgreSQL and Caddy via Docker Compose. Not Next.js.

## Repository

pnpm workspace.

| Path | Purpose |
| --- | --- |
| `apps/server` | Hono API. Also serves the built web app and runs job workers in production. |
| `apps/web` | React single-page app. |
| `packages/shared` | Domain types and zod schemas shared by server and web. No runtime dependencies beyond zod. |
| `packages/db` | Drizzle schema, migrations and client. Server-only. |
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

## Conventions

- **Language:** British English everywhere: code comments, docs, UI copy, commit messages (colour, organisation, licence as a noun, behaviour).
- **Punctuation:** never use em-dashes. Use commas, colons, semicolons or parentheses.
- **Branches:** the default branch is `master`.
- **Commits:** Conventional Commits (`feat(web): …`, `fix(server): …`, `chore: …`). Small and focused.
- **Types:** strict TypeScript. No `any` without a comment explaining why. Validate every request body with the shared zod schemas.
- **Tenancy:** never write a query against a tenant-owned table without an `organisation_id` condition.
- **Identifiers:** UUIDv7 primary keys, generated in the application.
- **Time:** store timestamps as `timestamptz`; media positions as seconds (double) plus an optional frame number.
- **Runtime:** the server runs its TypeScript sources directly with Node's type stripping (no build step). Use `.ts` extensions in relative imports and only erasable syntax: no `enum`, `namespace` or parameter properties.
- **Tests:** Vitest. API tests run against a real PostgreSQL when `DATABASE_URL` is set (CI provides one). Put domain logic in pure functions and test them.
- **Privacy:** do not record personal names, email addresses or other personal details of contributors in files, commits or docs. The maintainer is known only as DonQuinleone.

## Design system

See `docs/brand.md` for the full system. In short: dark, modern, understated. Near-black ground, one signal colour used sparingly, hairlines over cards and shadows, type doing the work, no ornament. The mark is two stems and a point. Use the CSS tokens in `apps/web/src/styles/tokens.css`; do not hard-code colours.
