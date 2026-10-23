import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { entryHeader, readTar, type TarEntry, tarStream } from "./tar.ts";
import { segment, unique } from "./workspace-export.ts";

const modified = new Date("2026-10-20T10:00:00Z");
const long = `files/Joplin Rags/${"Ragtime sketches ".repeat(8)}/Maple Leaf Rag (prise 3, Mira Solberg) é.wav`;

async function* entries(list: [string, Buffer][]): AsyncGenerator<TarEntry> {
  for (const [path, body] of list) yield { path, size: body.length, modified, body };
}

const archive = (list: [string, Buffer][]) => buffer(Readable.from(tarStream(entries(list))));

/** GNU tar or bsdtar, where one is installed, to show the archive opens with the real thing. */
const tar = spawnSync("tar", ["--version"]).status === 0;

describe("tar", () => {
  it("writes ustar where it can, and pax where a name or size needs it", () => {
    expect(entryHeader("README.txt", 5, modified)).toHaveLength(512);
    const paxed = entryHeader(long, 5, modified);
    expect(paxed.length).toBeGreaterThan(1024);
    expect(paxed.subarray(0, 512).toString("latin1")).toContain("PaxHeader");
    // Eight GiB and more: the size goes in the pax header.
    expect(entryHeader("big.bin", 8 * 1024 ** 3, modified).toString("latin1")).toContain(
      `size=${8 * 1024 ** 3}`,
    );
  });

  it("reads back what it wrote, every entry padded to its block", async () => {
    const list: [string, Buffer][] = [
      ["export/README.txt", Buffer.from("hello")],
      ["export/empty.json", Buffer.alloc(0)],
      [long, Buffer.alloc(1300, 9)],
      ["export/block.bin", Buffer.alloc(512, 1)],
    ];
    const written = await archive(list);
    expect(written.length % 512).toBe(0);
    expect(readTar(written)).toEqual(new Map(list));
  });

  it("refuses an entry whose body is not the size it said", async () => {
    const short: TarEntry = { path: "a", size: 4, modified, body: Buffer.from("abc") };
    await expect(
      buffer(
        Readable.from(
          tarStream(
            (async function* () {
              yield short;
            })(),
          ),
        ),
      ),
    ).rejects.toThrow(/shorter/);
  });

  it.skipIf(!tar)("is opened by tar, long names in any script included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hekate-tar-"));
    try {
      const list: [string, Buffer][] = [
        ["export/README.txt", Buffer.from("hello")],
        [long, Buffer.alloc(1300, 9)],
      ];
      const path = join(dir, "a.tar");
      writeFileSync(path, await archive(list));
      const listed = execFileSync("tar", ["-tf", path]).toString("utf8").trim().split("\n");
      expect(listed).toHaveLength(list.length);
      execFileSync("tar", ["-xf", path, "-C", dir]);
      expect(readFileSync(join(dir, long))).toEqual(list[1]?.[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("export paths", () => {
  it("makes any name a safe segment", () => {
    expect(segment("Cut 3.wav")).toBe("Cut 3.wav");
    expect(segment("a/b\\c")).toBe("a_b_c");
    expect(segment("..")).toBe("_");
    expect(segment("  ")).toBe("_");
    expect(segment("bell\u0007")).toBe("bell_");
  });

  it("numbers a path that is taken, before its extension, ignoring case", () => {
    const taken = new Set<string>();
    expect(unique("files/A/Cut.wav", taken)).toBe("files/A/Cut.wav");
    expect(unique("files/A/cut.wav", taken)).toBe("files/A/cut (2).wav");
    expect(unique("files/A/Cut.wav", taken)).toBe("files/A/Cut (3).wav");
    expect(unique("files/A.b/Notes", taken)).toBe("files/A.b/Notes");
    expect(unique("files/A.b/Notes", taken)).toBe("files/A.b/Notes (2)");
  });
});
