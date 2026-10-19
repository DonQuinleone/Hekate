import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admRenderTarget } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { hasObjects, renderAdm, renderedInfo } from "./adm-render.ts";
import { probe, run } from "./ffmpeg.ts";
import { planRenditions } from "./proxy.ts";

describe("an ADM master's objects (#74)", () => {
  it("are rendered only where there are some", () => {
    const adm = { bytes: 10, bed: 10, layout: "5.1.4", lfe: [3], dolby: false };
    expect(hasObjects({ metadata: { tags: {}, adm: { ...adm, objects: 2 } } })).toBe(true);
    expect(hasObjects({ metadata: { tags: {}, adm: { ...adm, objects: 0 } } })).toBe(false);
    expect(hasObjects({})).toBe(false);
  });

  it("are heard as the render's layout: a 7.1.4 render in two lossless parts", () => {
    const info = renderedInfo(
      { audio: { codec: "pcm_s24le", channels: 30, sampleRate: 48000 } },
      admRenderTarget(undefined),
    );
    expect(info.audio).toMatchObject({ channels: 12, channelLayout: "7.1.4", bitDepth: 24 });
    expect(
      planRenditions("audio", info)
        .filter((p) => p.name.startsWith("flac"))
        .map((p) => p.name),
    ).toEqual(["flac", "flac-2"]);
  });
});

// The renderer itself, where it is installed (the image has it; CI installs it too).
const renderer = process.env.ADM_RENDERER_PATH;

describe.runIf(renderer)("the EBU ADM Renderer (#74)", () => {
  const root = mkdtempSync(join(tmpdir(), "hekate-adm-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("renders an object at the side onto 7.1.4, where ffmpeg's side left is", async () => {
    const mono = join(root, "tone.wav");
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2:sample_rate=48000",
      "-c:a",
      "pcm_s24le",
      mono,
    ]);
    // One object, 90° to the left, as an ADM master describes it.
    const meta = join(root, "object.yaml");
    writeFileSync(
      meta,
      [
        "name: side",
        "items:",
        '  - type: "Objects"',
        "    channels: [1]",
        "    blocks:",
        "      - rtime: 0.0",
        "        duration: 2.0",
        "        position: {azimuth: 90.0, elevation: 0.0, distance: 1.0}",
        "        gain: 1.0",
        "",
      ].join("\n"),
    );
    const master = join(root, "master.wav");
    await run(
      "python3",
      ["-W", "ignore", "-m", "ear.cmdline.utils", "make_test_bwf", "-i", mono, "-m", meta, master],
      { env: { PYTHONPATH: renderer ?? "", PYTHONNOUSERSITE: "1" } },
    );
    const info = await probe(master);
    // Hekate's own reading of the master finds the object the renderer is asked to place.
    expect(info.metadata?.adm).toMatchObject({ bed: 0, objects: 1 });
    expect(hasObjects(info)).toBe(true);
    const { path, target } = await renderAdm(master, root, info, renderer ?? "");
    expect(target.layout).toBe("7.1.4");
    const rendered = await probe(path);
    expect(rendered.audio).toMatchObject({ channels: 12, channelLayout: "7.1.4" });
    const { stderr } = await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-i",
      path,
      "-af",
      "astats=measure_overall=none:measure_perchannel=Peak_level",
      "-f",
      "null",
      "-",
    ]);
    const peaks = [...stderr.matchAll(/Peak level dB: (\S+)/g)].map((m) =>
      m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]),
    );
    // FL FR FC LFE BL BR SL SR …: the object is heard from SL alone.
    expect(peaks).toHaveLength(12);
    expect(peaks[6]).toBeGreaterThan(-40);
    const others = peaks.filter((_peak, i) => i !== 6);
    expect(others.every((p) => p === Number.NEGATIVE_INFINITY)).toBe(true);
  }, 120_000);
});
