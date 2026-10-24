import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { type Database, schema } from "@hekate/db";
import {
  forensicSettingsInput,
  TRACE_MAX_BYTES,
  TRACE_SECONDS,
  workspaceSettingsOf,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import { forensicStatus, markGroups, tracedResult } from "../forensic.ts";
import type { Keyring } from "../keyring.ts";
import { InvalidMediaError } from "../media/ffmpeg.ts";
import { traceInThread } from "../media/forensic-audio.ts";
import { withWorkspace } from "../media/workspace.ts";
import { zValidator } from "../openapi/validator.ts";
import { admit, tooMany } from "../rate-limit.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { organisations } = schema;

export interface ForensicDeps {
  db: Database;
  keyring: Keyring;
  audit: Audit;
  trustProxy: boolean;
  /** The billing module is on: the workspace's plan decides whether marking is included. */
  billing: boolean;
  /** Scratch space for a suspected leak while it is traced (WORK_DIR). */
  workDir?: string;
}

/** An owner may trace this many files an hour. */
const TRACES_PER_HOUR = 20;

/** A stream that stops once more than `limit` bytes have passed. */
const limited = (limit: number) => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > limit)
        done(new HTTPException(413, { message: "That file is too large to trace" }));
      else done(null, chunk);
    },
  });
};

/**
 * `/api/organisation/forensic` (#32, decision 239): forensic marking for the workspace's
 * owners. Whether recordings' downloads are marked, and tracing a suspected leak: the file
 * is examined in a private workspace and removed when the trace ends; it is never stored. Each
 * trace is in the access log, whatever it found.
 */
export const forensicRoutes = (deps: ForensicDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("owner"))
    .get("/", async (c) =>
      c.json(await forensicStatus(deps.db, c.var.organisationId, deps.billing)),
    )
    .put("/", zValidator("json", forensicSettingsInput), async (c) => {
      const { audio } = c.req.valid("json");
      const organisationId = c.var.organisationId;
      const who = await deps.audit.member(c.var.userId);
      await deps.db.transaction(async (tx) => {
        // Locked, as every change to the settings is, so a change made at once is kept too.
        const [row] = await tx
          .select({ settings: organisations.settings })
          .from(organisations)
          .where(eq(organisations.id, organisationId))
          .for("update");
        if (!row) throw new NotFound("Workspace");
        const current = workspaceSettingsOf(row.settings);
        await tx
          .update(organisations)
          .set({ settings: { ...current, forensicAudio: audio }, updatedAt: new Date() })
          .where(eq(organisations.id, organisationId));
        await deps.audit.record(
          organisationId,
          who,
          { action: "organisation.settings", details: { change: { forensicAudio: audio } } },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.json(await forensicStatus(deps.db, organisationId, deps.billing));
    })
    .post("/trace", async (c) => {
      const organisationId = c.var.organisationId;
      const name = decodeURIComponent(c.req.header("x-file-name") ?? "").slice(0, 255) || "Unnamed";
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > TRACE_MAX_BYTES)
        throw new HTTPException(413, { message: "That file is too large to trace" });
      const body = c.req.raw.body;
      if (!body) throw new HTTPException(400, { message: "Send the file to trace" });
      const { allowed, retryAfter } = await admit(deps.db, `forensic-trace:${c.var.userId}`, {
        max: TRACES_PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed) return tooMany(c, retryAfter, "Too many traces this hour; try again later");
      const signal = c.req.raw.signal;
      const outcome = await withWorkspace(deps.workDir, async (dir) => {
        const path = join(dir, "suspect");
        const counter = limited(TRACE_MAX_BYTES);
        let bytes = 0;
        counter.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        await pipeline(
          Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>),
          counter,
          createWriteStream(path, { mode: 0o600 }),
          { signal },
        );
        if (bytes === 0) throw new HTTPException(400, { message: "The file is empty" });
        const groups = await markGroups(deps.db, deps.keyring, organisationId);
        const compared = groups.reduce((n, g) => n + g.ids.length, 0);
        try {
          const found = await traceInThread(
            path,
            groups,
            { seconds: TRACE_SECONDS, timeoutMs: 10 * 60_000 },
            signal,
          );
          return { bytes, result: await tracedResult(deps.db, organisationId, found, compared) };
        } catch (error) {
          if (error instanceof InvalidMediaError || /exited with/.test(String(error)))
            throw new HTTPException(422, { message: "That file has no sound Hekate can read" });
          throw error;
        }
      });
      await deps.audit.record(
        organisationId,
        await deps.audit.member(c.var.userId),
        {
          action: "forensic.trace",
          ...(outcome.result.match
            ? { projectId: outcome.result.match.projectId, fileId: outcome.result.match.fileId }
            : {}),
          details: {
            name,
            bytes: outcome.bytes,
            seconds: Math.round(outcome.result.seconds),
            compared: outcome.result.compared,
            mark: outcome.result.match?.id ?? null,
            chance: outcome.result.match?.chance ?? null,
          },
        },
        requestInfo(c, deps.trustProxy),
      );
      return c.json(outcome.result);
    });
