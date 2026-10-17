import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watermarkText } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { IMAGE_DEMUXERS, pngSize, webpComplete } from "./pages.ts";
import { jpegSize } from "./pdf.ts";
import { markedFormatOf, markPicture, watermark } from "./watermark.ts";

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

  it("writes a marked original back in its own format where it can, else as PNG", () => {
    expect(markedFormatOf("Cover.JPG", "")).toBe("jpeg");
    expect(markedFormatOf("cover", "image/jpeg")).toBe("jpeg");
    expect(markedFormatOf("Cover.webp", "image/webp")).toBe("webp");
    expect(markedFormatOf("Scan.tif", "image/tiff")).toBe("tiff");
    expect(markedFormatOf("Cover.png", "image/png")).toBe("png");
    expect(markedFormatOf("Cover.gif", "image/gif")).toBe("png");
    expect(markedFormatOf("Cover.bmp", "image/bmp")).toBe("png");
  });

  it.runIf(hasFfmpeg || process.env.CI)(
    "marks a picture at full size, written as asked",
    async () => {
      const input = join(dir, "original.png");
      await run("ffmpeg", [
        ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
        ...["-i", "color=white:s=1200x900", "-frames:v", "1", input],
      ]);
      const text = "Tomas Varga · tomas@example.test\nEndless Hall Records · 17 October 2026";
      const out = (ext: string) => join(dir, `marked.${ext}`);
      await markPicture(input, out("jpg"), { text, demuxers: IMAGE_DEMUXERS, format: "jpeg" });
      expect(jpegSize(readFileSync(out("jpg")))).toEqual({ width: 1200, height: 900 });
      await markPicture(input, out("png"), { text, demuxers: IMAGE_DEMUXERS, format: "png" });
      expect(pngSize(readFileSync(out("png")))).toEqual({ width: 1200, height: 900 });
      expect(await ink(readFileSync(out("png")))).toBeGreaterThan(10_000);
      await markPicture(input, out("tif"), { text, demuxers: IMAGE_DEMUXERS, format: "tiff" });
      expect(readFileSync(out("tif")).subarray(0, 2).toString()).toMatch(/II|MM/);
      // Only a picture is read: a PDF is not one.
      writeFileSync(join(dir, "not.png"), "%PDF-1.4");
      await expect(
        markPicture(join(dir, "not.png"), out("x.png"), {
          text,
          demuxers: IMAGE_DEMUXERS,
          format: "png",
        }),
      ).rejects.toThrow();
    },
  );

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
        expect(webpComplete(marked)).toBe(true);
        expect(await ink(marked)).toBeGreaterThan((await ink(white)) + 10_000);
      }
      // Wherever the project puts it, and stronger when it asks (#31).
      const faint = await ink(
        await watermark(white, text, "view", undefined, { position: "corner", opacity: 20 }),
      );
      const plain = await ink(
        await watermark(white, text, "view", undefined, { position: "corner", opacity: 80 }),
      );
      expect(faint).toBeGreaterThan(await ink(white));
      expect(plain).toBeGreaterThan(faint);
      const centred = await watermark(white, text, "view", undefined, {
        position: "centre",
        opacity: 40,
      });
      expect(webpComplete(centred)).toBe(true);
      expect(await ink(centred)).toBeGreaterThan(await ink(white));
    },
  );
});
