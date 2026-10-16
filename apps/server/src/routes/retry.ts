import { type Database, inOrg, schema } from "@hekate/db";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { Jobs } from "../jobs.ts";
import { pageSourceOf } from "../media/pages.ts";
import { retryPlan } from "../media/retry.ts";

const { files } = schema;

/**
 * `/api/files/:id/retry`: prepare a file again after its preparation failed. For members
 * who may upload to its project, as they could replace it anyway.
 */
export const fileRetryRoutes = (db: Database, jobs: Pick<Jobs, "send">) =>
  new Hono<{ Variables: ViewerVariables }>().post(
    "/:id/retry",
    zValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") {
        throw new HTTPException(403, { message: "Guests cannot prepare files" });
      }
      const fileId = c.req.valid("param").id;
      await canOnFile(db, actor, "upload", fileId);
      const organisationId = actor.organisationId;
      // Under the row lock, so two retries at once start the work once.
      const plan = await db.transaction(async (tx) => {
        const [file] = await tx
          .select({
            kind: files.kind,
            name: files.name,
            contentType: files.contentType,
            mediaInfo: files.mediaInfo,
            streamStatus: files.streamStatus,
            analysisStatus: files.analysisStatus,
          })
          .from(files)
          .where(inOrg(files, organisationId, eq(files.id, fileId)))
          .for("update");
        if (!file) throw new NotFound("File");
        const next = retryPlan({
          ...file,
          drawn: pageSourceOf(file.name, file.contentType) !== null,
        });
        if (!next) throw new HTTPException(409, { message: "Nothing about this file failed" });
        await tx
          .update(files)
          .set({ ...next.set, updatedAt: new Date() })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
        return next;
      });
      for (const job of plan.jobs) {
        await jobs.send(job, { organisationId, fileId }, { singletonKey: fileId });
      }
      return c.json({ jobs: plan.jobs }, 202);
    },
  );
