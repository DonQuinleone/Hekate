import type { QaFinding } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { qaReport, qaReportCsv, qaReportFilename, qaReportJson, stampOf } from "./qa-report.ts";
import { latin1, textPdf, wrap } from "./text-pdf.ts";

const finding = (f: Partial<QaFinding>): QaFinding =>
  ({
    check: "clipping",
    severity: "fail",
    summary: "Clipped 118 times",
    channel: 0,
    start: 12.0051,
    end: 12.5,
    details: {},
    ...f,
  }) as QaFinding;

const input = {
  file: { name: "Maple Leaf Rag - Dry v2.wav", version: "V2 · Dry" },
  workspace: "Endless Hall Records",
  project: "Joplin Rags",
  requestedBy: { name: "Tomas Varga", role: "Engineer" },
  generatedAt: new Date("2026-10-17T21:30:00Z"),
  profile: { label: "Streaming" },
  status: "ready",
  loudness: {
    integrated: -16,
    range: 6.2,
    momentaryMax: -10,
    shortTermMax: -12,
    truePeak: -0.8,
    channels: [],
  },
  format: {
    duration: 40,
    audio: {
      codec: "pcm_s16le",
      channels: 2,
      channelLayout: "stereo",
      sampleRate: 44100,
      bitDepth: 16,
    },
  },
  findings: [
    finding({}),
    finding({
      severity: "warn",
      check: "phase",
      summary: 'Phase "wide", left, right',
      start: null,
      end: null,
      channel: null,
    }),
    finding({
      severity: "pass",
      check: "dc-offset",
      summary: "No DC offset",
      start: null,
      end: null,
    }),
  ],
};

describe("a QA report to take away (#43)", () => {
  it("stamps it with the workspace, the project and who asked", () => {
    expect(stampOf(input)).toBe("Endless Hall Records · Joplin Rags · Tomas Varga, Engineer");
  });

  it("writes one row a finding for a spreadsheet, quoting what needs it", () => {
    const stamp =
      ",Maple Leaf Rag - Dry v2.wav,V2 · Dry,Streaming,Endless Hall Records,Joplin Rags,Tomas Varga,Engineer,2026-10-17T21:30:00.000Z";
    expect(qaReportCsv(input).split("\r\n")).toEqual([
      "severity,check,start_seconds,end_seconds,channel,summary,file,version,profile,workspace,project,requested_by,role,generated_at",
      // Every row carries the stamp, so a row copied elsewhere still says what it is about.
      `fail,clipping,12.005,12.5,0,Clipped 118 times${stamp}`,
      `warn,phase,,,,"Phase ""wide"", left, right"${stamp}`,
      `pass,dc-offset,,,0,No DC offset${stamp}`,
      "",
    ]);
  });

  it("gives another program everything", () => {
    const parsed = JSON.parse(qaReportJson(input));
    expect(parsed).toMatchObject({
      project: "Joplin Rags",
      generatedAt: "2026-10-17T21:30:00.000Z",
      loudness: { integrated: -16 },
    });
    expect(parsed.findings).toHaveLength(3);
  });

  it("names each format", () => {
    expect(qaReport(input, "csv")).toMatchObject({
      filename: "Maple Leaf Rag - Dry v2 QA report.csv",
      contentType: "text/csv; charset=utf-8",
    });
    expect(qaReportFilename("Maple Leaf Rag - Dry v2.wav", "pdf")).toBe(
      "Maple Leaf Rag - Dry v2 QA report.pdf",
    );
  });
});

describe("text in a PDF", () => {
  it("keeps what Latin-1 can say and writes the rest plainly", () => {
    expect(latin1("−16 LUFS · “wide” — ok ✓")).toBe('-16 LUFS · "wide" - ok ?');
  });

  it("wraps long lines on spaces, and runs on to a new page", () => {
    const lines = wrap("word ".repeat(80).trim(), 10);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((l) => !l.startsWith(" ") && !l.endsWith(" "))).toBe(true);
    const many = textPdf(
      Array.from({ length: 200 }, (_, i) => ({ text: `Line ${i}` })),
      "Long",
    ).toString("latin1");
    expect(Number(/\/Count (\d+)/.exec(many)?.[1])).toBeGreaterThan(1);
  });
});
