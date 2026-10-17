import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  allowsDownload,
  DOWNLOAD_LINK_SECONDS,
  type DownloadKind,
  type DownloadLevel,
  downloadInput,
  downloadLevelOf,
  formatBytes,
  watermarkOf,
  watermarkText,
} from "@hekate/shared";
import { unwrapKey } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { asc, eq, gt, isNull, lt } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Actor, fileAccess, guestReach } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { Keyring } from "../keyring.ts";
import { watermark } from "../media/watermark.ts";
import { admit, tooMany } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import { sendAttachment } from "./attachments.ts";
import { attachment } from "./comments.ts";

const {
  downloadTickets,
  filePages,
  files,
  guests,
  organisations,
  projects,
  renditionSegments,
  renditions,
  users,
} = schema;

export interface DownloadDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  audit: Audit;
  trustProxy: boolean;
}

/** A download is for one person: nothing in between may keep or share it. */
const PRIVATE = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
} as const;

/** A person may ask for this many downloads an hour, counted where every replica sees it. */
const PER_HOUR = 20;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

const fileParam = zValidator("param", z.object({ id: z.uuid() }));

type FileRow = {
  id: string;
  name: string;
  kind: string;
  contentType: string;
  byteSize: number;
  blobId: string;
  projectId: string;
};

/** What the actor may download of a file: their role's level, or what their reviews grant. */
async function levelFor(db: Database, actor: Actor, fileId: string) {
  const access = await fileAccess(db, actor, fileId);
  if (!access) throw new NotFound("File");
  const level: DownloadLevel = access.grant
    ? access.grant.download
    : downloadLevelOf(access.permissions);
  return { access, level };
}

async function fileOf(db: Database, organisationId: string, fileId: string): Promise<FileRow> {
  const [file] = await db
    .select({
      id: files.id,
      name: files.name,
      kind: files.kind,
      contentType: files.contentType,
      byteSize: files.byteSize,
      blobId: files.blobId,
      projectId: files.projectId,
    })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!file) throw new NotFound("File");
  return file;
}

/**
 * The audio rendition a recording's proxy is made from: its AAC encode, by name, never the
 * lossless or Dolby pass-through renditions that stream beside it.
 */
async function audioRendition(db: Database, organisationId: string, fileId: string) {
  const [row] = await db
    .select()
    .from(renditions)
    .where(
      inOrg(
        renditions,
        organisationId,
        eq(renditions.fileId, fileId),
        isNull(renditions.height),
        eq(renditions.name, "aac-256"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** For a guest, the review whose grant allows this download, for the access log. */
async function grantingReview(db: Database, actor: Actor, fileId: string, kind: DownloadKind) {
  if (actor.kind !== "guest") return null;
  const reach = (await guestReach(db, actor)).get(fileId) ?? [];
  return (
    reach.find((r) => allowsDownload(r.permissions.download ?? "none", kind))?.reviewId ?? null
  );
}

async function firstPage(db: Database, organisationId: string, fileId: string) {
  const [row] = await db
    .select({ blobId: filePages.blobId })
    .from(filePages)
    .where(inOrg(filePages, organisationId, eq(filePages.fileId, fileId), eq(filePages.page, 1)));
  return row ?? null;
}

/**
 * What can be made of a file now, and in what form. A recording: its original (audio carries
 * no mark until #32) and its stream's AAC encode. A picture: the picture as reviewed, with the
 * recipient's name drawn across it. Video and documents follow (#136, their marking).
 */
async function choices(db: Database, organisationId: string, file: FileRow) {
  if (file.kind === "audio") {
    const rendition = await audioRendition(db, organisationId, file.id);
    return {
      proxy: rendition
        ? { available: true, detail: `AAC ${Math.round(rendition.bandwidth / 1000)} kb/s` }
        : { available: false, detail: "Not prepared yet" },
      original: {
        available: true,
        detail: `${file.contentType}, ${formatBytes(file.byteSize)}`,
      },
      marked: false,
    };
  }
  if (file.kind === "image") {
    const page = await firstPage(db, organisationId, file.id);
    return {
      proxy: page
        ? { available: true, detail: "The picture as reviewed, marked with your name" }
        : { available: false, detail: "Not prepared yet" },
      original: { available: false, detail: "Not yet offered for pictures" },
      marked: true,
    };
  }
  return {
    proxy: { available: false, detail: "Not yet offered for this kind of file" },
    original: { available: false, detail: "Not yet offered for this kind of file" },
    marked: true,
  };
}

/** Who a download is made for, for its mark: their name, address and workspace. */
async function recipientOf(db: Database, actor: Actor) {
  const [who] =
    actor.kind === "guest"
      ? await db
          .select({ name: guests.name, email: guests.email, organisation: organisations.name })
          .from(guests)
          .innerJoin(organisations, eq(organisations.id, guests.organisationId))
          .where(inOrg(guests, actor.organisationId, eq(guests.id, actor.guestId)))
      : await db
          .select({ name: users.name, email: users.email, organisation: organisations.name })
          .from(users)
          .innerJoin(organisations, eq(organisations.id, actor.organisationId))
          .where(eq(users.id, actor.userId));
  if (!who) throw new NotFound("File");
  return who;
}

/** The stream's AAC encode, decrypted segment by segment into one fragmented MP4. */
async function* proxyAudio(deps: DownloadDeps, organisationId: string, fileId: string) {
  const rendition = await audioRendition(deps.db, organisationId, fileId);
  if (!rendition) throw new NotFound("Rendition");
  const key = unwrapKey(
    await deps.keyring.version(organisationId, rendition.keyVersion),
    rendition.wrappedKey,
    `rendition:${rendition.id}`,
  );
  const segments = await deps.db
    .select({ blobId: renditionSegments.blobId, iv: renditionSegments.iv })
    .from(renditionSegments)
    .where(
      inOrg(renditionSegments, organisationId, eq(renditionSegments.renditionId, rendition.id)),
    )
    .orderBy(asc(renditionSegments.index));
  for (const part of [{ blobId: rendition.initBlobId, iv: rendition.initIv }, ...segments]) {
    const { stream } = await deps.storage.open(organisationId, part.blobId);
    const sealed = Buffer.concat(await stream.toArray());
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(part.iv, "hex"));
    yield Buffer.concat([decipher.update(sealed), decipher.final()]);
  }
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");

/**
 * `/api/files/:id/downloads`: what someone may download of a file, and asking for one. Asking
 * gives a link that works once, for five minutes, in this session only; nothing leaves until
 * the link is opened, and then only after it is written to the access log.
 */
export const fileDownloadRoutes = (deps: DownloadDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/downloads", fileParam, async (c) => {
      const fileId = c.req.valid("param").id;
      const { level } = await levelFor(deps.db, c.var.actor, fileId);
      const file = await fileOf(deps.db, c.var.organisationId, fileId);
      return c.json({ level, ...(await choices(deps.db, c.var.organisationId, file)) });
    })
    .post("/:id/downloads", fileParam, zValidator("json", downloadInput), async (c) => {
      const fileId = c.req.valid("param").id;
      const { kind } = c.req.valid("json");
      const actor = c.var.actor;
      const { level } = await levelFor(deps.db, actor, fileId);
      if (!allowsDownload(level, kind))
        throw new HTTPException(403, { message: "Your access to this file does not allow that" });
      const file = await fileOf(deps.db, c.var.organisationId, fileId);
      if (!(await choices(deps.db, c.var.organisationId, file))[kind].available)
        throw new HTTPException(422, { message: "That download is not offered for this file" });
      const who = actor.kind === "guest" ? `guest:${actor.guestId}` : `member:${actor.userId}`;
      const { allowed, retryAfter } = await admit(deps.db, `download:${who}`, {
        max: PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed) return tooMany(c, retryAfter, "Too many downloads this hour; try again later");
      const token = randomBytes(32).toString("base64url");
      await deps.db.insert(downloadTickets).values({
        organisationId: c.var.organisationId,
        fileId,
        kind,
        tokenHash: hashOf(token),
        sessionId: c.var.sessionId,
        userId: actor.kind === "guest" ? null : actor.userId,
        guestId: actor.kind === "guest" ? actor.guestId : null,
        expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000),
      });
      return c.json({ url: `/api/downloads/${token}` }, 201);
    });

/**
 * `/api/downloads/:token`: the download itself, made for its recipient. The link works once,
 * in the session that asked for it, within five minutes; the permission is checked again, and
 * the access log has the download before the first byte leaves.
 */
export const downloadRoutes = (deps: DownloadDeps) =>
  new Hono<{ Variables: ViewerVariables }>().get(
    "/:token",
    zValidator("param", z.object({ token: z.string().min(20).max(100) })),
    async (c) => {
      const organisationId = c.var.organisationId;
      const [ticket] = await deps.db
        .update(downloadTickets)
        .set({ usedAt: new Date() })
        .where(
          inOrg(
            downloadTickets,
            organisationId,
            eq(downloadTickets.tokenHash, hashOf(c.req.valid("param").token)),
            eq(downloadTickets.sessionId, c.var.sessionId),
            isNull(downloadTickets.usedAt),
            gt(downloadTickets.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!ticket)
        throw new HTTPException(410, {
          message: "That download link has been used or has expired",
        });
      // A comment's attachment (#133): its own checks, its own record.
      if (ticket.attachmentId)
        return sendAttachment(deps, c, {
          fileId: ticket.fileId,
          attachmentId: ticket.attachmentId,
        });
      const actor = c.var.actor;
      const { level } = await levelFor(deps.db, actor, ticket.fileId);
      if (ticket.kind === "attachment")
        throw new HTTPException(410, { message: "That download link no longer works" });
      const kind: DownloadKind = ticket.kind;
      if (!allowsDownload(level, kind))
        throw new HTTPException(403, { message: "Your access to this file does not allow that" });
      const file = await fileOf(deps.db, organisationId, ticket.fileId);
      // No record, no download.
      await deps.audit.record(
        organisationId,
        await deps.audit.actor(actor),
        {
          action: "download",
          projectId: file.projectId,
          fileId: file.id,
          reviewId: (await grantingReview(deps.db, actor, file.id, kind)) ?? undefined,
          details: { kind },
        },
        requestInfo(c, deps.trustProxy),
      );
      if (file.kind === "audio" && kind === "original") {
        const { stream } = await deps.storage.open(organisationId, file.blobId);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": file.contentType,
            "content-length": String(file.byteSize),
            "content-disposition": attachment(file.name),
          },
        });
      }
      if (file.kind === "audio" && kind === "proxy") {
        const stream = Readable.from(proxyAudio(deps, organisationId, file.id));
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "audio/mp4",
            "content-disposition": attachment(`${stem(file.name)}.m4a`),
          },
        });
      }
      if (file.kind === "image" && kind === "proxy") {
        const page = await firstPage(deps.db, organisationId, file.id);
        if (!page) throw new NotFound("Page");
        const who = await recipientOf(deps.db, actor);
        // Always marked for whoever asked, whatever the project's scope; drawn where and as
        // strongly as the project chose (#31).
        const [project] = await deps.db
          .select({ watermark: projects.watermark })
          .from(projects)
          .where(inOrg(projects, organisationId, eq(projects.id, file.projectId)));
        const { stream } = await deps.storage.open(organisationId, page.blobId);
        const marked = await watermark(
          Buffer.concat(await stream.toArray()),
          watermarkText(who, who.organisation, new Date()),
          "view",
          c.req.raw.signal,
          watermarkOf(project?.watermark),
        );
        return c.body(new Uint8Array(marked), 200, {
          ...PRIVATE,
          "content-type": "image/webp",
          "content-length": String(marked.length),
          "content-disposition": attachment(`${stem(file.name)}.webp`),
        });
      }
      throw new HTTPException(422, { message: "That download is not offered for this file" });
    },
  );

/** Links are of no use after a few minutes; the hourly purge removes them a day on. */
export async function purgeDownloadTickets(db: Database, now = new Date()) {
  const before = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // Workspace by workspace: download links belong to one.
  for (const { id } of await db.select({ id: organisations.id }).from(organisations)) {
    await db
      .delete(downloadTickets)
      .where(inOrg(downloadTickets, id, lt(downloadTickets.createdAt, before)));
  }
}
