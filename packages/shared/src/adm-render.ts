import type { LayoutName } from "./layouts.ts";

/**
 * Rendering an ADM master's objects (#74, decision 140). The EBU ADM Renderer (`ear`) renders
 * the whole master, bed and objects, onto a loudspeaker system of ITU-R BS.2051. Hekate picks
 * the system nearest the master's bed and puts the render's channels in the order ffmpeg and
 * the rest of Hekate know the layout by, so the render plays and is heard apart like any
 * recording of that layout.
 */

export interface AdmRenderTarget {
  /** The BS.2051 system the renderer is asked for: "4+7+0". */
  system: string;
  /** The layout the render is heard as: "7.1.4". */
  layout: LayoutName;
  /** The render's speakers in the renderer's order, by their BS.2051 names. */
  speakers: readonly string[];
}

const targets: Record<string, AdmRenderTarget> = {
  "2.0": { system: "0+2+0", layout: "2.0", speakers: ["M+030", "M-030"] },
  "5.1": {
    system: "0+5+0",
    layout: "5.1",
    speakers: ["M+030", "M-030", "M+000", "LFE1", "M+110", "M-110"],
  },
  "5.1.2": {
    system: "2+5+0",
    layout: "5.1.2",
    speakers: ["M+030", "M-030", "M+000", "LFE1", "M+110", "M-110", "U+030", "U-030"],
  },
  "5.1.4": {
    system: "4+5+0",
    layout: "5.1.4",
    speakers: [
      "M+030",
      "M-030",
      "M+000",
      "LFE1",
      "M+110",
      "M-110",
      "U+030",
      "U-030",
      "U+110",
      "U-110",
    ],
  },
  "7.1": {
    system: "0+7+0",
    layout: "7.1",
    speakers: ["M+030", "M-030", "M+000", "LFE1", "M+090", "M-090", "M+135", "M-135"],
  },
  "7.1.4": {
    system: "4+7+0",
    layout: "7.1.4",
    speakers: [
      "M+030",
      "M-030",
      "M+000",
      "LFE1",
      "M+090",
      "M-090",
      "M+135",
      "M-135",
      "U+045",
      "U-045",
      "U+135",
      "U-135",
    ],
  },
};

/**
 * Where a master is rendered: onto its bed's own layout where BS.2051 has it, else onto 7.1.4,
 * which holds every bed this side of 9.1.6 (a 7.1.2 bed's heights go to its front pair).
 * Objects alone, with no bed, are rendered onto 7.1.4 too.
 */
export const admRenderTarget = (bed: string | undefined): AdmRenderTarget =>
  targets[bed ?? ""] ?? (targets["7.1.4"] as AdmRenderTarget);

/** Each BS.2051 speaker as ffmpeg names its channel. */
const ffmpegNames: Record<string, string> = {
  "M+030": "FL",
  "M-030": "FR",
  "M+000": "FC",
  LFE1: "LFE",
  "M+110": "BL",
  "M-110": "BR",
  "M+090": "SL",
  "M-090": "SR",
  "M+135": "BL",
  "M-135": "BR",
  "U+030": "TFL",
  "U-030": "TFR",
  "U+045": "TFL",
  "U-045": "TFR",
  "U+110": "TBL",
  "U-110": "TBR",
  "U+135": "TBL",
  "U-135": "TBR",
};

/** ffmpeg's name for a layout it knows by another: stereo is "stereo", the rest as written. */
const ffmpegLayoutName = (layout: LayoutName) => (layout === "2.0" ? "stereo" : layout);

/**
 * The ffmpeg filter that puts a render's channels into the order of its layout as ffmpeg
 * knows it, and tags it so: "pan=7.1.4|FL=c0|FR=c1|…|BL=c6|BR=c7|SL=c4|SR=c5|…".
 */
export function renderOrder(target: AdmRenderTarget): string {
  const routes = target.speakers.map((speaker, i) => `${ffmpegNames[speaker]}=c${i}`);
  return `pan=${ffmpegLayoutName(target.layout)}|${routes.join("|")}`;
}
