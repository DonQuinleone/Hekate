import { type Database, inOrg, schema } from "@hekate/db";
import {
  narrowed,
  type SearchKind,
  type SearchResponse,
  type SearchResult,
  savedSearchInput,
  searchFilters,
  sinceDate,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, type Column, desc, eq, gte, ilike, isNull, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, visibleProjects } from "../access.ts";
import { NotFound } from "../errors.ts";
import { excerpt, prefixQuery } from "../search.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, tracks, files, reviews, comments, members, users, savedSearches, searchVector } =
  schema;

const searchQuery = zValidator(
  "query",
  searchFilters.extend({
    q: z.string().trim().max(200).default(""),
    /** Results per kind. */
    limit: z.coerce.number().int().min(1).max(20).default(5),
  }),
);

/** `%` and `_` stand for themselves in a name search. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `/api/search`: projects, tracks, files, reviews, people and comments that match, a few of
 * each, best first. Only this workspace, only live projects, and only those the member may
 * see; a project they cannot see never surfaces, nor anything in it.
 */
export const searchRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    // Saved searches: each person's own, in this workspace.
    .get("/saved", async (c) => {
      const rows = await db
        .select({ id: savedSearches.id, name: savedSearches.name, search: savedSearches.search })
        .from(savedSearches)
        .where(inOrg(savedSearches, c.var.organisationId, eq(savedSearches.userId, c.var.userId)))
        .orderBy(savedSearches.name);
      return c.json({ saved: rows });
    })
    .post("/saved", zValidator("json", savedSearchInput), async (c) => {
      const input = c.req.valid("json");
      const [row] = await db
        .insert(savedSearches)
        .values({
          organisationId: c.var.organisationId,
          userId: c.var.userId,
          name: input.name,
          search: input.search,
        })
        .returning({
          id: savedSearches.id,
          name: savedSearches.name,
          search: savedSearches.search,
        });
      return c.json({ saved: row }, 201);
    })
    .delete("/saved/:id", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const [row] = await db
        .delete(savedSearches)
        .where(
          inOrg(
            savedSearches,
            c.var.organisationId,
            eq(savedSearches.id, c.req.valid("param").id),
            eq(savedSearches.userId, c.var.userId),
          ),
        )
        .returning({ id: savedSearches.id });
      if (!row) throw new NotFound("Saved search");
      return c.body(null, 204);
    })
    .get("/", searchQuery, async (c) => {
      const { q, limit, ...filters } = c.req.valid("query");
      const organisationId = c.var.organisationId;
      const query = prefixQuery(q);
      // Words, filters, or both: with neither there is nothing to look for.
      if (!query && !narrowed(filters)) return c.json({ results: [] } satisfies SearchResponse);
      const tsq = query ? sql`to_tsquery('simple', ${query})` : null;
      const seen = visibleProjects(actorOf(c.var));
      const live = (column: Column) =>
        and(eq(projects.id, column), eq(projects.organisationId, organisationId));
      const inLiveProject = and(
        isNull(projects.archivedAt),
        seen,
        filters.projectId ? eq(projects.id, filters.projectId) : undefined,
      );
      // The same expressions as the search indexes, so each query uses its index.
      const words = {
        projects: searchVector(sql`coalesce(${projects.name}, '')`),
        tracks: searchVector(sql`coalesce(${tracks.name}, '')`),
        files: searchVector(sql`coalesce(${files.name}, '')`),
        reviews: searchVector(
          sql`coalesce(${reviews.title}, '') || ' ' || coalesce(${reviews.message}, '')`,
        ),
        comments: searchVector(sql`coalesce(${comments.body}, '')`),
      };
      const matches = (vector: SQL) => (tsq ? sql`${vector} @@ ${tsq}` : undefined);
      // Best match first; with no words, the newest first.
      const order = (vector: SQL, created: Column) =>
        tsq ? [desc(sql`ts_rank(${vector}, ${tsq})`), desc(created)] : [desc(created)];
      const since = filters.since ? sinceDate(filters.since) : null;
      const after = (created: Column) => (since ? gte(created, since) : undefined);
      const by = (column: Column) => (filters.personId ? eq(column, filters.personId) : undefined);
      // Which kinds the filters leave: a person narrows to what people make, a file kind to files.
      const wanted = (kind: SearchKind) =>
        (!filters.kind || filters.kind === kind) &&
        (!filters.fileKind || kind === "files") &&
        (!filters.personId || kind === "files" || kind === "reviews" || kind === "comments") &&
        (!filters.projectId || kind !== "people");
      const none = Promise.resolve([] as never[]);

      const [projectRows, trackRows, fileRows, reviewRows, commentRows, people] = await Promise.all(
        [
          wanted("projects")
            ? db
                .select({ id: projects.id, name: projects.name })
                .from(projects)
                .where(
                  inOrg(
                    projects,
                    organisationId,
                    matches(words.projects),
                    inLiveProject,
                    after(projects.createdAt),
                  ),
                )
                .orderBy(...order(words.projects, projects.createdAt))
                .limit(limit)
            : none,
          wanted("tracks")
            ? db
                .select({
                  id: tracks.id,
                  name: tracks.name,
                  projectId: projects.id,
                  project: projects.name,
                })
                .from(tracks)
                .innerJoin(projects, live(tracks.projectId))
                .where(
                  inOrg(
                    tracks,
                    organisationId,
                    matches(words.tracks),
                    inLiveProject,
                    after(tracks.createdAt),
                  ),
                )
                .orderBy(...order(words.tracks, tracks.createdAt))
                .limit(limit)
            : none,
          wanted("files")
            ? db
                .select({
                  id: files.id,
                  name: files.name,
                  projectId: projects.id,
                  project: projects.name,
                })
                .from(files)
                .innerJoin(projects, live(files.projectId))
                .where(
                  inOrg(
                    files,
                    organisationId,
                    matches(words.files),
                    inLiveProject,
                    after(files.createdAt),
                    by(files.uploadedBy),
                    filters.fileKind ? eq(files.kind, filters.fileKind) : undefined,
                  ),
                )
                .orderBy(...order(words.files, files.createdAt))
                .limit(limit)
            : none,
          wanted("reviews")
            ? db
                .select({
                  id: reviews.id,
                  title: reviews.title,
                  projectId: projects.id,
                  project: projects.name,
                })
                .from(reviews)
                .innerJoin(projects, live(reviews.projectId))
                .where(
                  inOrg(
                    reviews,
                    organisationId,
                    matches(words.reviews),
                    inLiveProject,
                    after(reviews.createdAt),
                    by(reviews.createdBy),
                  ),
                )
                .orderBy(...order(words.reviews, reviews.createdAt))
                .limit(limit)
            : none,
          wanted("comments")
            ? db
                .select({
                  id: comments.id,
                  body: comments.body,
                  fileId: files.id,
                  file: files.name,
                  projectId: projects.id,
                })
                .from(comments)
                .innerJoin(
                  files,
                  and(eq(files.id, comments.fileId), eq(files.organisationId, organisationId)),
                )
                .innerJoin(projects, live(files.projectId))
                .where(
                  inOrg(
                    comments,
                    organisationId,
                    matches(words.comments),
                    inLiveProject,
                    after(comments.createdAt),
                    by(comments.authorId),
                  ),
                )
                .orderBy(...order(words.comments, comments.createdAt))
                .limit(limit)
            : none,
          // People are few: a name match is enough, with no index needed. With no words, the
          // filters alone list them (by when they joined, if a time is set).
          wanted("people")
            ? db
                .select({ id: users.id, name: users.name, role: members.role })
                .from(members)
                .innerJoin(users, eq(users.id, members.userId))
                .where(
                  inOrg(
                    members,
                    organisationId,
                    q ? ilike(users.name, `%${literal(q)}%`) : undefined,
                    after(members.createdAt),
                  ),
                )
                .orderBy(users.name)
                .limit(limit)
            : none,
        ],
      );

      const results: SearchResult[] = [
        ...projectRows.map(
          (p): SearchResult => ({
            kind: "projects",
            id: p.id,
            label: p.name,
            hint: null,
            link: `/projects/${p.id}`,
            projectId: p.id,
          }),
        ),
        ...trackRows.map(
          (t): SearchResult => ({
            kind: "tracks",
            id: t.id,
            label: t.name,
            hint: t.project,
            link: `/tracks/${t.id}`,
            projectId: t.projectId,
          }),
        ),
        ...fileRows.map(
          (f): SearchResult => ({
            kind: "files",
            id: f.id,
            label: f.name,
            hint: f.project,
            link: `/files/${f.id}`,
            projectId: f.projectId,
          }),
        ),
        ...reviewRows.map(
          (r): SearchResult => ({
            kind: "reviews",
            id: r.id,
            label: r.title,
            hint: r.project,
            link: `/reviews/${r.id}`,
            projectId: r.projectId,
          }),
        ),
        ...people.map(
          (p): SearchResult => ({
            kind: "people",
            id: p.id,
            label: p.name,
            hint: p.role === "member" ? null : p.role === "owner" ? "Owner" : "Admin",
            link: "/settings/members",
            projectId: null,
          }),
        ),
        ...commentRows.map(
          (m): SearchResult => ({
            kind: "comments",
            id: m.id,
            label: excerpt(m.body),
            hint: m.file,
            link: `/files/${m.fileId}`,
            projectId: m.projectId,
          }),
        ),
      ];
      return c.json({ results } satisfies SearchResponse);
    });
