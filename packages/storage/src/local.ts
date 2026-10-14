import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ObjectNotFoundError,
  RangeNotSatisfiableError,
  StorageConfigError,
  StorageError,
} from "./errors.ts";
import { assertValidKey, assertValidPrefix, assertValidRange } from "./keys.ts";
import {
  type Body,
  type ByteRange,
  type ListedObject,
  MAX_PARTS,
  MIN_PART_SIZE,
  type ObjectInfo,
  type StorageBackend,
} from "./types.ts";

export interface LocalBackendOptions {
  name: string;
  /** Directory that holds the objects. Created if missing. */
  root: string;
}

/** Writes in progress live here, inside the root so the final rename is atomic. Keys cannot start with a dot. */
const TEMP_DIR = ".tmp";
/** Unfinished multipart uploads, one directory each. */
const UPLOADS_DIR = ".uploads";
const UPLOAD_ID = /^[0-9a-f-]{36}$/;

const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Local disk. The default backend; suits a single host with a mounted volume. */
export function localBackend(options: LocalBackendOptions): StorageBackend {
  if (!options.root) throw new StorageConfigError(`Storage backend "${options.name}" needs a path`);
  const root = resolve(options.root);
  const tempDir = join(root, TEMP_DIR);
  const uploadsDir = join(root, UPLOADS_DIR);
  const uploadDir = (uploadId: string) => {
    if (!UPLOAD_ID.test(uploadId)) throw new StorageError(`Unknown upload "${uploadId}"`);
    return join(uploadsDir, uploadId);
  };
  const assertPartNumber = (n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) {
      throw new StorageError(`Part numbers run from 1 to ${MAX_PARTS}`);
    }
  };

  const pathOf = (key: string) => {
    assertValidKey(key);
    const path = resolve(root, key);
    // Belt and braces: valid keys cannot escape, but never touch anything outside the root.
    const rel = relative(root, path);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new StorageConfigError(`Key "${key}" resolves outside the storage root`);
    }
    return path;
  };

  const fsync = async (path: string) => {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };

  /** Remove empty directories left behind by deletes, stopping at the root. */
  const prune = async (dir: string) => {
    let current = dir;
    while (current !== root && current.startsWith(root + sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  };

  async function* walk(dir: string): AsyncGenerator<string> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    // Match S3's byte order: a directory's keys all start with "name/".
    const sortName = (e: import("node:fs").Dirent) => (e.isDirectory() ? `${e.name}/` : e.name);
    entries.sort((a, b) => {
      const x = sortName(a);
      const y = sortName(b);
      return x < y ? -1 : x > y ? 1 : 0;
    });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(path);
      else if (entry.isFile()) yield path;
    }
  }

  return {
    name: options.name,
    driver: "local",

    async put(key, body: Body) {
      const path = pathOf(key);
      await mkdir(tempDir, { recursive: true });
      await mkdir(dirname(path), { recursive: true });
      const temp = join(tempDir, randomUUID());
      let size = 0;
      const count = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      const source = body instanceof Uint8Array ? Readable.from([body]) : body;
      try {
        await pipeline(source, count, createWriteStream(temp, { flags: "wx", flush: true }));
        await fsync(temp);
        await rename(temp, path);
        await fsync(dirname(path));
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      return { size };
    },

    async get(key, range?: ByteRange) {
      const path = pathOf(key);
      let size: number;
      try {
        const info = await stat(path);
        if (!info.isFile()) throw new ObjectNotFoundError(key);
        size = info.size;
      } catch (error) {
        if (isMissing(error)) throw new ObjectNotFoundError(key);
        throw error;
      }
      if (!range) return createReadStream(path);
      assertValidRange(range);
      if (range.start >= size) {
        throw new RangeNotSatisfiableError(
          `Range starts at ${range.start}; "${key}" has ${size} bytes`,
        );
      }
      const end = Math.min(range.end ?? size - 1, size - 1);
      return createReadStream(path, { start: range.start, end });
    },

    async head(key): Promise<ObjectInfo | null> {
      const path = pathOf(key);
      try {
        const info = await stat(path);
        return info.isFile() ? { size: info.size } : null;
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      const path = pathOf(key);
      await rm(path, { force: true });
      await prune(dirname(path));
    },

    async *list(prefix): AsyncGenerator<ListedObject> {
      assertValidPrefix(prefix);
      // Walk only the deepest directory the prefix fully names.
      const cut = prefix.lastIndexOf("/");
      const start = cut === -1 ? root : join(root, prefix.slice(0, cut));
      for await (const path of walk(start)) {
        const key = relative(root, path).split(sep).join("/");
        if (!key.startsWith(prefix)) continue;
        const info = await stat(path).catch(() => null);
        if (info) yield { key, size: info.size };
      }
    },

    async createMultipart(key) {
      pathOf(key);
      const uploadId = randomUUID();
      await mkdir(uploadDir(uploadId), { recursive: true });
      // Remember which key the upload is for, so completion cannot be pointed elsewhere.
      await writeFile(join(uploadDir(uploadId), "key"), key);
      return uploadId;
    },

    async putPart(key, uploadId, partNumber, body) {
      assertPartNumber(partNumber);
      const dir = uploadDir(uploadId);
      const owner = await readFile(join(dir, "key"), "utf8").catch(() => null);
      if (owner !== key) throw new StorageError(`Unknown upload "${uploadId}" for "${key}"`);
      const tag = createHash("sha256").update(body).digest("hex").slice(0, 32);
      const temp = join(dir, `${partNumber}.${randomUUID()}.part`);
      await writeFile(temp, body, { flush: true });
      await writeFile(`${temp}.tag`, tag);
      // Rename the tag first, then the bytes: a reader that sees new bytes also sees the new tag.
      await rename(`${temp}.tag`, join(dir, `${partNumber}.tag`));
      await rename(temp, join(dir, String(partNumber)));
      return tag;
    },

    async completeMultipart(key, uploadId, parts) {
      const path = pathOf(key);
      const dir = uploadDir(uploadId);
      const owner = await readFile(join(dir, "key"), "utf8").catch(() => null);
      if (owner !== key) throw new StorageError(`Unknown upload "${uploadId}" for "${key}"`);
      if (parts.length === 0) throw new StorageError("A multipart upload needs at least one part");
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      for (const [i, part] of sorted.entries()) {
        assertPartNumber(part.partNumber);
        if (i > 0 && part.partNumber === sorted[i - 1]?.partNumber) {
          throw new StorageError(`Part ${part.partNumber} is listed twice`);
        }
        const tag = await readFile(join(dir, `${part.partNumber}.tag`), "utf8").catch(() => null);
        if (tag !== part.tag)
          throw new StorageError(`Part ${part.partNumber} is missing or has changed`);
        const size = (await stat(join(dir, String(part.partNumber)))).size;
        if (i < sorted.length - 1 && size < MIN_PART_SIZE) {
          throw new StorageError(`Part ${part.partNumber} is smaller than ${MIN_PART_SIZE} bytes`);
        }
      }
      await mkdir(tempDir, { recursive: true });
      await mkdir(dirname(path), { recursive: true });
      const temp = join(tempDir, randomUUID());
      try {
        const out = createWriteStream(temp, { flags: "wx", flush: true });
        async function* concatenated() {
          for (const part of sorted) yield* createReadStream(join(dir, String(part.partNumber)));
        }
        await pipeline(Readable.from(concatenated()), out);
        await fsync(temp);
        await rename(temp, path);
        await fsync(dirname(path));
      } catch (error) {
        await rm(temp, { force: true });
        throw error;
      }
      await rm(dir, { recursive: true, force: true });
      return { size: (await stat(path)).size };
    },

    async abortMultipart(_key, uploadId) {
      await rm(uploadDir(uploadId), { recursive: true, force: true });
    },

    async check() {
      const probe = join(tempDir, `probe-${randomUUID()}`);
      try {
        await mkdir(tempDir, { recursive: true });
        await pipeline(Readable.from([Buffer.from("hekate")]), createWriteStream(probe));
      } catch (error) {
        throw new StorageConfigError(
          `Storage backend "${options.name}" cannot write to ${root}: ${(error as Error).message}`,
        );
      } finally {
        await rm(probe, { force: true });
      }
    },
  };
}
