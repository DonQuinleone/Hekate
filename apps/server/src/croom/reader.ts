import { createWriteStream } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";
import { withWorkspace } from "../media/workspace.ts";

/**
 * Reading a ControlRoom project file (#57, decision 242). A `.croom` file is an event-sourced
 * SQLite database of four tables: `meta` (the schema version, the head, and the desktop app's
 * view state under `ui.*`), `events` (`seq`, `ts`, `type`, a JSON `payload` and `branch`: 0 is
 * the project as it stands, 1 holds undone events), `blobs` (embedded PDFs) and
 * `sqlite_sequence`. This module only opens and checks the file and reads it out; what the
 * events mean is the replay's (`replay.ts`).
 */

/** A file that is not a ControlRoom project, or not one this reader can open. */
export class CroomError extends Error {
  override name = "CroomError";
}

/**
 * The schema versions the event mapping was written against. Provisional (decision 242): the
 * mapping is unverified against a real file, so another version is read all the same and the
 * report says so, rather than refused.
 */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [1];

export interface CroomEvent {
  seq: number;
  ts: string | null;
  type: string;
  /** The parsed payload; undefined where it was not JSON. */
  payload: unknown;
  /** Why the payload could not be read, where it could not. */
  payloadError?: string;
}

export interface CroomFile {
  schemaVersion: number;
  /** The `head` meta value as written; what it points at is unverified. */
  head: string | null;
  /** Every meta value but the view state. */
  meta: Record<string, string>;
  /** How many `ui.*` values the file holds: view state, never imported. */
  viewState: number;
  /** Branch 0, in `seq` order: what replaying rebuilds the project from. */
  events: CroomEvent[];
  /** Events on branch 1: undone, so never replayed. */
  undone: number;
  /** Events on any other branch, also never replayed. */
  otherBranches: number;
  /** Each embedded blob's id and size, without its bytes. */
  blobs: Map<string, number>;
}

/** An open project file: what it holds, and its blobs' bytes on demand. */
export interface CroomSource {
  file: CroomFile;
  blob(id: string): Uint8Array | null;
  close(): void;
}

const REQUIRED_TABLES = ["meta", "events", "blobs", "sqlite_sequence"] as const;
const EVENT_COLUMNS = ["seq", "ts", "type", "payload", "branch"] as const;

/** A column of a table, matched by name from those that might hold it. */
function columnOf(columns: { name: string; type: string }[], names: string[]): string | null {
  for (const name of names) {
    const found = columns.find((c) => c.name.toLowerCase() === name);
    if (found) return found.name;
  }
  return null;
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Opens a `.croom` file at `path` read-only and checks it is one before anything is read. */
export function openCroom(path: string): CroomSource {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  } catch {
    throw new CroomError("This is not a ControlRoom project file");
  }
  try {
    let tables: string[];
    try {
      tables = (
        db.prepare("select name from sqlite_master where type = 'table'").all() as {
          name: string;
        }[]
      ).map((t) => t.name);
    } catch {
      throw new CroomError("This is not a ControlRoom project file");
    }
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length > 0)
      throw new CroomError(
        `This is not a ControlRoom project file: it has no ${missing.join(", ")} table`,
      );
    const columns = (table: string) =>
      db.prepare(`select name, type from pragma_table_info(?)`).all(table) as {
        name: string;
        type: string;
      }[];

    const eventColumns = columns("events").map((c) => c.name.toLowerCase());
    const lacking = EVENT_COLUMNS.filter((c) => !eventColumns.includes(c));
    if (lacking.length > 0)
      throw new CroomError(`The file's events have no ${lacking.join(", ")}: it cannot be replayed`);

    // The meta table's columns are not known for certain: a key and a value, by likely names.
    const metaColumns = columns("meta");
    const keyColumn = columnOf(metaColumns, ["key", "name", "k"]);
    const valueColumn = columnOf(metaColumns, ["value", "val", "v"]);
    if (!keyColumn || !valueColumn)
      throw new CroomError("The file's meta table has no key and value");
    const meta: Record<string, string> = {};
    let viewState = 0;
    for (const row of db
      .prepare(`select ${quoted(keyColumn)} as k, ${quoted(valueColumn)} as v from meta`)
      .all() as { k: unknown; v: unknown }[]) {
      const key = String(row.k);
      if (key.startsWith("ui.")) {
        viewState += 1;
        continue;
      }
      meta[key] = row.v == null ? "" : String(row.v);
    }
    const version = Number(meta.schema_version);
    if (!meta.schema_version || !Number.isInteger(version) || version < 1)
      throw new CroomError("The file does not say which ControlRoom schema it was written in");

    const events: CroomEvent[] = [];
    let undone = 0;
    let otherBranches = 0;
    for (const row of db
      .prepare("select seq, ts, type, payload, branch from events order by seq")
      .all() as { seq: number; ts: unknown; type: unknown; payload: unknown; branch: unknown }[]) {
      const branch = Number(row.branch ?? 0);
      if (branch === 1) {
        undone += 1;
        continue;
      }
      if (branch !== 0) {
        otherBranches += 1;
        continue;
      }
      events.push(eventOf(row));
    }

    // The blobs' columns are not known either: an id, and the bytes.
    const blobColumns = columns("blobs");
    const idColumn = columnOf(blobColumns, ["id", "blob_id", "hash", "key", "name", "rowid"]);
    const dataColumn =
      columnOf(blobColumns, ["data", "bytes", "content", "blob", "body", "pdf"]) ??
      blobColumns.find((c) => c.type.toUpperCase() === "BLOB")?.name ??
      null;
    const blobs = new Map<string, number>();
    const idExpression = idColumn ? quoted(idColumn) : "rowid";
    if (dataColumn) {
      for (const row of db
        .prepare(`select ${idExpression} as id, length(${quoted(dataColumn)}) as size from blobs`)
        .all() as { id: unknown; size: unknown }[])
        blobs.set(String(row.id), Number(row.size ?? 0));
    }
    const readBlob = dataColumn
      ? db.prepare(`select ${quoted(dataColumn)} as data from blobs where ${idExpression} = ?`)
      : null;

    return {
      file: {
        schemaVersion: version,
        head: meta.head ?? null,
        meta,
        viewState,
        events,
        undone,
        otherBranches,
        blobs,
      },
      blob(id) {
        if (!readBlob || !blobs.has(id)) return null;
        // An id read back as a number where the column is an integer.
        const row = (readBlob.get(id) ?? readBlob.get(Number(id))) as
          | { data: unknown }
          | undefined;
        const data = row?.data;
        if (data instanceof Uint8Array) return data;
        if (typeof data === "string") return Buffer.from(data, "base64");
        return null;
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    if (error instanceof CroomError) throw error;
    throw new CroomError("This ControlRoom project file could not be read");
  }
}

function eventOf(row: { seq: number; ts: unknown; type: unknown; payload: unknown }): CroomEvent {
  const event: CroomEvent = {
    seq: Number(row.seq),
    ts: row.ts == null ? null : String(row.ts),
    type: row.type == null ? "" : String(row.type),
    payload: undefined,
  };
  if (row.payload == null || row.payload === "") {
    event.payload = {};
    return event;
  }
  const text =
    row.payload instanceof Uint8Array ? Buffer.from(row.payload).toString("utf8") : row.payload;
  try {
    event.payload = JSON.parse(String(text));
  } catch {
    event.payloadError = "its payload is not JSON";
  }
  return event;
}

/**
 * Runs `task` with the `.croom` file sent in `body` open: written to a private scratch
 * directory first (node:sqlite reads files, not bytes), as the media workers do, and removed
 * when the task ends whatever happens. Refused past `maxBytes`, counted as it arrives.
 */
export async function withCroom<T>(
  workDir: string | undefined,
  body: ReadableStream<Uint8Array> | Uint8Array | null,
  maxBytes: number,
  task: (source: CroomSource) => Promise<T>,
): Promise<T> {
  if (!body) throw new CroomError("Send the .croom file");
  return withWorkspace(workDir, async (dir) => {
    const path = join(dir, "project.croom");
    if (body instanceof Uint8Array) {
      if (body.byteLength > maxBytes) throw new CroomTooLarge();
      await writeFile(path, body, { mode: 0o600 });
    } else {
      let seen = 0;
      const counting = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          seen += chunk.length;
          if (seen > maxBytes) callback(new CroomTooLarge());
          else callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>),
        counting,
        createWriteStream(path, { mode: 0o600 }),
      );
      await chmod(path, 0o600);
      if (seen === 0) throw new CroomError("The file is empty");
    }
    const source = openCroom(path);
    try {
      return await task(source);
    } finally {
      source.close();
    }
  });
}

/** A file past the size an import accepts. */
export class CroomTooLarge extends CroomError {
  override name = "CroomTooLarge";
  constructor() {
    super("The file is larger than an import accepts");
  }
}
