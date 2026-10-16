import { type Database, inOrg, schema } from "@hekate/db";
import type { SearchResponse, SearchResult } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, type Column, desc, eq, ilike, isNull, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, visibleProjects } from "../access.ts";
import { excerpt, prefixQuery } from "../search.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, tracks, files, reviews, comments, members, users, searchVector } = schema;

const searchQuery = zValidator(
  "query",
  z.object({
    q: z.string().trim().min(1).max(200),
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
  new Hono<{ Variables: TenantVariables }>().get("/", searchQuery, async (c) => {
    const { q, limit } = c.req.valid("query");
    const organisationId = c.var.organisationId;
    const query = prefixQuery(q);
    if (!query) return c.json({ results: [] } satisfies SearchResponse);
    const tsq = sql`to_tsquery('simple', ${query})`;
    const seen = visibleProjects(actorOf(c.var));
    const live = (column: Column) =>
      and(eq(projects.id, column), eq(projects.organisationId, organisationId));
    const inLiveProject = and(isNull(projects.archivedAt), seen);
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
    const matches = (vector: SQL) => sql`${vector} @@ ${tsq}`;
    const rank = (vector: SQL) => sql`ts_rank(${vector}, ${tsq})`;

    const [projectRows, trackRows, fileRows, reviewRows, commentRows, people] = await Promise.all([
      db
        .select({ id: projects.id, name: projects.name, profile: projects.profile })
        .from(projects)
        .where(inOrg(projects, organisationId, matches(words.projects), inLiveProject))
        .orderBy(desc(rank(words.projects)), projects.name)
        .limit(limit),
      db
        .select({
          id: tracks.id,
          name: tracks.name,
          projectId: projects.id,
          project: projects.name,
        })
        .from(tracks)
        .innerJoin(projects, live(tracks.projectId))
        .where(inOrg(tracks, organisationId, matches(words.tracks), inLiveProject))
        .orderBy(desc(rank(words.tracks)), tracks.name)
        .limit(limit),
      db
        .select({ id: files.id, name: files.name, projectId: projects.id, project: projects.name })
        .from(files)
        .innerJoin(projects, live(files.projectId))
        .where(inOrg(files, organisationId, matches(words.files), inLiveProject))
        .orderBy(desc(rank(words.files)), files.name)
        .limit(limit),
      db
        .select({
          id: reviews.id,
          title: reviews.title,
          status: reviews.status,
          projectId: projects.id,
          project: projects.name,
        })
        .from(reviews)
        .innerJoin(projects, live(reviews.projectId))
        .where(inOrg(reviews, organisationId, matches(words.reviews), inLiveProject))
        .orderBy(desc(rank(words.reviews)), desc(reviews.createdAt))
        .limit(limit),
      db
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
        .where(inOrg(comments, organisationId, matches(words.comments), inLiveProject))
        .orderBy(desc(rank(words.comments)), desc(comments.createdAt))
        .limit(limit),
      // People are few: a name match is enough, with no index needed.
      db
        .select({ id: users.id, name: users.name, role: members.role })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(inOrg(members, organisationId, ilike(users.name, `%${literal(q)}%`)))
        .orderBy(users.name)
        .limit(limit),
    ]);

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
