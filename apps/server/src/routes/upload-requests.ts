import { type Database, inOrg, schema } from "@hekate/db";
import {
  createUploadRequestInput,
  endOfDay,
  UPLOAD_REQUEST_MAX_DAYS,
  uploadRequestState,
  visitorUploadInput,
  workspaceSettingsOf,
} from "@hekate/shared";
import { and, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { workspaceEmail } from "../email/templates.ts";
import { NotFound } from "../errors.ts";
import { hashToken } from "../guests.ts";
import { type LinkRoots, workspaceLinkBase } from "../hosts.ts";
import type { Jobs } from "../jobs.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { notifyNow } from "../notifications.ts";
import { zValidator } from "../openapi/validator.ts";
import { measuredKind, versionFromRequest } from "../request-versions.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";
import { uploadEngine, uploadView } from "../upload-engine.ts";
import { hashPassword, newRequestToken, passwordMatches } from "../upload-requests.ts";
import type { RunnerDeps } from "../workflow-runner.ts";
import { chunkBody, chunkIndex } from "./uploads.ts";

const {
  uploadRequests,
  uploadRequestUploads,
  uploadRequestFiles,
  uploads,
  folders,
  files,
  projects,
  tracks,
  organisations,
  users,
} = schema;
type RequestRow = typeof uploadRequests.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface UploadRequestDeps extends LinkRoots {
  db: Database;
  storage: Storage;
  jobs: Pick<Jobs, "send">;
  audit: Audit;
  mailer: Mailer;
  trustProxy: boolean;
  /** The workflows a request's versions move on (#425); without asking for reviews if absent. */
  runner?: RunnerDeps;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const idParam = zValidator("param", z.object({ id: z.uuid() }));
const projectParam = zValidator("param", z.object({ projectId: z.uuid() }));
const tokenParam = zValidator("param", z.object({ token: z.string().min(16).max(128) }));
const visitorUploadParam = zValidator(
  "param",
  z.object({ token: z.string().min(16).max(128), id: z.uuid() }),
);

/** How many files have arrived through each of `ids`. */
async function arrivedCounts(db: Pick<Database, "select">, organisationId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ requestId: uploadRequestFiles.requestId, n: count() })
    .from(uploadRequestFiles)
    .where(inOrg(uploadRequestFiles, organisationId, inArray(uploadRequestFiles.requestId, ids)))
    .groupBy(uploadRequestFiles.requestId);
  return new Map(rows.map((r) => [r.requestId, r.n]));
}

/** A request as its project's members see it: never its token or password. */
function memberView(row: RequestRow, arrived: number, now = new Date()) {
  return {
    id: row.id,
    projectId: row.projectId,
    folderId: row.folderId,
    trackId: row.trackId,
    name: row.name,
    wanted: row.wanted,
    fileLimit: row.fileLimit,
    expiresAt: row.expiresAt,
    closedAt: row.closedAt,
    hasPassword: row.passwordHash !== null,
    createdAt: row.createdAt,
    arrived,
    state: uploadRequestState(row, arrived, now),
  };
}

/** An upload as its visitor sees it: what resuming needs, nothing of the project. */
function visitorView(row: Parameters<typeof uploadView>[0], chunks: number[]) {
  const { projectId: _project, folderId: _folder, ...view } = uploadView(row, chunks);
  return view;
}

/** Every refusal of a link that does not lead anywhere, alike: it gives nothing away. */
const gone = () =>
  new HTTPException(410, { message: "This link does not lead to an upload request." });

/**
 * Upload requests for a project's members (#139): ask someone outside for files, see what
 * arrived, close a request or give it a new link. Making and closing them is the project's
 * organise permission's, as the prototype offers them beside new folders.
 */
export const uploadRequestRoutes = (deps: UploadRequestDeps) => {
  const { db, audit } = deps;
  /** A request's link: at its workspace's own address with subdomains on (#437). */
  const link = async (organisationId: string, token: string) =>
    `${await workspaceLinkBase(db, deps, organisationId)}/u/${token}`;

  /** A request of the caller's workspace that they may organise, or 404. */
  const organisable = async (c: { var: TenantVariables }, id: string) => {
    const [row] = await db
      .select()
      .from(uploadRequests)
      .where(inOrg(uploadRequests, c.var.organisationId, eq(uploadRequests.id, id)));
    if (!row) throw new NotFound("Upload request");
    await can(db, actorOf(c.var), "organise", row.projectId);
    return row;
  };

  return (
    new Hono<{ Variables: TenantVariables }>()
      .get("/projects/:projectId/upload-requests", projectParam, async (c) => {
        const { projectId } = c.req.valid("param");
        await can(db, actorOf(c.var), "organise", projectId);
        const rows = await db
          .select()
          .from(uploadRequests)
          .where(
            inOrg(uploadRequests, c.var.organisationId, eq(uploadRequests.projectId, projectId)),
          )
          .orderBy(desc(uploadRequests.id));
        const arrived = await arrivedCounts(
          db,
          c.var.organisationId,
          rows.map((r) => r.id),
        );
        return c.json({
          requests: rows.map((r) => memberView(r, arrived.get(r.id) ?? 0)),
        });
      })

      .post(
        "/projects/:projectId/upload-requests",
        projectParam,
        zValidator("json", createUploadRequestInput),
        async (c) => {
          const { projectId } = c.req.valid("param");
          const input = c.req.valid("json");
          const organisationId = c.var.organisationId;
          await can(db, actorOf(c.var), "organise", projectId);
          if (input.folderId) {
            const [folder] = await db
              .select({ id: folders.id })
              .from(folders)
              .where(
                inOrg(
                  folders,
                  organisationId,
                  eq(folders.id, input.folderId),
                  eq(folders.projectId, projectId),
                ),
              );
            if (!folder) throw new NotFound("Folder");
          }
          // A track of this project, in this workspace (#425): its files arrive beside it.
          let trackFolder: string | null = null;
          if (input.trackId) {
            const [track] = await db
              .select({ id: tracks.id, folderId: tracks.folderId })
              .from(tracks)
              .where(
                inOrg(
                  tracks,
                  organisationId,
                  eq(tracks.id, input.trackId),
                  eq(tracks.projectId, projectId),
                ),
              );
            if (!track) throw new NotFound("Track");
            trackFolder = track.folderId;
          }
          const expiresAt = endOfDay(input.expiresOn);
          const days = Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS);
          if (days < 1 || days > UPLOAD_REQUEST_MAX_DAYS) {
            throw new HTTPException(400, {
              message: `A request stays open from today for at most ${UPLOAD_REQUEST_MAX_DAYS} days`,
            });
          }
          const token = newRequestToken();
          const [row] = await db
            .insert(uploadRequests)
            .values({
              organisationId,
              projectId,
              folderId: input.trackId ? trackFolder : input.folderId,
              trackId: input.trackId ?? null,
              createdBy: c.var.userId,
              name: input.name,
              wanted: input.wanted,
              fileLimit: input.fileLimit,
              expiresAt,
              tokenHash: hashToken(token),
              passwordHash: input.password ? await hashPassword(input.password) : null,
            })
            .returning();
          if (!row) throw new Error("Upload request insert returned no row");
          await audit.record(
            organisationId,
            await audit.member(c.var.userId),
            {
              action: "upload_request.create",
              projectId,
              details: {
                request: row.id,
                name: row.name,
                fileLimit: row.fileLimit,
                ...(row.trackId ? { trackId: row.trackId } : {}),
              },
            },
            requestInfo(c, deps.trustProxy),
          );
          if (input.email) {
            const [organisation] = await db
              .select({ name: organisations.name, settings: organisations.settings })
              .from(organisations)
              .where(eq(organisations.id, organisationId));
            const [requester] = await db
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, c.var.userId));
            await sendEmail(
              deps.mailer,
              input.email,
              workspaceEmail(
                "upload_request",
                {
                  workspace: organisation?.name ?? "Hekate",
                  requester: requester?.name ?? "Someone",
                  file: row.wanted || row.name,
                  url: await link(organisationId, token),
                  days,
                },
                workspaceSettingsOf(organisation?.settings).emailSubjects,
              ),
              organisationId,
            );
          }
          // The link is shown this once: only its hash is kept.
          return c.json(
            { request: memberView(row, 0), link: await link(organisationId, token) },
            201,
          );
        },
      )

      .get("/upload-requests/:id", idParam, async (c) => {
        const row = await organisable(c, c.req.valid("param").id);
        const arrived = await db
          .select({
            fileId: uploadRequestFiles.fileId,
            sender: uploadRequestFiles.sender,
            arrivedAt: uploadRequestFiles.arrivedAt,
            name: files.name,
            byteSize: files.byteSize,
          })
          .from(uploadRequestFiles)
          .innerJoin(
            files,
            inOrg(files, row.organisationId, eq(files.id, uploadRequestFiles.fileId)),
          )
          .where(
            inOrg(uploadRequestFiles, row.organisationId, eq(uploadRequestFiles.requestId, row.id)),
          )
          .orderBy(desc(uploadRequestFiles.arrivedAt));
        return c.json({ request: memberView(row, arrived.length), arrived });
      })

      .post("/upload-requests/:id/close", idParam, async (c) => {
        const row = await organisable(c, c.req.valid("param").id);
        const [closed] = row.closedAt
          ? [row]
          : await db
              .update(uploadRequests)
              .set({ closedAt: new Date() })
              .where(
                inOrg(
                  uploadRequests,
                  row.organisationId,
                  eq(uploadRequests.id, row.id),
                  isNull(uploadRequests.closedAt),
                ),
              )
              .returning();
        if (closed && !row.closedAt) {
          await audit.record(
            row.organisationId,
            await audit.member(c.var.userId),
            {
              action: "upload_request.close",
              projectId: row.projectId,
              details: { request: row.id, name: row.name },
            },
            requestInfo(c, deps.trustProxy),
          );
        }
        const counts = await arrivedCounts(db, row.organisationId, [row.id]);
        return c.json({ request: memberView(closed ?? row, counts.get(row.id) ?? 0) });
      })

      // A new link, the old one stopping at once: the way to share it again, as only its hash
      // is kept.
      .post("/upload-requests/:id/link", idParam, async (c) => {
        const row = await organisable(c, c.req.valid("param").id);
        const token = newRequestToken();
        await db
          .update(uploadRequests)
          .set({ tokenHash: hashToken(token) })
          .where(inOrg(uploadRequests, row.organisationId, eq(uploadRequests.id, row.id)));
        return c.json({ link: await link(row.organisationId, token) });
      })
  );
};

/**
 * The visitor's side of an upload request (#139), with no session: the token in the path is
 * the credential. It reads the request's own words and counts, and sends files into its
 * folder, nothing else; every way a token can fail looks the same.
 */
export const uploadLinkRoutes = (deps: UploadRequestDeps) => {
  const { db, audit } = deps;
  const engine = uploadEngine(deps);

  /** The request behind a token, with the workspace and project still open, or 410. */
  const requestOf = async (token: string, tx: Pick<Database, "select"> = db) => {
    const [found] = await tx
      .select({
        request: uploadRequests,
        workspace: organisations.name,
        suspendedAt: organisations.suspendedAt,
        archivedAt: projects.archivedAt,
      })
      .from(uploadRequests)
      .innerJoin(organisations, eq(organisations.id, uploadRequests.organisationId))
      .innerJoin(
        projects,
        and(
          eq(projects.id, uploadRequests.projectId),
          eq(projects.organisationId, uploadRequests.organisationId),
        ),
      )
      .where(eq(uploadRequests.tokenHash, hashToken(token)));
    if (!found || found.suspendedAt || found.archivedAt) throw gone();
    return found;
  };

  /** Files arrived, and uploads begun and still able to finish: a request's places taken. */
  const placesTaken = async (tx: Pick<Database, "select">, row: RequestRow) => {
    const arrived = (await arrivedCounts(tx, row.organisationId, [row.id])).get(row.id) ?? 0;
    const [inFlight] = await tx
      .select({ n: count() })
      .from(uploadRequestUploads)
      .innerJoin(
        uploads,
        inOrg(uploads, row.organisationId, eq(uploads.id, uploadRequestUploads.uploadId)),
      )
      .where(
        inOrg(
          uploadRequestUploads,
          row.organisationId,
          eq(uploadRequestUploads.requestId, row.id),
          inArray(uploads.status, ["open", "completing"]),
          gt(uploads.expiresAt, new Date()),
        ),
      );
    return { arrived, taken: arrived + (inFlight?.n ?? 0) };
  };

  /** One of this request's uploads, and who is sending it, or 404. */
  const uploadOf = async (row: RequestRow, id: string) => {
    const [found] = await db
      .select({ upload: uploads, sender: uploadRequestUploads.sender })
      .from(uploadRequestUploads)
      .innerJoin(
        uploads,
        inOrg(uploads, row.organisationId, eq(uploads.id, uploadRequestUploads.uploadId)),
      )
      .where(
        inOrg(
          uploadRequestUploads,
          row.organisationId,
          eq(uploadRequestUploads.uploadId, id),
          eq(uploadRequestUploads.requestId, row.id),
        ),
      );
    if (!found) throw new NotFound("Upload");
    return found;
  };

  /** Where a file arrives: the request's folder, or beside its track wherever that is now. */
  const arrivalFolder = async (row: RequestRow) => {
    if (!row.trackId) return row.folderId;
    const [track] = await db
      .select({ folderId: tracks.folderId })
      .from(tracks)
      .where(inOrg(tracks, row.organisationId, eq(tracks.id, row.trackId)));
    return track ? track.folderId : row.folderId;
  };

  const refuseUnlessOpen = (row: RequestRow, arrived: number) => {
    const state = uploadRequestState(row, arrived);
    if (state === "full")
      throw new HTTPException(409, { message: "This request has all the files it asked for." });
    if (state !== "open") throw gone();
  };

  return new Hono()
    .get("/:token", tokenParam, async (c) => {
      const { request, workspace } = await requestOf(c.req.valid("param").token);
      const { arrived } = await placesTaken(db, request);
      return c.json({
        request: {
          name: request.name,
          wanted: request.wanted,
          workspace,
          fileLimit: request.fileLimit,
          arrived,
          expiresAt: request.expiresAt,
          needsPassword: request.passwordHash !== null,
          state: uploadRequestState(request, arrived),
        },
      });
    })

    .post(
      "/:token/uploads",
      tokenParam,
      zValidator("json", visitorUploadInput.extend({ password: z.string().max(128).optional() })),
      async (c) => {
        const { token } = c.req.valid("param");
        const input = c.req.valid("json");
        const { request } = await requestOf(token);
        if (request.passwordHash) {
          const right =
            input.password !== undefined &&
            (await passwordMatches(input.password, request.passwordHash));
          if (!right) {
            await audit.record(
              request.organisationId,
              { type: "visitor", label: input.sender },
              {
                action: "upload_request.password_failed",
                projectId: request.projectId,
                details: { request: request.id },
              },
              requestInfo(c, deps.trustProxy),
            );
            throw new HTTPException(403, { message: "That password is not the one asked for." });
          }
        }
        const row = await engine.begin({
          organisationId: request.organisationId,
          projectId: request.projectId,
          folderId: await arrivalFolder(request),
          name: input.name,
          size: input.size,
          contentType: input.contentType,
          createdBy: null,
          // The place is taken under a lock on the request, so the limit holds however
          // many files start at once.
          also: async (tx: Tx, upload) => {
            const [locked] = await tx
              .select()
              .from(uploadRequests)
              .where(
                inOrg(uploadRequests, request.organisationId, eq(uploadRequests.id, request.id)),
              )
              .for("update");
            if (!locked || locked.tokenHash !== request.tokenHash) throw gone();
            const { arrived, taken } = await placesTaken(tx, locked);
            refuseUnlessOpen(locked, arrived);
            if (taken >= locked.fileLimit)
              throw new HTTPException(409, {
                message: "This request has all the files it asked for.",
              });
            await tx.insert(uploadRequestUploads).values({
              uploadId: upload.id,
              organisationId: request.organisationId,
              requestId: request.id,
              sender: input.sender,
            });
          },
        });
        return c.json({ upload: visitorView(row, []) }, 201);
      },
    )

    .get("/:token/uploads/:id", visitorUploadParam, async (c) => {
      const { token, id } = c.req.valid("param");
      const { request } = await requestOf(token);
      const { upload } = await uploadOf(request, id);
      const chunks = await engine.received(upload.organisationId, upload.id);
      return c.json({
        upload: visitorView(
          upload,
          chunks.map((p) => p.chunk),
        ),
      });
    })

    .put(
      "/:token/uploads/:id/chunks/:index",
      zValidator(
        "param",
        z.object({
          token: z.string().min(16).max(128),
          id: z.uuid(),
          index: chunkIndex,
        }),
      ),
      chunkBody,
      async (c) => {
        const { token, id, index } = c.req.valid("param");
        const { request } = await requestOf(token);
        if (request.closedAt || request.expiresAt.getTime() <= Date.now()) throw gone();
        const { upload } = await uploadOf(request, id);
        const body = new Uint8Array(await c.req.arrayBuffer());
        await engine.putChunk(upload, index, body, c.req.header("content-digest"));
        return c.body(null, 204);
      },
    )

    .post("/:token/uploads/:id/complete", visitorUploadParam, async (c) => {
      const { token, id } = c.req.valid("param");
      const { request } = await requestOf(token);
      const { upload, sender } = await uploadOf(request, id);
      if (upload.status !== "completed") {
        const { arrived } = await placesTaken(db, request);
        // Its place was taken when it began, so only a closed or lapsed request refuses it.
        const state = uploadRequestState(request, arrived);
        if (state === "closed" || state === "expired") throw gone();
      }
      const { file, created } = await engine.complete(upload, {
        uploadedBy: null,
        actor: async () => ({
          type: "visitor",
          label: `${sender} (upload request: ${request.name})`,
        }),
        request: requestInfo(c, deps.trustProxy),
        also: async (tx, made) => {
          // Checked again under a lock on the request, so a close or a new link committed
          // meanwhile is ordered before this file, never after.
          const [locked] = await tx
            .select()
            .from(uploadRequests)
            .where(inOrg(uploadRequests, request.organisationId, eq(uploadRequests.id, request.id)))
            .for("update");
          if (!locked || locked.tokenHash !== request.tokenHash) throw gone();
          const state = uploadRequestState(locked, 0);
          if (state === "closed" || state === "expired") throw gone();
          await tx.insert(uploadRequestFiles).values({
            fileId: made.id,
            organisationId: request.organisationId,
            requestId: request.id,
            sender,
          });
        },
      });
      if (created && request.createdBy) {
        await notifyNow(deps, {
          organisationId: request.organisationId,
          kind: "upload_arrived",
          recipients: [request.createdBy],
          actor: null,
          projectId: request.projectId,
          fileId: file.id,
          text: `${sender} sent ${file.name} for ${request.name}`,
          link: `/files/${file.id}`,
        });
      }
      // Sent to a track (#425): a file that is measured becomes its version once it has been
      // (the measuring job sees to it); anything else, now. A failure is left in the log: the
      // file has arrived either way.
      if (created && request.trackId && !measuredKind(file.kind)) {
        await versionFromRequest(
          { ...deps, ...(deps.runner ?? { db, jobs: deps.jobs }) },
          { organisationId: request.organisationId, fileId: file.id },
        ).catch((error: unknown) =>
          console.warn(`Could not make a version from file ${file.id}: ${String(error)}`),
        );
      }
      // The visitor sees only that it arrived: never the file itself.
      return c.json({ arrived: { name: file.name, size: file.byteSize } }, created ? 201 : 200);
    });
};
