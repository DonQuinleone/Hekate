import type { Database } from "@hekate/db";
import { CROOM_MAX_BYTES, type CroomPreview, croomImportQuery } from "@hekate/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { commitImport, existingIn } from "../croom/commit.ts";
import { planImport } from "../croom/plan.ts";
import { CroomError, CroomTooLarge, withCroom } from "../croom/reader.ts";
import { replayFile } from "../croom/replay.ts";
import { CodedException } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import { zValidator } from "../openapi/validator.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";

export interface CroomDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  jobs: Pick<Jobs, "send">;
  trustProxy: boolean;
  /** Scratch space for the file while it is read (WORK_DIR). */
  workDir?: string;
  /** The largest file accepted; CROOM_MAX_BYTES unless a test makes it smaller. */
  maxBytes?: number;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** The paths whose body is a `.croom` file, given their own size limit in `app.ts`. */
export const CROOM_PATH = /^\/api\/projects\/[^/]+\/croom\/(preview|import)$/;

/** A file that could not be read, said as the API says a refusal. */
function refused(error: unknown): never {
  if (error instanceof CroomTooLarge)
    throw new HTTPException(413, { message: "A ControlRoom file can be at most 200 MB" });
  if (error instanceof CroomError) throw new CodedException(422, "invalid_croom", error.message);
  throw error;
}

/**
 * `/api/projects/:id/croom/preview` and `/import` (#57, decision 242): a ControlRoom project
 * file, sent as the request's body, read and shown, then imported. Only those who may manage the
 * project (owners and admins among them) may do either. The file is read from a private scratch
 * file removed as the request ends; nothing of it is kept, so the import sends it again. The
 * preview writes nothing.
 */
export const projectCroomRoutes = (deps: CroomDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .post("/:id/croom/preview", idParam, zValidator("query", croomImportQuery), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        deps.db,
        actorOf(c.var),
        "edit_project",
        c.req.valid("param").id,
      );
      const preview = await withCroom(
        deps.workDir,
        c.req.raw.body,
        deps.maxBytes ?? CROOM_MAX_BYTES,
        async (source) => {
          const { model, report, replayed } = replayFile(source.file);
          const plan = planImport(
            model,
            source.file.blobs,
            await existingIn(deps.db, organisationId, projectId),
            c.req.valid("query").conflicts,
            report,
          );
          const shown: CroomPreview = {
            schemaVersion: source.file.schemaVersion,
            events: { replayed, undone: source.file.undone },
            counts: plan.counts,
            names: plan.names,
            conflicts: plan.conflicts,
            report: report.report(),
          };
          return shown;
        },
      ).catch(refused);
      return c.json({ preview });
    })
    .post("/:id/croom/import", idParam, zValidator("query", croomImportQuery), async (c) => {
      const organisationId = c.var.organisationId;
      const actor = actorOf(c.var);
      const { projectId } = await can(deps.db, actor, "edit_project", c.req.valid("param").id);
      const { conflicts } = c.req.valid("query");
      const imported = await withCroom(
        deps.workDir,
        c.req.raw.body,
        deps.maxBytes ?? CROOM_MAX_BYTES,
        async (source) =>
          commitImport(deps, source, {
            organisationId,
            projectId,
            userId: c.var.userId,
            actor: await deps.audit.actor(actor),
            request: requestInfo(c, deps.trustProxy),
            choice: conflicts,
          }),
      ).catch(refused);
      return c.json({ imported }, 201);
    });
