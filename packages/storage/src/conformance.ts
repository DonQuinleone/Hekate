import { randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterAll, describe, expect, it } from "vitest";
import {
  InvalidKeyError,
  ObjectNotFoundError,
  RangeNotSatisfiableError,
  StorageError,
} from "./errors.ts";
import { MIN_PART_SIZE, type StorageBackend } from "./types.ts";

/**
 * The behaviour every storage backend must share. Each driver's test file runs
 * this suite against a real instance of that backend.
 */
export function storageConformance(label: string, make: () => StorageBackend) {
  describe(`storage conformance: ${label}`, () => {
    const backend = make();
    // Each run works under its own prefix, so a shared bucket is safe.
    const run = `test/${randomUUID()}`;
    const key = (name: string) => `${run}/${name}`;
    const read = async (stream: Readable) => buffer(stream);

    afterAll(async () => {
      for await (const object of backend.list(`${run}/`)) await backend.delete(object.key);
    });

    it("passes its own start-up check", async () => {
      await expect(backend.check()).resolves.toBeUndefined();
    });

    it("stores bytes and reads them back", async () => {
      const data = randomBytes(4096);
      await expect(backend.put(key("bytes"), data)).resolves.toEqual({ size: 4096 });
      expect((await read(await backend.get(key("bytes")))).equals(data)).toBe(true);
      expect(await backend.head(key("bytes"))).toEqual({ size: 4096 });
    });

    it("stores a stream larger than one buffer", async () => {
      const chunks = Array.from({ length: 64 }, () => randomBytes(64 * 1024));
      const info = await backend.put(key("stream"), Readable.from(chunks), {
        contentType: "audio/flac",
      });
      expect(info.size).toBe(64 * 64 * 1024);
      // Compare with equals(): a deep comparison of 4 MiB is very slow.
      expect((await read(await backend.get(key("stream")))).equals(Buffer.concat(chunks))).toBe(
        true,
      );
    });

    it("stores an empty object", async () => {
      await expect(backend.put(key("empty"), new Uint8Array())).resolves.toEqual({ size: 0 });
      expect(await backend.head(key("empty"))).toEqual({ size: 0 });
      expect((await read(await backend.get(key("empty")))).length).toBe(0);
    });

    it("replaces an object written to the same key", async () => {
      await backend.put(key("replace"), Buffer.from("first version"));
      await backend.put(key("replace"), Buffer.from("second"));
      expect((await read(await backend.get(key("replace")))).toString()).toBe("second");
    });

    it("reads byte ranges with an inclusive end", async () => {
      await backend.put(key("range"), Buffer.from("0123456789"));
      const range = async (start: number, end?: number) =>
        (
          await read(
            await backend.get(key("range"), end === undefined ? { start } : { start, end }),
          )
        ).toString();
      expect(await range(0, 0)).toBe("0");
      expect(await range(2, 5)).toBe("2345");
      expect(await range(7)).toBe("789");
      expect(await range(8, 100)).toBe("89");
    });

    it("refuses ranges it cannot satisfy", async () => {
      await backend.put(key("short"), Buffer.from("abc"));
      await expect(backend.get(key("short"), { start: 3 })).rejects.toBeInstanceOf(
        RangeNotSatisfiableError,
      );
      await expect(backend.get(key("short"), { start: 2, end: 1 })).rejects.toBeInstanceOf(
        RangeNotSatisfiableError,
      );
      await expect(backend.get(key("short"), { start: -1 })).rejects.toBeInstanceOf(
        RangeNotSatisfiableError,
      );
    });

    it("reports missing objects", async () => {
      expect(await backend.head(key("missing"))).toBeNull();
      await expect(backend.get(key("missing"))).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(backend.get(key("missing"), { start: 0 })).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
    });

    it("deletes objects, and deleting twice succeeds", async () => {
      await backend.put(key("gone"), Buffer.from("x"));
      await backend.delete(key("gone"));
      expect(await backend.head(key("gone"))).toBeNull();
      await expect(backend.delete(key("gone"))).resolves.toBeUndefined();
    });

    it("lists by prefix in key order", async () => {
      const names = ["list/b", "list/a.txt", "list/a/1", "list/a/2", "listing", "other/x"];
      for (const name of names) await backend.put(key(name), Buffer.from(name));
      const listed: { key: string; size: number }[] = [];
      for await (const object of backend.list(key("list/"))) listed.push(object);
      expect(listed).toEqual([
        { key: key("list/a.txt"), size: "list/a.txt".length },
        { key: key("list/a/1"), size: "list/a/1".length },
        { key: key("list/a/2"), size: "list/a/2".length },
        { key: key("list/b"), size: "list/b".length },
      ]);
      const partial: string[] = [];
      for await (const object of backend.list(key("list"))) partial.push(object.key);
      expect(partial).toEqual(["list/a.txt", "list/a/1", "list/a/2", "list/b", "listing"].map(key));
    });

    it("rejects keys that could escape the backend", async () => {
      for (const bad of [
        "../x",
        "a/../../x",
        "/abs",
        "a//b",
        "a/./b",
        ".hidden",
        "a\\b",
        "",
        "a/",
      ]) {
        await expect(backend.put(bad, Buffer.from("x")), bad).rejects.toBeInstanceOf(
          InvalidKeyError,
        );
        await expect(backend.get(bad), bad).rejects.toBeInstanceOf(InvalidKeyError);
      }
    });

    describe("multipart", () => {
      const big = () => randomBytes(MIN_PART_SIZE);

      it("joins parts sent out of order and re-sent", async () => {
        const one = big();
        const two = big();
        const three = Buffer.from("the last part may be small");
        const id = await backend.createMultipart(key("multi"), { contentType: "audio/wav" });
        const t3 = await backend.putPart(key("multi"), id, 3, three);
        await backend.putPart(key("multi"), id, 1, randomBytes(MIN_PART_SIZE)); // replaced below
        const t1 = await backend.putPart(key("multi"), id, 1, one);
        const t2 = await backend.putPart(key("multi"), id, 2, two);
        expect(await backend.head(key("multi"))).toBeNull();
        const info = await backend.completeMultipart(key("multi"), id, [
          { partNumber: 2, tag: t2 },
          { partNumber: 3, tag: t3 },
          { partNumber: 1, tag: t1 },
        ]);
        const expected = Buffer.concat([one, two, three]);
        expect(info.size).toBe(expected.length);
        expect((await read(await backend.get(key("multi")))).equals(expected)).toBe(true);
        const tail = await read(await backend.get(key("multi"), { start: expected.length - 5 }));
        expect(tail.toString()).toBe("small");
      }, 60_000);

      it("refuses a small part before the last, and a stale tag", async () => {
        const id = await backend.createMultipart(key("small"));
        const t1 = await backend.putPart(key("small"), id, 1, Buffer.from("too small"));
        const t2 = await backend.putPart(key("small"), id, 2, Buffer.from("last"));
        await expect(
          backend.completeMultipart(key("small"), id, [
            { partNumber: 1, tag: t1 },
            { partNumber: 2, tag: t2 },
          ]),
        ).rejects.toThrow();
        await backend.abortMultipart(key("small"), id);

        const again = await backend.createMultipart(key("stale"));
        const stale = await backend.putPart(key("stale"), again, 1, Buffer.from("first"));
        await backend.putPart(key("stale"), again, 1, Buffer.from("second"));
        await expect(
          backend.completeMultipart(key("stale"), again, [{ partNumber: 1, tag: stale }]),
        ).rejects.toThrow();
        await backend.abortMultipart(key("stale"), again);
      });

      it("discards an aborted upload, and aborting twice succeeds", async () => {
        const id = await backend.createMultipart(key("aborted"));
        await backend.putPart(key("aborted"), id, 1, Buffer.from("x"));
        await backend.abortMultipart(key("aborted"), id);
        await expect(backend.abortMultipart(key("aborted"), id)).resolves.toBeUndefined();
        expect(await backend.head(key("aborted"))).toBeNull();
        await expect(backend.putPart(key("aborted"), id, 1, Buffer.from("x"))).rejects.toThrow();
      });

      it("refuses part numbers out of range", async () => {
        const id = await backend.createMultipart(key("range-parts"));
        await expect(
          backend.putPart(key("range-parts"), id, 0, Buffer.from("x")),
        ).rejects.toBeInstanceOf(StorageError);
        await expect(
          backend.putPart(key("range-parts"), id, 10_001, Buffer.from("x")),
        ).rejects.toBeInstanceOf(StorageError);
        await backend.abortMultipart(key("range-parts"), id);
      });
    });

    it("fails a write when the source stream fails, leaving nothing behind", async () => {
      const failing = new Readable({
        read() {
          this.push(randomBytes(1024));
          this.destroy(new Error("source failed"));
        },
      });
      await expect(backend.put(key("failed"), failing)).rejects.toThrow();
      expect(await backend.head(key("failed"))).toBeNull();
    });
  });
}
