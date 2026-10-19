import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { FILMSTRIP_FRAMES, makeFilmstrip } from "./filmstrip.ts";
import { webpComplete, webpSize } from "./pages.ts";

const root = mkdtempSync(join(tmpdir(), "hekate-filmstrip-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const video = async (name: string, size: string, duration: number) => {
  const path = join(root, name);
  await run("ffmpeg", [
    ...["-hide_banner", "-nostdin", "-v", "error"],
    ...["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${duration}`],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", path],
  ]);
  return path;
};

describe("filmstrips (#16)", () => {
  it("lays the frames side by side at one height, whatever the picture's shape", async () => {
    for (const [name, size, width] of [
      ["wide.mp4", "1280x720", 160],
      ["tall.mp4", "360x640", 50],
    ] as const) {
      const picture = await makeFilmstrip(await video(name, size, 3), root, 3);
      expect(webpComplete(picture)).toBe(true);
      expect(webpSize(picture)).toEqual({ width: FILMSTRIP_FRAMES * width, height: 90 });
    }
  }, 60_000);

  it("fills every frame of a video shorter than the strip", async () => {
    const picture = await makeFilmstrip(await video("short.mp4", "640x360", 0.2), root, 0.2);
    expect(webpSize(picture)).toEqual({ width: FILMSTRIP_FRAMES * 160, height: 90 });
  }, 60_000);
});
