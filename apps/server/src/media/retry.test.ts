import { describe, expect, it } from "vitest";
import { type RetryFile, retryPlan } from "./retry.ts";

const audio = { codec: "pcm_s24le", channels: 2, sampleRate: 48000 };
const file = (over: Partial<RetryFile>): RetryFile => ({
  kind: "audio",
  mediaInfo: { duration: 60, audio },
  streamStatus: "ready",
  analysisStatus: "ready",
  drawn: false,
  ...over,
});

describe("retryPlan", () => {
  it("measures again what was never measured, or measured as nothing playable", () => {
    expect(retryPlan(file({ mediaInfo: null, streamStatus: "failed" }))).toEqual({
      set: { streamStatus: "pending" },
      jobs: ["media-probe"],
    });
    expect(retryPlan(file({ mediaInfo: { duration: 1 }, streamStatus: "failed" }))?.jobs).toEqual([
      "media-probe",
    ]);
  });

  it("prepares playback or analysis again, whichever failed", () => {
    expect(retryPlan(file({ streamStatus: "failed", analysisStatus: "failed" }))).toEqual({
      set: { streamStatus: "pending", analysisStatus: "pending" },
      jobs: ["media-proxy", "media-analysis"],
    });
    expect(retryPlan(file({ analysisStatus: "failed" }))?.jobs).toEqual(["media-analysis"]);
  });

  it("draws a document's pages again, and leaves alone what did not fail", () => {
    const pdf = { kind: "document", mediaInfo: null, drawn: true };
    expect(retryPlan(file({ ...pdf, streamStatus: "failed" }))?.jobs).toEqual(["document-render"]);
    expect(retryPlan(file({ ...pdf, streamStatus: "ready" }))).toBeNull();
    expect(retryPlan(file({ streamStatus: "pending" }))).toBeNull();
    expect(retryPlan(file({ kind: "other", streamStatus: "failed" }))).toBeNull();
  });
});
