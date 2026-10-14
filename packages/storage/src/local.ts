import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ObjectNotFoundError, RangeNotSatisfiableError, StorageConfigError } from "./errors.ts";
import { assertValidKey, assertValidPrefix, assertValidRange } from "./keys.ts";
import type { Body, ByteRange, ListedObject, ObjectInfo, StorageBackend } from "./types.ts";

export interface LocalBackendOptions {
  name: string;
  /** Directory that holds the objects. Created if missing. */
  root: string;
}

/** Writes in progress live here, inside the root so the final rename is atomic. Keys cannot start with a dot. */
const TEMP_DIR = ".tmp";

const isMissing = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** Local disk. The default backend; suits a single host with a mounted volume. */
export function localBackend(options: LocalBackendOptions): StorageBackend {
  if (!options.root) throw new StorageConfigError(`Storage backend "${options.name}" needs a path`);
  const root = resolve(options.root);
  const tempDir = join(root, TEMP_DIR);

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
