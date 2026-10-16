import type { MediaInfo } from "@hekate/shared";

type Status = "none" | "pending" | "ready" | "failed";

export interface RetryFile {
  kind: string;
  mediaInfo: MediaInfo | null;
  streamStatus: Status;
  analysisStatus: Status;
  /** Whether the server draws its pages (a PDF, a picture). */
  drawn: boolean;
}

export type RetryJob = "media-probe" | "media-proxy" | "media-analysis" | "document-render";

/**
 * What to run again for a file whose preparation failed, and the statuses it waits in
 * meanwhile. A recording not yet measured (or measured as nothing playable) is measured
 * again, which goes on to prepare it; one measured but not made playable is made playable;
 * a failed analysis runs again. A document's pages are drawn again. Null when nothing failed.
 */
export function retryPlan(
  file: RetryFile,
): { set: { streamStatus?: "pending"; analysisStatus?: "pending" }; jobs: RetryJob[] } | null {
  if (file.kind === "audio" || file.kind === "video") {
    const playable = Boolean(file.mediaInfo?.audio || file.mediaInfo?.video);
    if (file.streamStatus === "failed" && !playable) {
      return { set: { streamStatus: "pending" }, jobs: ["media-probe"] };
    }
    const jobs: RetryJob[] = [];
    const set: { streamStatus?: "pending"; analysisStatus?: "pending" } = {};
    if (file.streamStatus === "failed") {
      set.streamStatus = "pending";
      jobs.push("media-proxy");
    }
    if (file.analysisStatus === "failed") {
      set.analysisStatus = "pending";
      jobs.push("media-analysis");
    }
    return jobs.length ? { set, jobs } : null;
  }
  if (file.drawn && file.streamStatus === "failed") {
    return { set: { streamStatus: "pending" }, jobs: ["document-render"] };
  }
  return null;
}
