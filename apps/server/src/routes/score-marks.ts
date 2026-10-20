import { type Database, inOrg, schema } from "@hekate/db";
import {
  defaultScoreMarkCategories,
  editPlot,
  pdfPages,
  type ScoreMark,
  type ScoreMarkCategory,
  type ScoreMarkKind,
  scoreMarkCategoryInput,
  scoreMarkChangeInput,
  scoreMarkInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, max, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projects, scoreMarkCategories, scoreMarks, takes, tracks, users, workTracks, works } =
  schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
/** The kinds that name a take. */
const takesNamed: ScoreMarkKind[] = ["edit", "take-start", "take-end", "punch-in"];
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function trackOf(db: Database, organisationId: string, id: string) {
  const [track] = await db
    .select({ id: tracks.id, projectId: tracks.projectId })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
  if (!track) throw new NotFound("Track");
  return track;
}

/** A project's score categories, given their defaults the first time, under the project lock. */
async function seedScoreCategories(tx: Tx, organisationId: string, projectId: string) {
  const [project] = await tx
    .select({ seeded: projects.scoreCategoriesSeeded })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .for("update");
  if (!project || project.seeded) return;
  await tx.insert(scoreMarkCategories).values(
    defaultScoreMarkCategories.map((c, position) => ({
      organisationId,
      projectId,
      ...c,
      position,
    })),
  );
  await tx
    .update(projects)
    .set({ scoreCategoriesSeeded: true })
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
}

async function categoriesOf(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<ScoreMarkCategory[]> {
  await db.transaction((tx) => seedScoreCategories(tx, organisationId, projectId));
  const rows = await db
    .select()
    .from(scoreMarkCategories)
    .where(inOrg(scoreMarkCategories, organisationId, eq(scoreMarkCategories.projectId, projectId)))
    .orderBy(asc(scoreMarkCategories.position), asc(scoreMarkCategories.name));
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    colour: c.colour as ScoreMarkCategory["colour"],
    key: c.key,
    position: c.position,
  }));
}

function shapeOf(row: typeof scoreMarks.$inferSelect, name: string | null): ScoreMark {
  return {
    id: row.id,
    kind: row.kind as ScoreMarkKind,
    page: row.page,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    points: row.points,
    barFrom: row.barFrom,
    barTo: row.barTo,
    text: row.text,
    categoryId: row.categoryId,
    takes: row.takes,
    fixedBy: row.fixedBy,
    resolved: row.resolvedAt !== null,
    from: row.fromTake,
    to: row.toTake,
    overdub: row.overdub,
    by: row.createdById ? { id: row.createdById, name: name ?? "" } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A category of the track's project, or refused: never another project's or workspace's. */
async function checkCategory(
  tx: Tx,
  organisationId: string,
  projectId: string,
  categoryId: string | null | undefined,
) {
  if (!categoryId) return;
  const [category] = await tx
    .select({ id: scoreMarkCategories.id })
    .from(scoreMarkCategories)
    .where(
      inOrg(
        scoreMarkCategories,
        organisationId,
        eq(scoreMarkCategories.id, categoryId),
        eq(scoreMarkCategories.projectId, projectId),
      ),
    );
  if (!category) throw new NotFound("Category");
}

/**
 * A track's score marks (#52), under `/api/tracks/:id/score-marks`: every mark, the project's
 * categories of issue, and the edit plot check over the track's T-edits. Seeing them needs
 * `view_production`; making one, `edit_production`.
 */
export const trackScoreMarkRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/score-marks", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const track = await trackOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "view_production", track.projectId);
      const rows = await db
        .select({ mark: scoreMarks, name: users.name })
        .from(scoreMarks)
        .leftJoin(users, eq(users.id, scoreMarks.createdById))
        .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.trackId, track.id)))
        .orderBy(asc(scoreMarks.page), asc(scoreMarks.createdAt));
      const marks = rows.map((r) => shapeOf(r.mark, r.name));
      // Only takes that were recorded: one aborted, or still rolling, is no take to edit from.
      const recorded = await db
        .select({ number: takes.number })
        .from(takes)
        .where(
          inOrg(
            takes,
            organisationId,
            eq(takes.trackId, track.id),
            eq(takes.lifecycle, "recorded"),
          ),
        );
      // Where the track starts in its work's score (#48), for the score to open at its pages.
      const [placed] = await db
        .select({
          pageFrom: workTracks.pageFrom,
          pageTo: workTracks.pageTo,
          pageOffset: works.pageOffset,
        })
        .from(workTracks)
        .innerJoin(works, eq(works.id, workTracks.workId))
        .where(
          inOrg(
            workTracks,
            organisationId,
            eq(workTracks.trackId, track.id),
            eq(works.organisationId, organisationId),
          ),
        );
      return c.json({
        marks,
        categories: await categoriesOf(db, organisationId, track.projectId),
        plot: editPlot(marks, new Set(recorded.map((t) => t.number))),
        pages: placed ? pdfPages(placed, placed.pageOffset) : null,
      });
    })
    .post("/:id/score-marks", idParam, zValidator("json", scoreMarkInput), async (c) => {
      const organisationId = c.var.organisationId;
      const track = await trackOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_production", track.projectId);
      const input = c.req.valid("json");
      const row = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, track.projectId);
        await checkCategory(tx, organisationId, track.projectId, input.categoryId);
        const [made] = await tx
          .insert(scoreMarks)
          .values({
            organisationId,
            trackId: track.id,
            kind: input.kind,
            page: input.page,
            x: input.x,
            y: input.y,
            width: input.width ?? null,
            height: input.height ?? null,
            points: input.points ?? null,
            barFrom: input.barFrom ?? null,
            barTo: input.barTo ?? null,
            text: input.text || null,
            categoryId: input.kind === "issue" ? (input.categoryId ?? null) : null,
            takes: input.takes ?? [],
            fixedBy: input.fixedBy ?? null,
            resolvedAt: input.resolved ? new Date() : null,
            fromTake: input.from ?? null,
            toTake: input.to ?? null,
            overdub: input.overdub ?? false,
            createdById: c.var.userId,
          })
          .returning();
        return made;
      });
      if (!row) throw new NotFound("Mark");
      return c.json({ mark: shapeOf(row, null) }, 201);
    });

/** `/api/score-marks/:id`: changing a mark, or rubbing it out. */
export const scoreMarkRoutes = (db: Database) => {
  const markOf = async (organisationId: string, id: string) => {
    const [found] = await db
      .select({ mark: scoreMarks, projectId: tracks.projectId })
      .from(scoreMarks)
      .innerJoin(
        tracks,
        and(eq(tracks.id, scoreMarks.trackId), eq(tracks.organisationId, organisationId)),
      )
      .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.id, id)));
    if (!found) throw new NotFound("Mark");
    return found;
  };
  return new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", scoreMarkChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const found = await markOf(organisationId, id);
      await can(db, actorOf(c.var), "edit_production", found.projectId);
      const { resolved, from, to, categoryId, ...rest } = c.req.valid("json");
      const next = {
        barFrom: rest.barFrom === undefined ? found.mark.barFrom : rest.barFrom,
        barTo: rest.barTo === undefined ? found.mark.barTo : rest.barTo,
      };
      if (next.barFrom != null && next.barTo != null && next.barFrom > next.barTo)
        throw new HTTPException(422, { message: "The bars run forwards" });
      // What each kind needs holds after the change as when it was made.
      const kind = found.mark.kind as ScoreMarkKind;
      const nextTo = to === undefined ? found.mark.toTake : to;
      const nextText = rest.text === undefined ? found.mark.text : rest.text;
      if (takesNamed.includes(kind) && nextTo == null)
        throw new HTTPException(422, {
          message: kind === "edit" ? "Say which take the edit goes into" : "Say which take",
        });
      if ((kind === "dynamic" || kind === "note") && !nextText)
        throw new HTTPException(422, { message: "Write what it says" });
      const row = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, found.projectId);
        await checkCategory(tx, organisationId, found.projectId, categoryId);
        const [changed] = await tx
          .update(scoreMarks)
          .set({
            ...rest,
            ...(rest.text !== undefined ? { text: rest.text || null } : {}),
            ...(categoryId !== undefined && found.mark.kind === "issue" ? { categoryId } : {}),
            ...(from !== undefined ? { fromTake: from } : {}),
            ...(to !== undefined ? { toTake: to } : {}),
            ...(resolved !== undefined
              ? { resolvedAt: resolved ? (found.mark.resolvedAt ?? new Date()) : null }
              : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.id, id)))
          .returning();
        return changed;
      });
      if (!row) throw new NotFound("Mark");
      return c.json({ mark: shapeOf(row, null) });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const found = await markOf(organisationId, id);
      await can(db, actorOf(c.var), "edit_production", found.projectId);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, found.projectId);
        await tx.delete(scoreMarks).where(inOrg(scoreMarks, organisationId, eq(scoreMarks.id, id)));
      });
      return c.body(null, 204);
    });
};

/**
 * A category's name and key are its project's alone: two categories are not both "Noise", nor
 * both on key 3. Checked under the project's lock, so two changes at once cannot both pass.
 */
async function checkCategoryFree(
  tx: Tx,
  organisationId: string,
  projectId: string,
  input: { name: string; key: string | null },
  except?: string,
) {
  const others = await tx
    .select({ name: scoreMarkCategories.name, key: scoreMarkCategories.key })
    .from(scoreMarkCategories)
    .where(
      inOrg(
        scoreMarkCategories,
        organisationId,
        eq(scoreMarkCategories.projectId, projectId),
        except ? ne(scoreMarkCategories.id, except) : undefined,
        sql`(lower(${scoreMarkCategories.name}) = lower(${input.name})${
          input.key ? sql` or ${scoreMarkCategories.key} = ${input.key}` : sql``
        })`,
      ),
    );
  const named = others.find((o) => o.name.toLowerCase() === input.name.toLowerCase());
  if (named) throw new HTTPException(409, { message: "A category with that name exists" });
  const keyed = others.find((o) => input.key && o.key === input.key);
  if (keyed) throw new HTTPException(409, { message: `Key ${input.key} is ${keyed.name}'s` });
}

/**
 * `/api/projects/:id/score-categories`: a project's categories of score issue (#52), for those
 * who see the production tools; adding one belongs to those who use them.
 */
export const projectScoreCategoryRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/score-categories", idParam, async (c) => {
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({ categories: await categoriesOf(db, c.var.organisationId, projectId) });
    })
    .post(
      "/:id/score-categories",
      idParam,
      zValidator("json", scoreMarkCategoryInput),
      async (c) => {
        const organisationId = c.var.organisationId;
        const { projectId } = await can(
          db,
          actorOf(c.var),
          "edit_production",
          c.req.valid("param").id,
        );
        const input = c.req.valid("json");
        const made = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          await seedScoreCategories(tx, organisationId, projectId);
          await checkCategoryFree(tx, organisationId, projectId, input);
          const [last] = await tx
            .select({ position: max(scoreMarkCategories.position) })
            .from(scoreMarkCategories)
            .where(
              inOrg(
                scoreMarkCategories,
                organisationId,
                eq(scoreMarkCategories.projectId, projectId),
              ),
            );
          const [row] = await tx
            .insert(scoreMarkCategories)
            .values({ organisationId, projectId, ...input, position: (last?.position ?? -1) + 1 })
            .returning();
          return row;
        });
        return c.json({ category: made }, 201);
      },
    );

/** `/api/score-categories/:id`: renaming, recolouring or re-keying a category, or removing it. */
export const scoreCategoryRoutes = (db: Database) => {
  const categoryOf = async (organisationId: string, id: string) => {
    const [category] = await db
      .select({ id: scoreMarkCategories.id, projectId: scoreMarkCategories.projectId })
      .from(scoreMarkCategories)
      .where(inOrg(scoreMarkCategories, organisationId, eq(scoreMarkCategories.id, id)));
    if (!category) throw new NotFound("Category");
    return category;
  };
  return (
    new Hono<{ Variables: TenantVariables }>()
      .patch("/:id", idParam, zValidator("json", scoreMarkCategoryInput), async (c) => {
        const organisationId = c.var.organisationId;
        const category = await categoryOf(organisationId, c.req.valid("param").id);
        await can(db, actorOf(c.var), "edit_production", category.projectId);
        const input = c.req.valid("json");
        const updated = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, category.projectId);
          await checkCategoryFree(tx, organisationId, category.projectId, input, category.id);
          const [row] = await tx
            .update(scoreMarkCategories)
            .set({ ...input, updatedAt: new Date() })
            .where(
              inOrg(scoreMarkCategories, organisationId, eq(scoreMarkCategories.id, category.id)),
            )
            .returning();
          return row;
        });
        return c.json({ category: updated });
      })
      // Its issues stay, without a category.
      .delete("/:id", idParam, async (c) => {
        const organisationId = c.var.organisationId;
        const category = await categoryOf(organisationId, c.req.valid("param").id);
        await can(db, actorOf(c.var), "edit_production", category.projectId);
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, category.projectId);
          await tx
            .delete(scoreMarkCategories)
            .where(
              inOrg(scoreMarkCategories, organisationId, eq(scoreMarkCategories.id, category.id)),
            );
        });
        return c.body(null, 204);
      })
  );
};
