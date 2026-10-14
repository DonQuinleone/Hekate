import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { watermark, watermarkText } from "./watermark.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("watermarks", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-watermark-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** How much ink a WebP holds: the sum of how far each grey pixel is from white. */
  const ink = async (webp: Buffer) => {
    const path = join(dir, `ink-${Math.random()}.webp`);
    writeFileSync(path, webp);
    const chunks: Buffer[] = [];
    await run(
      "ffmpeg",
      [
        ...["-hide_banner", "-nostdin", "-v", "error", "-i", path],
        ...["-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"],
      ],
      { onStdout: (chunk) => chunks.push(chunk) },
    );
    return Buffer.concat(chunks).reduce((sum, v) => sum + (255 - v), 0);
  };

  it("says who, where and when, a line each, whatever was typed into a name", () => {
    expect(
      watermarkText(
        { name: "Ines\n  Arlow", email: "ines@example.test" },
        "Endless Hall Records",
        new Date("2026-10-14T23:30:00Z"),
      ),
    ).toBe("Ines Arlow · ines@example.test\nEndless Hall Records · 14 October 2026");
  });

  it.runIf(hasFfmpeg || process.env.CI)(
    "draws the mark over a page, and reads awkward names as plain text",
    async () => {
      const page = join(dir, "white.webp");
      await run("ffmpeg", [
        ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
        ...["-i", "color=white:s=600x840", "-frames:v", "1", "-c:v", "libwebp", page],
      ]);
      const white = readFileSync(page);
      const text = watermarkText(
        { name: "O'Brien: %{pts} \\ test", email: "guest@example.test" },
        "Endless Hall Records",
        new Date(),
      );
      for (const size of ["view", "thumb"] as const) {
        const marked = await watermark(white, text, size);
        expect(marked.subarray(8, 12).toString()).toBe("WEBP");
        expect(await ink(marked)).toBeGreaterThan((await ink(white)) + 10_000);
      }
    },
  );
});
