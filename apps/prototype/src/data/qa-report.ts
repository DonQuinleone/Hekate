/**
 * The QA report as a document (#515): the sample the report's page shows, in the shape the
 * server makes it (`QaDocument` in packages/shared/src/qa-document.ts), for the seeded dry mix
 * of Maple Leaf Rag V2, which clips, drops out and misses its loudness.
 */

export type ReportSeverity = "fail" | "warn" | "info" | "pass";

export interface ReportCrop {
  from: number;
  to: number;
  markFrom: number;
  markTo: number;
  envelope: [number, number][] | null;
}

export interface ReportFinding {
  check: string;
  name: string;
  severity: ReportSeverity;
  at: string;
  start: number | null;
  end: number | null;
  channel: string | null;
  heard: string;
  advice: string;
  crop: ReportCrop | null;
  illustrated: boolean;
}

export interface QaReportDoc {
  file: {
    id: string;
    name: string;
    track: string | null;
    version: number | null;
    variant: string | null;
  };
  workspace: string;
  project: string;
  preparedBy: { name: string; role: string | null };
  preparedAt: string;
  preparedOn: string;
  measuredOn: string | null;
  profile: string;
  status: string;
  verdict: { tone: "pass" | "warn" | "fail" | "pending"; words: string };
  summary: {
    gauge: {
      min: number;
      max: number;
      ticks: number[];
      value: number | null;
      target: number | null;
      tolerance: number | null;
      zones: { from: number; to: number; tone: "pass" | "warn" }[];
    } | null;
    integrated: number | null;
    range: number | null;
    truePeak: number | null;
    ceiling: number;
    shortTermMax: number | null;
    counts: Record<ReportSeverity, number>;
    format: [string, string][];
    metadata: [string, string][];
  };
  groups: { severity: Exclude<ReportSeverity, "pass">; label: string; findings: ReportFinding[] }[];
  passed: { name: string; summary: string }[];
  appendix: {
    curve: {
      duration: number;
      points: (number | null)[];
      min: number;
      max: number;
      ticks: number[];
      target: number | null;
      tolerance: number | null;
    } | null;
    format: [string, string][];
    rules: {
      source: "profile" | "signal" | "project";
      label: string;
      asked: string;
      result: ReportSeverity | null;
    }[];
    link: string;
  };
}

/** A rag's waveform over a window in 160 columns, loud where it clips, silent where it drops out. */
function envelope(from: number, to: number, markFrom: number, markTo: number): [number, number][] {
  return Array.from({ length: 160 }, (_, i) => {
    const t = from + ((i + 0.5) / 160) * (to - from);
    const inside = t >= markFrom && t <= markTo;
    const level =
      inside && markTo - markFrom > 0.1
        ? 1
        : inside
          ? 0
          : Math.round((0.12 + 0.4 * Math.exp(-4 * (t % 0.5))) * 100) / 100;
    return [-level, level];
  });
}

/** Short-term loudness over the forty seconds: steady, louder where it clips. */
const curve = Array.from({ length: 240 }, (_, i) => {
  const t = (i / 240) * 40;
  if (t < 1) return null;
  return t > 11.8 && t < 12.8 ? -9.4 : Math.round((-17.2 + 0.4 * Math.sin(i / 6)) * 10) / 10;
});

export const qaReportSample: QaReportDoc = {
  file: {
    id: "file-maple-v2-dry",
    name: "Maple Leaf Rag - Dry v2.wav",
    track: "Maple Leaf Rag",
    version: 2,
    variant: "Dry",
  },
  workspace: "Endless Hall Records",
  project: "Joplin Rags",
  preparedBy: {
    name: "Tomas Varga",
    role: "Engineer",
  },
  preparedAt: "2026-10-31T14:02:00.000Z",
  preparedOn: "2026-10-31 14:02 UTC",
  measuredOn: "2026-10-14",
  profile: "Streaming",
  status: "ready",
  verdict: {
    tone: "fail",
    words: "Not ready for Streaming: loudness, true peak and 2 more fail.",
  },
  summary: {
    gauge: {
      min: -22,
      max: -6,
      ticks: [-22, -20, -18, -16, -14, -12, -10, -8, -6],
      value: -16,
      target: -14,
      tolerance: 1,
      zones: [
        {
          from: -16,
          to: -15,
          tone: "warn",
        },
        {
          from: -15,
          to: -13,
          tone: "pass",
        },
        {
          from: -13,
          to: -12,
          tone: "warn",
        },
      ],
    },
    integrated: -16,
    range: 8.2,
    truePeak: 0.9,
    ceiling: -1,
    shortTermMax: -9.4,
    counts: {
      fail: 5,
      warn: 0,
      info: 0,
      pass: 6,
    },
    format: [
      ["Codec", "pcm_s16le"],
      ["Sample rate", "44.1 kHz"],
      ["Bit depth", "16-bit"],
      ["Channels", "2 (stereo)"],
      ["Duration", "00:40.000"],
    ],
    metadata: [
      ["Description", "Maple Leaf Rag, V2 dry"],
      ["Originator", "Endless Hall Records"],
      ["Origination", "2026-10-14 09:58"],
      ["Time reference", "10:00:00"],
      ["Title", "Maple Leaf Rag"],
      ["Artist", "Endless Hall Records"],
      ["ISRC", "none"],
      ["Artwork", "none"],
    ],
  },
  groups: [
    {
      severity: "fail",
      label: "Fails",
      findings: [
        {
          check: "loudness",
          name: "Loudness",
          severity: "fail",
          at: "Whole file",
          start: null,
          end: null,
          channel: null,
          heard: "−16.0 LUFS, 2.0 LU below the −14 LUFS target",
          advice: "Raise the master by 2.0 LU, to −14 LUFS, keeping the true peak under −1.0 dBTP.",
          crop: null,
          illustrated: true,
        },
        {
          check: "true-peak",
          name: "True peak",
          severity: "fail",
          at: "Whole file",
          start: null,
          end: null,
          channel: null,
          heard: "True peak 0.9 dBTP, over the −1.0 dBTP ceiling",
          advice:
            "Set the limiter's ceiling to −1.0 dBTP or below, with true-peak (oversampled) detection on, and export again.",
          crop: null,
          illustrated: true,
        },
        {
          check: "clipping",
          name: "Clipping",
          severity: "fail",
          at: "00:12.005–00:12.514",
          start: 12.005,
          end: 12.514,
          channel: "Channel 1",
          heard: "Clipped 118 times, the longest 93 samples on channel 1",
          advice:
            "Go back before the clip: lower the gain into whatever clips (the converter, a plug-in, the bounce), or repair it with a declipper if the source is gone.",
          crop: {
            from: 11.255,
            to: 13.264,
            markFrom: 12.005,
            markTo: 12.514,
            envelope: envelope(11.255, 13.264, 12.005, 12.514),
          },
          illustrated: true,
        },
        {
          check: "clipping",
          name: "Clipping",
          severity: "fail",
          at: "00:12.005–00:12.516",
          start: 12.005,
          end: 12.516,
          channel: "Channel 2",
          heard: "Clipped 94 times, the longest 70 samples on channel 2",
          advice:
            "Go back before the clip: lower the gain into whatever clips (the converter, a plug-in, the bounce), or repair it with a declipper if the source is gone.",
          crop: {
            from: 11.255,
            to: 13.266,
            markFrom: 12.005,
            markTo: 12.516,
            envelope: envelope(11.255, 13.266, 12.005, 12.516),
          },
          illustrated: true,
        },
        {
          check: "dropouts",
          name: "Dropouts",
          severity: "fail",
          at: "00:31.022–00:31.045",
          start: 31.022,
          end: 31.045,
          channel: null,
          heard: "Digital silence for 23 ms inside the music",
          advice:
            "Listen here. If the gap is not in the music, patch it from another take or the session's backup.",
          crop: {
            from: 30.272,
            to: 31.795,
            markFrom: 31.022,
            markTo: 31.045,
            envelope: envelope(30.272, 31.795, 31.022, 31.045),
          },
          illustrated: true,
        },
      ],
    },
  ],
  passed: [
    {
      name: "Format",
      summary: "Passes",
    },
    {
      name: "DC offset",
      summary: "Passes",
    },
    {
      name: "Silence",
      summary: "Passes",
    },
    {
      name: "Phase",
      summary: "Passes",
    },
    {
      name: "Bandwidth",
      summary: "Passes",
    },
    {
      name: "Flattened peaks",
      summary: "Passes",
    },
  ],
  appendix: {
    curve: {
      duration: 40,
      points: curve,
      min: -40,
      max: 0,
      ticks: [-40, -35, -30, -25, -20, -15, -10, -5, 0],
      target: -14,
      tolerance: 1,
    },
    format: [
      ["Container", "wav"],
      ["Codec", "pcm_s16le"],
      ["Sample rate", "44.1 kHz"],
      ["Bit depth", "16-bit"],
      ["Channels", "2 (stereo)"],
      ["Duration", "00:40.000"],
      ["Bit rate", "1411 kb/s"],
      ["Description", "Maple Leaf Rag, V2 dry"],
      ["Originator", "Endless Hall Records"],
      ["Origination", "2026-10-14 09:58"],
      ["Time reference", "10:00:00"],
      ["Title", "Maple Leaf Rag"],
      ["Artist", "Endless Hall Records"],
      ["ISRC", "none"],
      ["Artwork", "none"],
    ],
    rules: [
      {
        source: "profile",
        label: "Integrated loudness",
        asked: "−14 LUFS ± 1 LU",
        result: "fail",
      },
      {
        source: "profile",
        label: "True peak",
        asked: "at most −1.0 dBTP",
        result: "fail",
      },
      {
        source: "profile",
        label: "Sample rate",
        asked: "44.1 kHz or higher",
        result: "pass",
      },
      {
        source: "profile",
        label: "Bit depth",
        asked: "16-bit or more",
        result: "pass",
      },
      {
        source: "profile",
        label: "Channels",
        asked: "2",
        result: "pass",
      },
      {
        source: "signal",
        label: "Integrity",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "Clipping",
        asked: "none in the file",
        result: "fail",
      },
      {
        source: "signal",
        label: "Flattened peaks",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "Dropouts",
        asked: "none in the file",
        result: "fail",
      },
      {
        source: "signal",
        label: "Clicks",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "DC offset",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "Silence",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "Phase",
        asked: "none in the file",
        result: "pass",
      },
      {
        source: "signal",
        label: "Bandwidth",
        asked: "none in the file",
        result: "pass",
      },
    ],
    link: "https://review.endlesshall.example/files/file-maple-v2-dry?view=qa",
  },
};
