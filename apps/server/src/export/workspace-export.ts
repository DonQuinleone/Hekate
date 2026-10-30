import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Database, inOrg, schema, tenantTables } from "@hekate/db";
import {
  exportFileName,
  WORKSPACE_EXPORT_DAYS,
  WORKSPACE_EXPORT_LINK_SECONDS,
  type WorkspaceExport,
} from "@hekate/shared";
import {
  and,
  desc,
  eq,
  getTableColumns,
  getTableName,
  gt,
  inArray,
  lte,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Jobs } from "../jobs.ts";
import type { Blob, Storage } from "../storage.ts";
import { version as HEKATE_VERSION } from "../version.ts";
import { ageEncryptor, generateIdentity } from "./age.ts";
import { type TarEntry, tarStream } from "./tar.ts";

const { workspaceExports, organisations, users, members } = schema;

type Row = typeof workspaceExports.$inferSelect;

/**
 * A workspace's export (#186, decision 220): everything it holds, as an owner or an operator
 * takes it away. Its records go as JSON, a table at a time and without a secret among them;
 * its files' originals, its comments' attachments and its caption files go as they were
 * uploaded, read through decryption. The whole is one tar archive, encrypted with age to a key
 * whose secret was shown once to whoever asked (or to their own), stored as ordinary encrypted
 * blobs, and kept a week for its download.
 */

/**
 * Tables left out of the records: keys, the hashes of tokens and links that work only here,
 * downloads and uploads under way, listening rooms and who is in them (#200), and how
 * renditions are encrypted. None of it means anything outside this instance, and some of it
 * would be a way in.
 */
export const tablesLeftOut = new Set([
  "organisation_keys",
  "guest_links",
  "guest_sessions",
  "download_tickets",
  "calendar_feeds",
  "uploads",
  "upload_parts",
  "upload_request_uploads",
  "listening_rooms",
  "listening_room_people",
  "renditions",
  "rendition_segments",
  "workspace_exports",
  // An application's codes and refresh tokens (#447): ways in, minutes or days long.
  "oauth_codes",
  "oauth_refresh_tokens",
]);

/** Columns left out wherever they are: wrapped keys, sealed secrets and the hashes of codes. */
export const columnsLeftOut = new Set([
  "wrapped_key",
  "key_version",
  "token_hash",
  "password_hash",
  "code_hash",
  "config_sealed",
  "credentials_sealed",
  "bind_password_sealed",
  "bind_password_key_version",
  "nonce_prefix",
  "iv",
  "init_iv",
  "backend_upload_id",
]);

/** Columns left out of one table: where a blob is kept, and an identity provider's secrets. */
export const tableColumnsLeftOut: Record<string, readonly string[]> = {
  blobs: ["key", "backend"],
  // Whose browser drives a session's takes from a recorder this minute (decision 240).
  sessions: ["recorder_kind", "recorder_by", "recorder_seen_at", "recorder_claim"],
  sso_providers: ["oidc_config", "saml_config"],
  billing_accounts: ["checkout_url"],
  // A client's secret, hashed, and its first characters (#447).
  oauth_clients: ["secret_hash", "secret_hint"],
};

/** A table without an `id` is read in pages by this column. */
const pageColumn: Record<string, string> = { upload_request_files: "file_id" };

/** The tables whose rows the archive holds, by name, with the columns it keeps. */
export function recordTables(): { name: string; columns: string[]; page: string }[] {
  return tenantTables
    .map((table) => {
      const name = getTableName(table);
      const columns = Object.values(getTableColumns(table))
        .map((c) => c.name)
        .filter((c) => !columnsLeftOut.has(c) && !(tableColumnsLeftOut[name] ?? []).includes(c));
      return { name, columns, page: pageColumn[name] ?? "id" };
    })
    .filter((t) => !tablesLeftOut.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Rows to one records file. */
const PAGE = 5_000;
/** The largest part of an archive stored as one object: well inside what S3 takes in one. */
export const EXPORT_PART_BYTES = 64 * 1024 ** 3;

/** One path segment, as any file system takes it: no slashes, no controls, never `.` or `..`. */
export function segment(name: string): string {
  const clean = name
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .trim()
    .slice(0, 200);
  return clean === "" || clean === "." || clean === ".." ? "_" : clean;
}

/** A path not yet taken: " (2)", " (3)" and so on before the extension of one that is. */
export function unique(path: string, taken: Set<string>): string {
  let candidate = path;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) {
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    const at = dot > slash + 1 ? dot : path.length;
    candidate = `${path.slice(0, at)} (${n})${path.slice(at)}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

interface StoredFile {
  id: string;
  of: "file" | "attachment" | "caption";
  path: string;
  blobId: string;
  byteSize: number;
  sha256: string | null;
  modified: Date;
}

/** Every stored file the archive holds, with the path it has there. */
async function storedFiles(db: Database, organisationId: string): Promise<StoredFile[]> {
  const { files, folders, projects, blobs, commentAttachments, comments, captionTracks } = schema;
  const projectNames = new Map(
    (
      await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inOrg(projects, organisationId))
    ).map((p) => [p.id, p.name]),
  );
  const folderRows = await db
    .select({ id: folders.id, parentId: folders.parentId, name: folders.name })
    .from(folders)
    .where(inOrg(folders, organisationId));
  const byId = new Map(folderRows.map((f) => [f.id, f]));
  const folderPath = (id: string | null): string[] => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let at = id ? byId.get(id) : undefined; at && !seen.has(at.id); ) {
      seen.add(at.id);
      parts.unshift(segment(at.name));
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
    return parts;
  };
  const taken = new Set<string>();
  const out: StoredFile[] = [];
  const fileRows = await db
    .select({
      id: files.id,
      projectId: files.projectId,
      folderId: files.folderId,
      name: files.name,
      blobId: blobs.id,
      byteSize: blobs.byteSize,
      sha256: blobs.sha256,
      createdAt: files.createdAt,
    })
    .from(files)
    .innerJoin(blobs, inOrg(blobs, organisationId, eq(blobs.id, files.blobId)))
    .where(inOrg(files, organisationId))
    .orderBy(files.id);
  for (const f of fileRows) {
    const project = segment(projectNames.get(f.projectId) ?? f.projectId);
    const path = ["files", project, ...folderPath(f.folderId), segment(f.name)].join("/");
    out.push({
      id: f.id,
      of: "file",
      path: unique(path, taken),
      blobId: f.blobId,
      byteSize: f.byteSize,
      sha256: f.sha256,
      modified: f.createdAt,
    });
  }
  const attachmentRows = await db
    .select({
      id: commentAttachments.id,
      commentId: commentAttachments.commentId,
      name: commentAttachments.name,
      blobId: blobs.id,
      byteSize: blobs.byteSize,
      sha256: blobs.sha256,
      createdAt: commentAttachments.createdAt,
    })
    .from(commentAttachments)
    .innerJoin(blobs, inOrg(blobs, organisationId, eq(blobs.id, commentAttachments.blobId)))
    .innerJoin(
      comments,
      inOrg(comments, organisationId, eq(comments.id, commentAttachments.commentId)),
    )
    .where(inOrg(commentAttachments, organisationId))
    .orderBy(commentAttachments.id);
  for (const a of attachmentRows) {
    out.push({
      id: a.id,
      of: "attachment",
      path: unique(`attachments/${a.commentId}/${segment(a.name)}`, taken),
      blobId: a.blobId,
      byteSize: a.byteSize,
      sha256: a.sha256,
      modified: a.createdAt,
    });
  }
  const captionRows = await db
    .select({
      id: captionTracks.id,
      fileId: captionTracks.fileId,
      name: captionTracks.name,
      blobId: blobs.id,
      byteSize: blobs.byteSize,
      sha256: blobs.sha256,
      createdAt: captionTracks.createdAt,
    })
    .from(captionTracks)
    .innerJoin(blobs, inOrg(blobs, organisationId, eq(blobs.id, captionTracks.blobId)))
    .where(inOrg(captionTracks, organisationId))
    .orderBy(captionTracks.id);
  for (const c of captionRows) {
    out.push({
      id: c.id,
      of: "caption",
      path: unique(`captions/${c.fileId}/${segment(c.name)}`, taken),
      blobId: c.blobId,
      byteSize: c.byteSize,
      sha256: c.sha256,
      modified: c.createdAt,
    });
  }
  return out;
}

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const readme = (name: string, made: Date) => `Hekate workspace export

Workspace: ${name}
Made: ${made.toISOString()}

What is here
  manifest.json      What the archive holds: every stored file, where it is, its size and
                     SHA-256, and the record files of each table.
  workspace.json     The workspace itself: its name, address and settings.
  records/           Every table of the workspace as JSON, one file per table (or per 5,000
                     rows of a larger one). Wrapped keys, sealed secrets and the hashes of
                     links and codes are left out: they mean nothing outside the instance.
  records/people.json  The members' accounts: their names and email addresses.
  files/             Every file as it was uploaded, by project and folder.
  attachments/       Files attached to comments, by comment.
  captions/          Caption files, by the file they caption.
  missing.json       Only if some stored file could not be read when the archive was made.

The files are the originals, without watermarks. Keep the archive as you would keep them.
`;

/** Records of one table, in files of up to PAGE rows, as tar entries. */
async function* tableEntries(
  db: Database,
  organisationId: string,
  table: { name: string; columns: string[]; page: string },
  root: string,
  made: Date,
  counted: Map<string, { rows: number; files: string[] }>,
): AsyncGenerator<TarEntry> {
  const tally = { rows: 0, files: [] as string[] };
  counted.set(table.name, tally);
  let after: unknown = null;
  let n = 0;
  for (;;) {
    const columns = sql.join(
      table.columns.map((c) => sql.identifier(c)),
      sql`, `,
    );
    const key = sql.identifier(table.page);
    const rows = await db.execute<Record<string, unknown>>(
      sql`select ${columns} from ${sql.identifier(table.name)}
          where organisation_id = ${organisationId}
          ${after === null ? sql`` : sql`and ${key} > ${after}`}
          order by ${key} limit ${PAGE + 1}`,
    );
    const page = rows.slice(0, PAGE);
    const more = rows.length > PAGE;
    n += 1;
    tally.rows += page.length;
    // A table that fits one file is named after the table; a larger one is numbered.
    const name =
      n === 1 && !more
        ? `records/${table.name}.json`
        : `records/${table.name}-${String(n).padStart(4, "0")}.json`;
    tally.files.push(name);
    const body = json(page);
    yield { path: `${root}/${name}`, size: body.length, modified: made, body };
    if (!more) break;
    after = page.at(-1)?.[table.page];
  }
}

/** The archive's entries, in order. */
async function* entriesOf(
  deps: { db: Database; storage: Storage },
  organisationId: string,
  made: Date,
  /** Counts the stored files it holds, as it goes. */
  tally: { files: number },
  signal?: AbortSignal,
): AsyncGenerator<TarEntry> {
  const { db, storage } = deps;
  const [workspace] = await db
    .select({
      id: organisations.id,
      name: organisations.name,
      slug: organisations.slug,
      settings: organisations.settings,
      createdAt: organisations.createdAt,
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  if (!workspace) throw new Error("The workspace is gone");
  const root = `${workspace.slug}-export`;
  const stored = await storedFiles(db, organisationId);
  const tables = recordTables();
  const counted = new Map<string, { rows: number; files: string[] }>();
  const text = (path: string, body: Buffer): TarEntry => ({
    path: `${root}/${path}`,
    size: body.length,
    modified: made,
    body,
  });
  yield text("README.txt", Buffer.from(readme(workspace.name, made)));
  yield text("workspace.json", json(workspace));
  const people = await db
    .select({ userId: members.userId, role: members.role, name: users.name, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(inOrg(members, organisationId))
    .orderBy(users.name);
  yield text("records/people.json", json(people));
  for (const table of tables) {
    signal?.throwIfAborted();
    yield* tableEntries(db, organisationId, table, root, made, counted);
  }
  yield text(
    "manifest.json",
    json({
      format: "hekate-workspace-export",
      version: 1,
      hekate: HEKATE_VERSION,
      made: made.toISOString(),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      records: Object.fromEntries(counted),
      files: stored.map(({ id, of, path, byteSize, sha256 }) => ({
        id,
        of,
        path,
        byteSize,
        sha256,
      })),
    }),
  );
  const missing: { id: string; path: string }[] = [];
  for (const file of stored) {
    signal?.throwIfAborted();
    let body: Readable;
    try {
      body = (await storage.open(organisationId, file.blobId)).stream;
    } catch (error) {
      // Named in the archive without the error, which may say where the server keeps things.
      console.warn(`Export of ${organisationId}: could not read ${file.blobId}: ${String(error)}`);
      missing.push({ id: file.id, path: file.path });
      continue;
    }
    tally.files += 1;
    yield { path: `${root}/${file.path}`, size: file.byteSize, modified: file.modified, body };
  }
  if (missing.length > 0) yield text("missing.json", json(missing));
}

/**
 * Stores a stream as blobs of at most `partBytes` each, in order, so an archive larger than a
 * backend takes as one object is still kept. A part starts only once there is something for it.
 * If anything fails, the parts already stored are removed.
 */
export async function putInParts(
  storage: Storage,
  organisationId: string,
  source: AsyncIterable<Buffer>,
  partBytes: number,
  /** Hears of each part once it is stored. */
  onPart?: (part: Blob) => Promise<void>,
): Promise<Blob[]> {
  const stored: Blob[] = [];
  let current: { pass: PassThrough; put: Promise<Blob>; left: number } | null = null;
  const finish = async () => {
    if (!current) return;
    const { pass, put } = current;
    current = null;
    pass.end();
    const part = await put;
    stored.push(part);
    await onPart?.(part);
  };
  try {
    for await (const chunk of source) {
      let rest = chunk;
      while (rest.length > 0) {
        if (!current) {
          const pass = new PassThrough();
          const put = storage.put(organisationId, pass, {
            contentType: "application/octet-stream",
          });
          // Seen by whoever awaits it; this keeps an early failure from going unhandled.
          put.catch(() => undefined);
          current = { pass, put, left: partBytes };
        }
        const piece = rest.subarray(0, current.left);
        rest = rest.subarray(piece.length);
        current.left -= piece.length;
        if (!current.pass.write(piece))
          await Promise.race([once(current.pass, "drain"), current.put]);
        if (current.left === 0) await finish();
      }
    }
    await finish();
    return stored;
  } catch (error) {
    const left = current as { pass: PassThrough; put: Promise<Blob> } | null;
    if (left) {
      left.pass.destroy(error as Error);
      const blob = await left.put.catch(() => null);
      if (blob) stored.push(blob);
    }
    for (const blob of stored)
      await storage.remove(organisationId, blob.id).catch((cause: unknown) => {
        console.warn(`Could not remove part ${blob.id} of a failed export: ${String(cause)}`);
      });
    throw error;
  }
}

/** The parts an export being made has stored so far. */
async function setParts(db: Database, organisationId: string, exportId: string, value: SQL) {
  await db
    .update(workspaceExports)
    .set({ blobIds: value, updatedAt: new Date() })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.id, exportId),
        eq(workspaceExports.status, "building"),
      ),
    );
}

export interface ExportDeps {
  db: Database;
  storage: Storage;
  /** For tests: smaller parts. */
  partBytes?: number;
}

/**
 * Makes an export's archive (the `workspace-export` job). Its row says what to make; once
 * made, it is ready for a week. An export that is already ready, failed or gone is left alone.
 */
export async function buildExport(
  deps: ExportDeps,
  organisationId: string,
  exportId: string,
  signal?: AbortSignal,
): Promise<void> {
  const { db, storage } = deps;
  const [claimed] = await db
    .update(workspaceExports)
    .set({ status: "building", updatedAt: new Date() })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.id, exportId),
        inArray(workspaceExports.status, ["queued", "building"]),
      ),
    )
    .returning();
  if (!claimed) return;
  // Parts an attempt that died left behind: the archive starts again from nothing.
  for (const blobId of claimed.blobIds)
    await storage.remove(organisationId, blobId).catch(() => undefined);
  await setParts(db, organisationId, exportId, sql`'{}'::uuid[]`);
  const made = new Date();
  const tally = { files: 0 };
  const tar = Readable.from(tarStream(entriesOf(deps, organisationId, made, tally, signal)));
  const encrypted = new PassThrough();
  const piping = pipeline(
    tar,
    ageEncryptor([claimed.recipient]),
    encrypted,
    signal ? { signal } : {},
  );
  // A failure on the way in reaches the parts being stored, which are then removed.
  piping.catch((error: unknown) => encrypted.destroy(error as Error));
  let parts: Blob[];
  try {
    parts = await putInParts(
      storage,
      organisationId,
      encrypted,
      deps.partBytes ?? EXPORT_PART_BYTES,
      // Each part is the export's as soon as it is stored, so reconciliation leaves it alone.
      (part) =>
        setParts(db, organisationId, exportId, sql`array_append(blob_ids, ${part.id}::uuid)`),
    );
    await piping;
  } catch (error) {
    tar.destroy();
    await piping.catch(() => undefined);
    throw error;
  }
  const fileCount = tally.files;
  const now = new Date();
  const [ready] = await db
    .update(workspaceExports)
    .set({
      status: "ready",
      blobIds: parts.map((p) => p.id),
      byteSize: parts.reduce((sum, p) => sum + p.byteSize, 0),
      fileCount,
      finishedAt: now,
      expiresAt: new Date(now.getTime() + WORKSPACE_EXPORT_DAYS * 24 * 60 * 60 * 1000),
      updatedAt: now,
    })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.id, exportId),
        eq(workspaceExports.status, "building"),
      ),
    )
    .returning({ id: workspaceExports.id });
  // Gone meanwhile (the workspace purged, or the export failed by the sweep): so are its parts.
  if (!ready)
    for (const part of parts) await storage.remove(organisationId, part.id).catch(() => undefined);
}

/** An export that failed for the last time: what its list says. */
export async function exportFailed(db: Database, organisationId: string, exportId: string) {
  await db
    .update(workspaceExports)
    .set({
      status: "failed",
      blobIds: [],
      error: "It could not be made. Try again, or ask the instance's operators.",
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.id, exportId),
        inArray(workspaceExports.status, ["queued", "building"]),
      ),
    );
}

/** An export still being made this long after it was asked for has lost its job. */
const STALE_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Removes archives past their week, and fails exports whose job was lost. Hourly, with the
 * workspaces' purge. Returns how many archives it removed.
 */
export async function expireExports(db: Database, storage: Storage, now = new Date()) {
  const due = await db
    .select({
      id: workspaceExports.id,
      organisationId: workspaceExports.organisationId,
      blobIds: workspaceExports.blobIds,
    })
    .from(workspaceExports)
    .where(and(eq(workspaceExports.status, "ready"), lte(workspaceExports.expiresAt, now)));
  let removed = 0;
  for (const row of due) {
    try {
      for (const blobId of row.blobIds) await storage.remove(row.organisationId, blobId);
    } catch (error) {
      // Tried again next hour; until then it stays ready but cannot be downloaded (see below).
      console.warn(`Could not remove export ${row.id}: ${String(error)}`);
      continue;
    }
    await db
      .update(workspaceExports)
      .set({ status: "expired", blobIds: [], ticketHash: null, updatedAt: now })
      .where(inOrg(workspaceExports, row.organisationId, eq(workspaceExports.id, row.id)));
    removed += 1;
  }
  const stale = new Date(now.getTime() - STALE_MS);
  const lost = await db
    .select({ id: workspaceExports.id, organisationId: workspaceExports.organisationId })
    .from(workspaceExports)
    .where(
      and(
        inArray(workspaceExports.status, ["queued", "building"]),
        lte(workspaceExports.updatedAt, stale),
      ),
    );
  for (const row of lost) await exportFailed(db, row.organisationId, row.id);
  return removed;
}

/** An export as its list shows it. */
export async function exportsOf(
  db: Database,
  organisationId: string,
  limit = 10,
): Promise<WorkspaceExport[]> {
  const rows = await db
    .select({ row: workspaceExports, name: users.name })
    .from(workspaceExports)
    .leftJoin(users, eq(users.id, workspaceExports.requestedBy))
    .where(inOrg(workspaceExports, organisationId))
    .orderBy(desc(workspaceExports.id))
    .limit(limit);
  return rows.map(({ row, name }) => viewOf(row, name));
}

export const viewOf = (row: Row, requestedBy: string | null): WorkspaceExport => ({
  id: row.id,
  status: row.status,
  requestedBy,
  byOperator: row.byOperator,
  recipient: row.recipient,
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  byteSize: row.byteSize,
  fileCount: row.fileCount,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  error: row.error,
});

export class ExportRefused extends Error {
  override name = "ExportRefused";
  readonly status: 404 | 409 | 410;
  constructor(status: 404 | 409 | 410, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Starts an export: one at a time for each workspace. Encrypted to the person's own age key if
 * they gave one; otherwise to a key made for it, whose secret is returned now, to be shown once,
 * and kept nowhere.
 */
export async function startExport(
  deps: { db: Database; jobs: Pick<Jobs, "send"> },
  input: {
    organisationId: string;
    requestedBy: string;
    byOperator: boolean;
    recipient?: string | undefined;
  },
  record: (tx: Pick<Database, "insert">, exportId: string, ownKey: boolean) => Promise<unknown>,
): Promise<{ row: Row; key: string | null }> {
  const identity = input.recipient ? null : generateIdentity();
  const recipient = input.recipient ?? identity?.recipient ?? "";
  const row = await deps.db.transaction(async (tx) => {
    // One at a time: the workspace's row is the lock two requests at once both take.
    await tx
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, input.organisationId))
      .for("update");
    const [running] = await tx
      .select({ id: workspaceExports.id })
      .from(workspaceExports)
      .where(
        inOrg(
          workspaceExports,
          input.organisationId,
          inArray(workspaceExports.status, ["queued", "building"]),
        ),
      );
    if (running) throw new ExportRefused(409, "An export of this workspace is already being made");
    const [made] = await tx
      .insert(workspaceExports)
      .values({
        organisationId: input.organisationId,
        requestedBy: input.requestedBy,
        byOperator: input.byOperator,
        recipient,
      })
      .returning();
    if (!made) throw new Error("The export was not recorded");
    await record(tx, made.id, !identity);
    return made;
  });
  await deps.jobs.send(
    "workspace-export",
    { organisationId: input.organisationId, exportId: row.id },
    { singletonKey: `export:${row.id}` },
  );
  return { row, key: identity?.secretKey ?? null };
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A one-time link to a ready archive, for this session, for five minutes; it replaces any other. */
export async function exportTicket(
  db: Database,
  organisationId: string,
  exportId: string,
  sessionId: string,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db
    .update(workspaceExports)
    .set({
      ticketHash: hashOf(token),
      ticketSessionId: sessionId,
      ticketExpiresAt: new Date(Date.now() + WORKSPACE_EXPORT_LINK_SECONDS * 1000),
    })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.id, exportId),
        eq(workspaceExports.status, "ready"),
        gt(workspaceExports.expiresAt, new Date()),
      ),
    )
    .returning({ id: workspaceExports.id });
  if (!row) throw new ExportRefused(404, "That export is not ready, or has gone");
  return token;
}

/**
 * The archive a link was made for, the link spent as it is used: only in the session that asked,
 * within its five minutes, and once. The caller logs it before sending a byte.
 */
export async function redeemExportTicket(
  db: Database,
  organisationId: string,
  token: string,
  sessionId: string,
): Promise<Row> {
  const now = new Date();
  const [row] = await db
    .update(workspaceExports)
    .set({ ticketHash: null, ticketSessionId: null, ticketExpiresAt: null })
    .where(
      inOrg(
        workspaceExports,
        organisationId,
        eq(workspaceExports.ticketHash, hashOf(token)),
        eq(workspaceExports.ticketSessionId, sessionId),
        gt(workspaceExports.ticketExpiresAt, now),
        eq(workspaceExports.status, "ready"),
        gt(workspaceExports.expiresAt, now),
      ),
    )
    .returning();
  if (!row) throw new ExportRefused(410, "That download link has been used or has expired");
  return row;
}

/** The archive as one download: its parts one after another, decrypted from storage. */
export async function exportResponse(db: Database, storage: Storage, row: Row): Promise<Response> {
  const [workspace] = await db
    .select({ slug: organisations.slug })
    .from(organisations)
    .where(eq(organisations.id, row.organisationId));
  async function* parts() {
    for (const blobId of row.blobIds) {
      const { stream } = await storage.open(row.organisationId, blobId);
      yield* stream as AsyncIterable<Buffer>;
    }
  }
  const name = exportFileName(workspace?.slug ?? "workspace", row.finishedAt ?? row.createdAt);
  return new Response(Readable.toWeb(Readable.from(parts())) as ReadableStream, {
    headers: {
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-type": "application/octet-stream",
      "content-length": String(row.byteSize ?? 0),
      "content-disposition": `attachment; filename="${name}"`,
    },
  });
}
