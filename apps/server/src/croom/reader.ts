import { createWriteStream } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withWorkspace } from "../media/workspace.ts";
import { imageSize } from "./image-size.ts";

/**
 * Reading a ControlRoom project file (#57, decision 242). A `.croom` file is ControlRoom's
 * event store (`EventStore` in its `src/core/store.cpp`): one SQLite database of three tables.
 *
 * - `meta (key text primary key, value text)`: `schema_version` ("1"), `head` (the `seq` of the
 *   last event in effect; "0" when everything is undone) and the desktop app's view state under
 *   `ui.*` (the score shown, its page, zoom and colour filter), which is never an event.
 * - `events (seq integer primary key autoincrement, ts integer not null, type text not null,
 *   payload text not null, branch integer not null default 0)`: `ts` is ms since 1970, and
 *   `payload` the event as JSON, its `type` included. Undo moves `head` back and redo forward,
 *   so the project is branch 0 up to `head`; events past it are undone and can be redone. A new
 *   event after an undo moves those to branch 1 for good. Nothing is ever deleted.
 * - `blobs (id integer primary key autoincrement, name text, bytes blob)`: the embedded files
 *   (scores, attachments, stage plan underlays), referred to by `id` from their events.
 *
 * This module only opens and checks the file and reads it out; what the events mean is the
 * replay's (`replay.ts`).
 */

/** A file that is not a ControlRoom project, or not one this reader can open. */
export class CroomError extends Error {
  override name = "CroomError";
}

/**
 * The schema versions the mapping was checked against: ControlRoom writes 1 and has written
 * nothing else. Another is read all the same, and the report says so.
 */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [1];

export interface CroomEvent {
  seq: number;
  /** When it was written: ms since 1970. */
  ts: number | null;
  /** The type in the events table; the replay reads the one in the payload, as ControlRoom does. */
  type: string;
  /** The parsed payload; undefined where it was not JSON. */
  payload: unknown;
  /** Why the payload could not be read, where it could not. */
  payloadError?: string;
}

export interface CroomFile {
  schemaVersion: number;
  /** The `head` meta value; null where the file has none. */
  head: number | null;
  /** How many `ui.*` values the file holds: view state, never imported. */
  viewState: number;
  /** Meta keys ControlRoom does not write. */
  unknownMeta: string[];
  /** The project: branch 0 up to the head, in `seq` order. */
  events: CroomEvent[];
  /** Events undone and not replayed: those past the head, and those a later event set aside. */
  undone: number;
  /** Of those, the ones past the head, which ControlRoom could still redo. */
  redoable: number;
  /** Events on a branch ControlRoom never writes, also never replayed. */
  otherBranches: number;
  /** Each embedded blob's id and size, without its bytes. */
  blobs: Map<string, number>;
  /** The size in pixels of each blob that is a picture, for an underlay's scale. */
  images: Map<string, { width: number; height: number }>;
}

/** An open project file: what it holds, and its blobs' bytes on demand. */
export interface CroomSource {
  file: CroomFile;
  blob(id: string): Uint8Array | null;
  close(): void;
}

const TABLES: Record<string, readonly string[]> = {
  meta: ["key", "value"],
  events: ["seq", "ts", "type", "payload", "branch"],
  blobs: ["id", "name", "bytes"],
};

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
    const missing = Object.keys(TABLES).filter((t) => !tables.includes(t));
    if (missing.length > 0)
      throw new CroomError(
        `This is not a ControlRoom project file: it has no ${missing.join(", ")} table`,
      );
    for (const [table, wanted] of Object.entries(TABLES)) {
      const columns = (
        db.prepare("select name from pragma_table_info(?)").all(table) as { name: string }[]
      ).map((c) => c.name.toLowerCase());
      const lacking = wanted.filter((c) => !columns.includes(c));
      if (lacking.length > 0)
        throw new CroomError(
          `This is not a ControlRoom project file: its ${table} table has no ${lacking.join(", ")}`,
        );
    }

    let schemaVersion: string | undefined;
    let headWritten: string | undefined;
    let viewState = 0;
    const unknownMeta: string[] = [];
    for (const row of db.prepare("select key, value from meta order by key").all() as {
      key: unknown;
      value: unknown;
    }[]) {
      const key = String(row.key);
      const value = row.value == null ? "" : String(row.value).trim();
      if (key.startsWith("ui.")) viewState += 1;
      else if (key === "schema_version") schemaVersion = value;
      else if (key === "head") headWritten = value;
      else unknownMeta.push(key);
    }
    const version = Number(schemaVersion);
    if (!schemaVersion || !Number.isInteger(version) || version < 1)
      throw new CroomError("The file does not say which ControlRoom schema it was written in");
    const head = headWritten !== undefined && /^\d+$/.test(headWritten) ? Number(headWritten) : null;

    const events: CroomEvent[] = [];
    let undone = 0;
    let redoable = 0;
    let otherBranches = 0;
    for (const row of db
      .prepare("select seq, ts, type, payload, branch from events order by seq")
      .all() as { seq: number; ts: unknown; type: unknown; payload: unknown; branch: unknown }[]) {
      const branch = Number(row.branch ?? 0);
      if (branch === 1) undone += 1;
      else if (branch !== 0) otherBranches += 1;
      else if (head !== null && Number(row.seq) > head) {
        undone += 1;
        redoable += 1;
      } else events.push(eventOf(row));
    }

    const blobs = new Map<string, number>();
    const images = new Map<string, { width: number; height: number }>();
    for (const row of db
      .prepare("select id, length(bytes) as size, substr(bytes, 1, 262144) as head from blobs")
      .all() as { id: unknown; size: unknown; head: unknown }[]) {
      blobs.set(String(row.id), Number(row.size ?? 0));
      const size = row.head instanceof Uint8Array ? imageSize(row.head) : null;
      if (size) images.set(String(row.id), size);
    }
    const readBlob = db.prepare("select bytes from blobs where id = ?");

    return {
      file: {
        schemaVersion: version,
        head,
        viewState,
        unknownMeta,
        events,
        undone,
        redoable,
        otherBranches,
        blobs,
        images,
      },
      blob(id) {
        if (!blobs.has(id)) return null;
        const row = readBlob.get(Number(id)) as { bytes: unknown } | undefined;
        return row?.bytes instanceof Uint8Array ? row.bytes : null;
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
  const ts = row.ts == null ? Number.NaN : Number(row.ts);
  const event: CroomEvent = {
    seq: Number(row.seq),
    ts: Number.isFinite(ts) ? ts : null,
    type: row.type == null ? "" : String(row.type),
    payload: undefined,
  };
  const text =
    row.payload instanceof Uint8Array ? Buffer.from(row.payload).toString("utf8") : row.payload;
  try {
    event.payload = JSON.parse(String(text ?? ""));
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
