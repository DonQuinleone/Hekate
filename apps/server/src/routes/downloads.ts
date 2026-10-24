import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  allowsDownload,
  DOWNLOAD_LINK_SECONDS,
  type DownloadKind,
  type DownloadLevel,
  type DrawingColour,
  downloadInput,
  downloadLevelOf,
  drawingColours,
  formatBytes,
  isPdf,
  type MediaInfo,
  type ScoreMarkKind,
  scoresDownloadInput,
  type WatermarkSettings,
  watermarkOf,
  watermarkText,
} from "@hekate/shared";
import { unwrapKey } from "@hekate/storage";
import { asc, desc, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Actor, actorOf, can, fileAccess, guestReach } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import { emitEvent } from "../events.ts";
import { issueMark, marksAudio } from "../forensic.ts";
import type { ViewerVariables } from "../guests.ts";
import type { Keyring } from "../keyring.ts";
import {
  audioCodecsOf,
  burnArgs,
  burnDeadlineMs,
  burnFormat,
  streamFfmpeg,
} from "../media/burn.ts";
import { MediaToolError, probe, run } from "../media/ffmpeg.ts";
import { ffmpegLayout, markedAudioFormat, markInThread, mixArgs } from "../media/forensic-audio.ts";
import {
  IMAGE_DEMUXERS,
  MAX_PAGES,
  pdfPageCount,
  pdfPageSizes,
  printDpi,
  renderPdfPage,
} from "../media/pages.ts";
import { jpegSize, type PdfPage, pdfOf, pointsOf } from "../media/pdf.ts";
import { scoreOverlay } from "../media/score-overlay.ts";
import {
  extensionOf,
  type MarkedFormat,
  markedFormatOf,
  markPicture,
  watermark,
} from "../media/watermark.ts";
import { streamInWorkspace } from "../media/workspace.ts";
import { zValidator } from "../openapi/validator.ts";
import { admit, tooMany } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";
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
  scoreMarkCategories,
  scoreMarks,
  tracks,
  users,
} = schema;

/** A download, as the workspace's channels hear of it (#161), once it is in the access log. */
const downloaded = (
  organisationId: string,
  actor: Actor,
  projectId: string,
  fileId: string,
  kind: DownloadKind,
) => ({
  organisationId,
  kind: "file.downloaded" as const,
  actor: actor.kind === "guest" ? { guestId: actor.guestId } : { userId: actor.userId },
  projectId,
  fileId,
  path: `/files/${fileId}`,
  details: { download: kind },
});

export interface DownloadDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  audit: Audit;
  trustProxy: boolean;
  /** Scratch space for decrypted originals while a download is made (WORK_DIR). */
  workDir?: string;
  /** The billing module is on: the workspace's plan decides whether marking is included. */
  billing?: boolean;
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
  pageCount: number | null;
  mediaInfo: MediaInfo | null;
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
      pageCount: files.pageCount,
      mediaInfo: files.mediaInfo,
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

/**
 * The picture rendition a video's proxy is made from: the largest the stream offers, its H.264
 * encoding where it has a royalty-free one beside it (#148), being quicker to decode.
 */
async function videoRendition(db: Database, organisationId: string, fileId: string) {
  const [row] = await db
    .select()
    .from(renditions)
    .where(
      inOrg(
        renditions,
        organisationId,
        eq(renditions.fileId, fileId),
        isNotNull(renditions.height),
      ),
    )
    // "1080p" sorts before "1080p-av1".
    .orderBy(desc(renditions.height), asc(renditions.name))
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
 * What can be made of a file now, and in what form. A recording: its original and an AAC
 * encode like its stream's, each with an inaudible mark for its recipient where the workspace
 * marks them (#32, `marking`), or as they are otherwise. A picture: as reviewed, or at full
 * size, with the recipient's name drawn across it. A document: its pages as reviewed, or drawn
 * again from the original PDF at print resolution, each marked, as a PDF. A video: the
 * stream's largest encode, or the original at its own size, with the mark burned into the
 * picture.
 */
async function choices(db: Database, organisationId: string, file: FileRow, marking = false) {
  if (file.kind === "audio") {
    const rendition = await audioRendition(db, organisationId, file.id);
    if (marking)
      return {
        proxy: rendition
          ? { available: true, detail: markedAudioFormat(file.mediaInfo, "proxy").detail }
          : { available: false, detail: "Not prepared yet" },
        original: file.mediaInfo?.audio
          ? { available: true, detail: markedAudioFormat(file.mediaInfo, "original").detail }
          : { available: false, detail: "Not prepared yet" },
        marked: true,
        inaudible: true,
      };
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
        ? { available: true, detail: "The picture as reviewed" }
        : { available: false, detail: "Not prepared yet" },
      original: page
        ? { available: true, detail: "The picture at full size, in its own format" }
        : { available: false, detail: "Not prepared yet" },
      marked: true,
    };
  }
  if (file.kind === "video") {
    const rendition = await videoRendition(db, organisationId, file.id);
    const video = file.mediaInfo?.video;
    return {
      proxy: rendition
        ? { available: true, detail: `The ${rendition.height}p stream as reviewed, as MP4` }
        : { available: false, detail: "Not prepared yet" },
      original: video
        ? {
            available: true,
            detail: `${video.width} × ${video.height}, encoded again to carry the mark, as QuickTime`,
          }
        : { available: false, detail: "Not prepared yet" },
      marked: true,
    };
  }
  if (file.kind === "document") {
    const page = await firstPage(db, organisationId, file.id);
    if (!page) {
      const detail =
        file.pageCount === null ? "Not offered for this kind of file" : "Not prepared yet";
      return {
        proxy: { available: false, detail },
        original: { available: false, detail },
        marked: true,
      };
    }
    // Pages beyond the limit are never drawn, so never downloaded either.
    const some =
      file.pageCount !== null && file.pageCount > MAX_PAGES
        ? `The first ${MAX_PAGES} pages`
        : "Every page";
    return {
      proxy: {
        available: true,
        detail: `${some} as reviewed, as a PDF`,
      },
      original: isPdf(file.name, file.contentType)
        ? {
            available: true,
            detail: `${some} at print resolution, as a PDF`,
          }
        : { available: false, detail: "Not offered for this kind of file" },
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

/** A rendition of the stream, decrypted segment by segment into one fragmented MP4. */
async function* decrypted(
  deps: DownloadDeps,
  organisationId: string,
  rendition: typeof renditions.$inferSelect,
) {
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

/** How a download is marked: the recipient's words, drawn as the project chose. */
interface Mark {
  text: string;
  style: Pick<WatermarkSettings, "position" | "opacity">;
  signal: AbortSignal;
  /** For a score: the track's score marks to draw over a page, by its number (#52). */
  overlay?: (page: number, points: PdfPage["points"]) => string;
}

/**
 * The track a score is downloaded with its marks for (#52): one in this workspace whose score
 * this file is, in a project where the asker may see the production tools.
 */
async function markedTrack(db: Database, actor: Actor, fileId: string, trackId: string) {
  const [track] = await db
    .select({ id: tracks.id, projectId: tracks.projectId, scoreFileId: tracks.scoreFileId })
    .from(tracks)
    .where(inOrg(tracks, actor.organisationId, eq(tracks.id, trackId)));
  if (!track) throw new NotFound("Track");
  await can(db, actor, "view_production", track.projectId);
  if (track.scoreFileId !== fileId)
    throw new HTTPException(422, { message: "That file is not the track's score" });
  return track;
}

/** How a track's score marks are drawn over each page of its score. */
async function overlayOf(
  db: Database,
  organisationId: string,
  track: { id: string; projectId: string },
) {
  const marks = await db
    .select()
    .from(scoreMarks)
    .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.trackId, track.id)));
  const categories = await db
    .select({ id: scoreMarkCategories.id, colour: scoreMarkCategories.colour })
    .from(scoreMarkCategories)
    .where(
      inOrg(
        scoreMarkCategories,
        organisationId,
        eq(scoreMarkCategories.projectId, track.projectId),
      ),
    );
  const colours = new Map(
    categories.flatMap((c) =>
      (drawingColours as readonly string[]).includes(c.colour)
        ? [[c.id, c.colour as DrawingColour] as const]
        : [],
    ),
  );
  return (page: number, points: PdfPage["points"]) =>
    scoreOverlay(
      marks
        .filter((m) => m.page === page)
        .map((m) => ({
          kind: m.kind as ScoreMarkKind,
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
          points: m.points,
          text: m.text,
          categoryId: m.categoryId,
          fixedBy: m.fixedBy,
          resolved: m.resolvedAt != null,
          from: m.fromTake,
          to: m.toTake,
        })),
      (id) => (id ? colours.get(id) : undefined) ?? "signal",
      points,
    );
}

/** A project's tracks that have a score, in the project's order. */
async function scoredTracks(db: Database, organisationId: string, projectId: string) {
  const rows = await db
    .select({
      id: tracks.id,
      name: tracks.name,
      projectId: tracks.projectId,
      scoreFileId: tracks.scoreFileId,
    })
    .from(tracks)
    .where(
      inOrg(tracks, organisationId, eq(tracks.projectId, projectId), isNotNull(tracks.scoreFileId)),
    )
    .orderBy(asc(tracks.position), asc(tracks.createdAt), asc(tracks.id));
  return rows.flatMap((r) => (r.scoreFileId ? [{ ...r, scoreFileId: r.scoreFileId }] : []));
}

/**
 * Every track's score in a project, for one download of them all with their marks (#52):
 * for someone who sees the production tools and may take each score in this form. Checked as
 * the link is made and again as it is used.
 */
async function everyScore(db: Database, actor: Actor, projectId: string, kind: DownloadKind) {
  await can(db, actor, "view_production", projectId);
  const scored = await scoredTracks(db, actor.organisationId, projectId);
  if (scored.length === 0)
    throw new HTTPException(422, { message: "No track in this project has a score" });
  const out: { track: (typeof scored)[number]; file: FileRow }[] = [];
  for (const track of scored) {
    const { level } = await levelFor(db, actor, track.scoreFileId);
    if (!allowsDownload(level, kind))
      throw new HTTPException(403, {
        message: `Your access to the score of ${track.name} does not allow that`,
      });
    const file = await fileOf(db, actor.organisationId, track.scoreFileId);
    if (!(await choices(db, actor.organisationId, file))[kind].available)
      throw new HTTPException(422, {
        message: `The score of ${track.name} cannot be downloaded that way yet`,
      });
    out.push({ track, file });
  }
  return out;
}

/** A document's pages as reviewed, each marked, ready to become a PDF's pages. */
async function* reviewedPages(
  deps: DownloadDeps,
  organisationId: string,
  fileId: string,
  mark: Mark,
): AsyncGenerator<PdfPage> {
  const pages = await deps.db
    .select({ page: filePages.page, blobId: filePages.blobId })
    .from(filePages)
    .where(inOrg(filePages, organisationId, eq(filePages.fileId, fileId)))
    .orderBy(asc(filePages.page));
  for (const page of pages) {
    const { stream } = await deps.storage.open(organisationId, page.blobId);
    const jpeg = await watermark(
      Buffer.concat(await stream.toArray()),
      mark.text,
      "view",
      mark.signal,
      mark.style,
      "jpeg",
      deps.workDir,
    );
    const size = jpegSize(jpeg);
    const points = pointsOf(size.width, size.height);
    yield { jpeg, ...size, points, overlay: mark.overlay?.(page.page, points) };
  }
}

/** Copy a file's original, decrypted, into a workspace for the media tools. */
async function originalInto(
  deps: DownloadDeps,
  organisationId: string,
  file: FileRow,
  path: string,
  signal?: AbortSignal,
) {
  const { stream } = await deps.storage.open(organisationId, file.blobId);
  // A browser that goes stops the copy too.
  await pipeline(stream, createWriteStream(path, { mode: 0o600 }), { signal });
}

/**
 * A PDF's pages drawn again from the original at print resolution, each marked, at their own
 * size: the document as it was made, but for its text, which becomes a picture with the mark.
 */
function printPages(
  deps: DownloadDeps,
  organisationId: string,
  file: FileRow,
  mark: Mark,
): AsyncGenerator<PdfPage> {
  return streamInWorkspace(deps.workDir, async function* (dir) {
    const path = join(dir, "original.pdf");
    await originalInto(deps, organisationId, file, path, mark.signal);
    const count = Math.min(await pdfPageCount(path, mark.signal), MAX_PAGES);
    const sizes = await pdfPageSizes(path, count, mark.signal);
    const png = join(dir, "page.png");
    const jpg = join(dir, "page.jpg");
    for (const [i, points] of sizes.entries()) {
      await renderPdfPage(path, i + 1, printDpi(points), png, mark.signal);
      await markPicture(png, jpg, { ...mark, demuxers: "png_pipe", format: "jpeg" });
      const jpeg = await readFile(jpg);
      yield { jpeg, ...jpegSize(jpeg), points, overlay: mark.overlay?.(i + 1, points) };
    }
  });
}

/** A picture's original at full size, marked, in its own format where one can be written. */
function markedOriginal(
  deps: DownloadDeps,
  organisationId: string,
  file: FileRow,
  format: MarkedFormat,
  mark: Mark,
): AsyncGenerator<Buffer> {
  return streamInWorkspace(deps.workDir, async function* (dir) {
    const input = join(dir, "original");
    await originalInto(deps, organisationId, file, input, mark.signal);
    const output = join(dir, `marked.${extensionOf[format]}`);
    await markPicture(input, output, { ...mark, demuxers: IMAGE_DEMUXERS, format });
    for await (const chunk of createReadStream(output)) yield chunk as Buffer;
  });
}

/**
 * A video with the recipient's mark burned in: the stream's largest encode, decrypted, for the
 * proxy, or the original. Encoded as it is sent.
 */
function markedVideo(
  deps: DownloadDeps,
  organisationId: string,
  file: FileRow,
  kind: DownloadKind,
  mark: Mark,
): AsyncGenerator<Buffer> {
  return streamInWorkspace(deps.workDir, async function* (dir) {
    const input = join(dir, "source");
    if (kind === "proxy") {
      const rendition = await videoRendition(deps.db, organisationId, file.id);
      if (!rendition) throw new NotFound("Rendition");
      await pipeline(
        Readable.from(decrypted(deps, organisationId, rendition)),
        createWriteStream(input, { mode: 0o600 }),
        { signal: mark.signal },
      );
    } else {
      await originalInto(deps, organisationId, file, input, mark.signal);
    }
    const text = join(dir, "mark.txt");
    await writeFile(text, mark.text);
    yield* streamFfmpeg(
      burnArgs(input, text, {
        quality: kind,
        // Every stream's, not only the first's that the file's probe describes.
        audioCodecs: kind === "original" ? await audioCodecsOf(input, mark.signal) : [],
        style: mark.style,
      }),
      { signal: mark.signal, timeoutMs: burnDeadlineMs(file.mediaInfo?.duration) },
    );
  });
}

/** Whether a file's downloads carry an inaudible mark now: a recording, where the workspace marks them. */
const marksFile = async (deps: DownloadDeps, organisationId: string, file: FileRow) =>
  file.kind === "audio" && (await marksAudio(deps.db, organisationId, deps.billing ?? false));

/**
 * A recording with an inaudible mark for its recipient (#32): made from the original, the
 * mark first, then the recording again with it, in the form `markedAudioFormat` gives. Made
 * whole in the private workspace before it is sent, so the file's header is right, and gone
 * when the download ends.
 */
function markedAudio(
  deps: DownloadDeps,
  organisationId: string,
  file: FileRow,
  kind: DownloadKind,
  mark: { id: string; key: Buffer },
  signal: AbortSignal,
): AsyncGenerator<Buffer> {
  return streamInWorkspace(deps.workDir, async function* (dir) {
    const input = join(dir, "original");
    await originalInto(deps, organisationId, file, input, signal);
    const info = file.mediaInfo?.audio ? file.mediaInfo : await probe(input, { signal });
    const audio = info.audio;
    if (!audio) throw new HTTPException(422, { message: "That recording has no sound to mark" });
    const timeoutMs = burnDeadlineMs(info.duration);
    const markPath = join(dir, "mark.wav");
    await markInThread(
      {
        input,
        output: markPath,
        key: mark.key,
        markId: mark.id,
        channels: audio.channels,
        timeoutMs,
      },
      signal,
    );
    const format = markedAudioFormat(info, kind);
    const output = join(dir, `marked.${format.extension}`);
    await run(
      "ffmpeg",
      mixArgs(
        input,
        markPath,
        {
          sampleRate: audio.sampleRate,
          channels: audio.channels,
          layout: ffmpegLayout(audio.channelLayout, audio.channels),
          format,
        },
        output,
      ),
      { signal, timeoutMs },
    );
    for await (const chunk of createReadStream(output)) yield chunk as Buffer;
  });
}

/**
 * A download as a stream that has made its first piece already, so that a file that cannot
 * be marked is an error, not a broken download. Stopping it early, as a browser that goes
 * does, ends the work and clears its workspace.
 */
async function primed(chunks: AsyncGenerator<Buffer>): Promise<Readable> {
  let first: IteratorResult<Buffer> | null = await chunks.next();
  const iterator: AsyncIterableIterator<Buffer> = {
    next: () => {
      const taken = first;
      first = null;
      return taken ? Promise.resolve(taken) : chunks.next();
    },
    return: (value?: unknown) => chunks.return(value),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return Readable.from(iterator);
}

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
      const marking = await marksFile(deps, c.var.organisationId, file);
      return c.json({ level, ...(await choices(deps.db, c.var.organisationId, file, marking)) });
    })
    .post("/:id/downloads", fileParam, zValidator("json", downloadInput), async (c) => {
      const fileId = c.req.valid("param").id;
      const { kind, marks } = c.req.valid("json");
      const actor = c.var.actor;
      const { level } = await levelFor(deps.db, actor, fileId);
      if (!allowsDownload(level, kind))
        throw new HTTPException(403, { message: "Your access to this file does not allow that" });
      const file = await fileOf(deps.db, c.var.organisationId, fileId);
      const marking = await marksFile(deps, c.var.organisationId, file);
      if (!(await choices(deps.db, c.var.organisationId, file, marking))[kind].available)
        throw new HTTPException(422, { message: "That download is not offered for this file" });
      if (marks !== undefined) await markedTrack(deps.db, actor, fileId, marks);
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
        trackId: marks ?? null,
        tokenHash: hashOf(token),
        sessionId: c.var.sessionId,
        userId: actor.kind === "guest" ? null : actor.userId,
        guestId: actor.kind === "guest" ? actor.guestId : null,
        expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000),
      });
      return c.json({ url: `/api/downloads/${token}` }, 201);
    });

/**
 * `/api/projects/:id/score-downloads`: every track's score with its marks, as one PDF (#52).
 * Asking gives a link as a file's download does: once, in this session, for five minutes.
 */
export const projectScoreDownloadRoutes = (deps: DownloadDeps) =>
  new Hono<{ Variables: TenantVariables }>().post(
    "/:id/score-downloads",
    fileParam,
    zValidator("json", scoresDownloadInput),
    async (c) => {
      const projectId = c.req.valid("param").id;
      const { kind } = c.req.valid("json");
      const actor = actorOf(c.var);
      await everyScore(deps.db, actor, projectId, kind);
      const { allowed, retryAfter } = await admit(deps.db, `download:member:${c.var.userId}`, {
        max: PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed) return tooMany(c, retryAfter, "Too many downloads this hour; try again later");
      const token = randomBytes(32).toString("base64url");
      await deps.db.insert(downloadTickets).values({
        organisationId: c.var.organisationId,
        projectId,
        kind,
        tokenHash: hashOf(token),
        sessionId: c.var.sessionId,
        userId: c.var.userId,
        expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000),
      });
      return c.json({ url: `/api/downloads/${token}` }, 201);
    },
  );

/**
 * Every score of a project, each with its track's marks over its pages, as one PDF: each in
 * the access log before anything leaves, and each page marked for whoever asked.
 */
async function sendEveryScore(
  deps: DownloadDeps,
  c: Context<{ Variables: ViewerVariables }>,
  projectId: string,
  kind: DownloadKind,
) {
  const organisationId = c.var.organisationId;
  const actor = c.var.actor;
  const scores = await everyScore(deps.db, actor, projectId, kind);
  for (const { track, file } of scores) {
    await deps.audit.record(
      organisationId,
      await deps.audit.actor(actor),
      {
        action: "download",
        projectId,
        fileId: file.id,
        details: { kind, scoreMarksOf: track.id, everyScore: true },
      },
      requestInfo(c, deps.trustProxy),
    );
    await emitEvent(deps.db, downloaded(organisationId, actor, projectId, file.id, kind));
  }
  const who = await recipientOf(deps.db, actor);
  const [project] = await deps.db
    .select({ name: projects.name, watermark: projects.watermark })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
  const mark: Mark = {
    text: watermarkText(who, who.organisation, new Date()),
    style: watermarkOf(project?.watermark),
    signal: c.req.raw.signal,
  };
  async function* pages() {
    for (const { track, file } of scores) {
      const marked = { ...mark, overlay: await overlayOf(deps.db, organisationId, track) };
      yield* kind === "proxy"
        ? reviewedPages(deps, organisationId, file.id, marked)
        : printPages(deps, organisationId, file, marked);
    }
  }
  const stream = await primed(pdfOf(pages()));
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      ...PRIVATE,
      "content-type": "application/pdf",
      "content-disposition": attachment(`${project?.name ?? "Project"} scores (annotated).pdf`),
    },
  });
}

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
      if (ticket.kind === "attachment" && !ticket.attachmentId)
        throw new HTTPException(410, { message: "That download link no longer works" });
      // Every score of a project (#52): its own checks, a record for each score.
      if (ticket.projectId) {
        if (ticket.kind === "attachment")
          throw new HTTPException(410, { message: "That download link no longer works" });
        return sendEveryScore(deps, c, ticket.projectId, ticket.kind);
      }
      const fileId = ticket.fileId;
      if (!fileId) throw new HTTPException(410, { message: "That download link no longer works" });
      // A comment's attachment (#133): its own checks, its own record.
      if (ticket.attachmentId)
        return sendAttachment(deps, c, { fileId, attachmentId: ticket.attachmentId });
      const actor = c.var.actor;
      const { level } = await levelFor(deps.db, actor, fileId);
      if (ticket.kind === "attachment")
        throw new HTTPException(410, { message: "That download link no longer works" });
      const kind: DownloadKind = ticket.kind;
      if (!allowsDownload(level, kind))
        throw new HTTPException(403, { message: "Your access to this file does not allow that" });
      const file = await fileOf(deps.db, organisationId, fileId);
      // Asked with the score marks: still the track's score, still theirs to see.
      const track = ticket.trackId
        ? await markedTrack(deps.db, actor, file.id, ticket.trackId)
        : null;
      // No record, no download.
      const record = await deps.audit.record(
        organisationId,
        await deps.audit.actor(actor),
        {
          action: "download",
          projectId: file.projectId,
          fileId: file.id,
          reviewId: (await grantingReview(deps.db, actor, file.id, kind)) ?? undefined,
          details: track ? { kind, scoreMarksOf: track.id } : { kind },
        },
        requestInfo(c, deps.trustProxy),
      );
      await emitEvent(deps.db, downloaded(organisationId, actor, file.projectId, file.id, kind));
      // A recording, marked for whoever asked (#32), the mark written down before it is made.
      if (file.kind === "audio" && (await marksFile(deps, organisationId, file))) {
        const mark = await issueMark(deps.db, deps.keyring, {
          organisationId,
          accessEventId: record.id,
          file,
          kind,
          recipient: {
            userId: actor.kind === "guest" ? undefined : actor.userId,
            guestId: actor.kind === "guest" ? actor.guestId : undefined,
            label: record.actorLabel,
          },
          reviewId: record.reviewId,
        });
        const format = markedAudioFormat(file.mediaInfo, kind);
        // A recording that cannot be marked does not leave unmarked.
        const stream = await primed(
          markedAudio(deps, organisationId, file, kind, mark, c.req.raw.signal),
        ).catch((error: unknown) => {
          if (error instanceof MediaToolError)
            throw new HTTPException(422, {
              message: "This recording could not be marked, so it cannot be downloaded",
            });
          throw error;
        });
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": format.contentType,
            "content-disposition": attachment(`${stem(file.name)}.${format.extension}`),
          },
        });
      }
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
        const rendition = await audioRendition(deps.db, organisationId, file.id);
        if (!rendition) throw new NotFound("Rendition");
        const stream = Readable.from(decrypted(deps, organisationId, rendition));
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "audio/mp4",
            "content-disposition": attachment(`${stem(file.name)}.m4a`),
          },
        });
      }
      if (file.kind !== "image" && file.kind !== "document" && file.kind !== "video")
        throw new HTTPException(422, { message: "That download is not offered for this file" });
      // Always marked for whoever asked, whatever the project's scope; drawn where and as
      // strongly as the project chose (#31).
      const who = await recipientOf(deps.db, actor);
      const [project] = await deps.db
        .select({ watermark: projects.watermark })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, file.projectId)));
      const mark: Mark = {
        text: watermarkText(who, who.organisation, new Date()),
        style: watermarkOf(project?.watermark),
        signal: c.req.raw.signal,
        overlay: track ? await overlayOf(deps.db, organisationId, track) : undefined,
      };
      if (file.kind === "video") {
        const stream = await primed(markedVideo(deps, organisationId, file, kind, mark));
        const format = burnFormat[kind];
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": format.contentType,
            "content-disposition": attachment(`${stem(file.name)}.${format.extension}`),
          },
        });
      }
      if (file.kind === "document") {
        if (kind === "original" && !isPdf(file.name, file.contentType))
          throw new HTTPException(422, { message: "That download is not offered for this file" });
        const pages =
          kind === "proxy"
            ? reviewedPages(deps, organisationId, file.id, mark)
            : printPages(deps, organisationId, file, mark);
        const stream = await primed(pdfOf(pages));
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "application/pdf",
            "content-disposition": attachment(
              `${stem(file.name)}${track ? " (annotated)" : ""}.pdf`,
            ),
          },
        });
      }
      if (kind === "original") {
        const format = markedFormatOf(file.name, file.contentType);
        const stream = await primed(markedOriginal(deps, organisationId, file, format, mark));
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": `image/${format}`,
            "content-disposition": attachment(`${stem(file.name)}.${extensionOf[format]}`),
          },
        });
      }
      {
        const page = await firstPage(deps.db, organisationId, file.id);
        if (!page) throw new NotFound("Page");
        const { stream } = await deps.storage.open(organisationId, page.blobId);
        const marked = await watermark(
          Buffer.concat(await stream.toArray()),
          mark.text,
          "view",
          mark.signal,
          mark.style,
          "webp",
          deps.workDir,
        );
        return c.body(new Uint8Array(marked), 200, {
          ...PRIVATE,
          "content-type": "image/webp",
          "content-length": String(marked.length),
          "content-disposition": attachment(`${stem(file.name)}.webp`),
        });
      }
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
