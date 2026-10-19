import { join } from "node:path";
import { type AdmRenderTarget, admRenderTarget, type MediaInfo, renderOrder } from "@hekate/shared";
import { run, safeInputArgs } from "./ffmpeg.ts";

/**
 * An ADM master's objects, rendered for listening (#74, decision 140). The EBU ADM Renderer
 * (`ear`, Python, installed in the image at ADM_RENDERER_PATH) renders the master's bed and
 * objects onto the BS.2051 system nearest its bed; ffmpeg then puts the channels in the order
 * the rest of Hekate knows that layout by. The render is what the master's streams carry.
 */

/** Whether a file is an ADM master with objects to render. */
export const hasObjects = (info: MediaInfo) => (info.metadata?.adm?.objects ?? 0) > 0;

/** What a render is heard as, to plan its streams from: the layout's channels, 24-bit. */
export function renderedInfo(info: MediaInfo, target: AdmRenderTarget): MediaInfo {
  const channels = target.speakers.length;
  return {
    ...info,
    audio: {
      codec: "pcm_s24le",
      sampleRate: info.audio?.sampleRate ?? 48000,
      channels,
      channelLayout: target.layout === "2.0" ? "stereo" : target.layout,
      bitDepth: 24,
    },
  };
}

/**
 * Renders the master at `input` into the workspace `dir` and returns the render's path and
 * target. The renderer reads nothing but the file; it runs without a shell, like ffmpeg.
 */
export async function renderAdm(
  input: string,
  dir: string,
  info: MediaInfo,
  rendererPath: string,
  signal?: AbortSignal,
): Promise<{ path: string; target: AdmRenderTarget }> {
  const target = admRenderTarget(info.metadata?.adm?.layout);
  const raw = join(dir, "adm-render.wav");
  const path = join(dir, "adm-rendered.wav");
  await run(
    "python3",
    ["-W", "ignore", "-m", "ear.cmdline.render_file", "-s", target.system, input, raw],
    // Its packages from the directory they were installed to, and nothing from the user's own.
    {
      signal,
      env: { PYTHONPATH: rendererPath, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
      timeoutMs: 60 * 60_000,
    },
  );
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-i",
      `file:${raw}`,
      "-af",
      renderOrder(target),
      "-c:a",
      "pcm_s24le",
      "-y",
      `file:${path}`,
    ],
    { signal },
  );
  return { path, target };
}
