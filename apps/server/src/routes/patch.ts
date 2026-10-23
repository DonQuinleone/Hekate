import { type Database, inOrg, schema } from "@hekate/db";
import {
  nextChannel,
  type PatchRow,
  patchRowChangeInput,
  patchRowInput,
  type StageBox,
  stageBoxInput,
} from "@hekate/shared";
import { asc, eq, inArray, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import { textPdfOf } from "../media/pdf.ts";
import { zValidator } from "../openapi/validator.ts";
import { PATCH_PAGE, patchListPages } from "../patch-pdf.ts";
import type { TenantVariables } from "../tenancy.ts";
import { xlsxOf } from "../xlsx.ts";
import { attachment } from "./comments.ts";

const { patchRows, projects, stageBoxes } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

const boxTaken = () =>
  new HTTPException(409, { message: "Another stage box in this project has that name" });
const channelTaken = (channel: number, direction: string) =>
  new HTTPException(409, {
    message: `${direction === "input" ? "Input" : "Output"} ${channel} of this box is already patched`,
  });

const rowShape = {
  id: patchRows.id,
  channel: patchRows.channel,
  source: patchRows.source,
  device: patchRows.device,
  cable: patchRows.cable,
  notes: patchRows.notes,
};

/** A project's patch list: its stage boxes in order, each with its inputs and outputs. */
export async function patchListOf(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<StageBox[]> {
  const boxes = await db
    .select({ id: stageBoxes.id, name: stageBoxes.name })
    .from(stageBoxes)
    .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.projectId, projectId)))
    .orderBy(asc(stageBoxes.position), asc(stageBoxes.createdAt));
  if (boxes.length === 0) return [];
  const rows = await db
    .select({ ...rowShape, stageBoxId: patchRows.stageBoxId, direction: patchRows.direction })
    .from(patchRows)
    .where(
      inOrg(
        patchRows,
        organisationId,
        inArray(
          patchRows.stageBoxId,
          boxes.map((b) => b.id),
        ),
      ),
    )
    .orderBy(asc(patchRows.channel));
  const of = (boxId: string, direction: "input" | "output"): PatchRow[] =>
    rows
      .filter((r) => r.stageBoxId === boxId && r.direction === direction)
      .map(({ stageBoxId: _box, direction: _dir, ...row }) => row);
  return boxes.map((b) => ({ ...b, inputs: of(b.id, "input"), outputs: of(b.id, "output") }));
}

/** A patch list's sheets for a workbook: a sheet a stage box, inputs then outputs. */
export function patchSheets(boxes: StageBox[]) {
  return boxes.map((b) => ({
    name: b.name,
    rows: [
      ["In or out", "Channel", "Source", "Device", "Cable", "Notes"],
      ...(["input", "output"] as const).flatMap((direction) =>
        (direction === "input" ? b.inputs : b.outputs).map((r) => [
          direction === "input" ? "In" : "Out",
          r.channel,
          r.source,
          r.device,
          r.cable,
          r.notes,
        ]),
      ),
    ],
  }));
}

/** An export is for whoever asked: nothing between them and it keeps a copy. */
const PRIVATE = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };

/**
 * `/api/projects/:id/patch` and `/api/projects/:id/stage-boxes` (#54): the patch list, for
 * those who see the production tools, as a PDF or a workbook too, and adding a stage box, for
 * those who use them.
 */
export const projectPatchRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/patch/:format{pdf|xlsx}", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
      const boxes = await patchListOf(db, organisationId, projectId);
      const name = `${project?.name ?? "Project"} patch list`;
      if (c.req.param("format") === "xlsx") {
        const bytes = xlsxOf(
          boxes.length > 0 ? patchSheets(boxes) : [{ name: "Patch list", rows: [] }],
        );
        return c.body(new Uint8Array(bytes), 200, {
          ...PRIVATE,
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": attachment(`${name}.xlsx`),
        });
      }
      const pdf = textPdfOf(
        patchListPages(project?.name ?? "Project", boxes).map((content) => ({
          points: PATCH_PAGE,
          content,
        })),
      );
      return c.body(new Uint8Array(pdf), 200, {
        ...PRIVATE,
        "content-type": "application/pdf",
        "content-disposition": attachment(`${name}.pdf`),
      });
    })
    .get("/:id/patch", idParam, async (c) => {
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({ boxes: await patchListOf(db, c.var.organisationId, projectId) });
    })
    .post("/:id/stage-boxes", idParam, zValidator("json", stageBoxInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      const { name } = c.req.valid("json");
      try {
        const box = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          const [last] = await tx
            .select({ position: max(stageBoxes.position) })
            .from(stageBoxes)
            .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.projectId, projectId)));
          const [made] = await tx
            .insert(stageBoxes)
            .values({ organisationId, projectId, name, position: (last?.position ?? -1) + 1 })
            .returning({ id: stageBoxes.id, name: stageBoxes.name });
          return made;
        });
        return c.json({ box: { ...box, inputs: [], outputs: [] } }, 201);
      } catch (error) {
        if (violates(error, "stage_boxes_name_idx")) throw boxTaken();
        throw error;
      }
    });

/** The stage box, and the project it belongs to, for someone who may change the patch list. */
async function boxFor(db: Database, vars: TenantVariables, id: string) {
  const [box] = await db
    .select({ id: stageBoxes.id, projectId: stageBoxes.projectId })
    .from(stageBoxes)
    .where(inOrg(stageBoxes, vars.organisationId, eq(stageBoxes.id, id)));
  if (!box) throw new NotFound("Stage box");
  await can(db, actorOf(vars), "edit_production", box.projectId);
  return box;
}

/** `/api/stage-boxes/:id`: renaming a stage box, removing it, and patching a channel on it. */
export const stageBoxRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", stageBoxInput), async (c) => {
      const organisationId = c.var.organisationId;
      const box = await boxFor(db, c.var, c.req.valid("param").id);
      try {
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, box.projectId);
          await tx
            .update(stageBoxes)
            .set({ name: c.req.valid("json").name, updatedAt: new Date() })
            .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.id, box.id)));
        });
      } catch (error) {
        if (violates(error, "stage_boxes_name_idx")) throw boxTaken();
        throw error;
      }
      const [listed] = (await patchListOf(db, organisationId, box.projectId)).filter(
        (b) => b.id === box.id,
      );
      return c.json({ box: listed });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const box = await boxFor(db, c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, box.projectId);
        await tx
          .delete(stageBoxes)
          .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.id, box.id)));
      });
      return c.body(null, 204);
    })
    .post("/:id/rows", idParam, zValidator("json", patchRowInput), async (c) => {
      const organisationId = c.var.organisationId;
      const box = await boxFor(db, c.var, c.req.valid("param").id);
      const { direction, channel, ...row } = c.req.valid("json");
      let given = channel;
      try {
        const made = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, box.projectId);
          // The box locked, so two channels added at once are numbered one after the other.
          await tx
            .select({ id: stageBoxes.id })
            .from(stageBoxes)
            .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.id, box.id)))
            .for("update");
          if (given === undefined) {
            const taken = await tx
              .select({ channel: patchRows.channel })
              .from(patchRows)
              .where(
                inOrg(
                  patchRows,
                  organisationId,
                  eq(patchRows.stageBoxId, box.id),
                  eq(patchRows.direction, direction),
                ),
              );
            given = nextChannel(taken);
          }
          const [inserted] = await tx
            .insert(patchRows)
            .values({ organisationId, stageBoxId: box.id, direction, channel: given, ...row })
            .returning(rowShape);
          return inserted;
        });
        return c.json({ row: made }, 201);
      } catch (error) {
        if (violates(error, "patch_rows_channel_idx")) throw channelTaken(given ?? 0, direction);
        throw error;
      }
    });

/** `/api/patch-rows/:id`: changing a channel, or unpatching it. */
export const patchRowRoutes = (db: Database) => {
  const rowFor = async (vars: TenantVariables, id: string) => {
    const [row] = await db
      .select({
        id: patchRows.id,
        direction: patchRows.direction,
        projectId: stageBoxes.projectId,
      })
      .from(patchRows)
      .innerJoin(stageBoxes, eq(stageBoxes.id, patchRows.stageBoxId))
      // Both tables in the workspace: the box's project decides who may change the channel.
      .where(
        inOrg(
          patchRows,
          vars.organisationId,
          eq(patchRows.id, id),
          eq(stageBoxes.organisationId, vars.organisationId),
        ),
      );
    if (!row) throw new NotFound("Channel");
    await can(db, actorOf(vars), "edit_production", row.projectId);
    return row;
  };
  return new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", patchRowChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(c.var, c.req.valid("param").id);
      const change = c.req.valid("json");
      try {
        const changed = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, row.projectId);
          const [updated] = await tx
            .update(patchRows)
            .set({ ...change, updatedAt: new Date() })
            .where(inOrg(patchRows, organisationId, eq(patchRows.id, row.id)))
            .returning(rowShape);
          return updated;
        });
        return c.json({ row: changed });
      } catch (error) {
        if (violates(error, "patch_rows_channel_idx"))
          throw channelTaken(change.channel ?? 0, row.direction);
        throw error;
      }
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx
          .delete(patchRows)
          .where(inOrg(patchRows, organisationId, eq(patchRows.id, row.id)));
      });
      return c.body(null, 204);
    });
};
