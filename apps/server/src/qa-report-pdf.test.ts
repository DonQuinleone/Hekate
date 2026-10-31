import { deflateSync } from "node:zlib";
import { deliveryProfiles, type QaFinding, qaDocument } from "@hekate/shared";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { pdfImageOfPng } from "./media/png.ts";
import {
  PRINT,
  QA_REPORT_PAGE,
  qaReportPages,
  qaReportPdf,
  type ReportLook,
  type SetWords,
  tint,
  wrapped,
} from "./qa-report-pdf.ts";

const finding = (f: Partial<QaFinding>): QaFinding => ({
  check: "clipping",
  severity: "fail",
  summary: "Clipped 118 times",
  channel: null,
  start: 12,
  end: 12.5,
  details: {},
  ...f,
});

/** Forty seconds of stereo peaks at 256 samples a peak, louder where it clips. */
function peaks() {
  const count = Math.floor((40 * 44_100) / 256);
  const data = new Int8Array(count * 4);
  for (let p = 0; p < count; p++) {
    const t = (p * 256) / 44_100;
    const level = t > 12 && t < 12.5 ? 127 : Math.round(Math.exp(-4 * (t % 0.5)) * 50 + 8);
    data.set([-level, level, -level, level], p * 4);
  }
  return { channels: 2, sampleRate: 44_100, samplesPerPeak: 256, count, data };
}

/** The seeded report's shape: a dry mix that clips, drops out and misses its loudness. */
export const fixtureDocument = (extra: QaFinding[] = []) =>
  qaDocument({
    file: {
      id: "0190a6f0-0000-7000-8000-000000000001",
      name: "Maple Leaf Rag - Dry v2.wav",
      track: "Maple Leaf Rag",
      version: 2,
      variant: "Dry",
    },
    workspace: "Endless Hall Records",
    project: "Joplin Rags",
    preparedBy: { name: "Tomas Varga", role: "Engineer" },
    preparedAt: new Date("2026-10-31T14:02:00Z"),
    preparedOn: "2026-10-31 14:02 UTC",
    measuredOn: "2026-10-30",
    profile: deliveryProfiles.streaming,
    rules: [],
    status: "ready",
    loudness: {
      integrated: -16.4,
      range: 6.2,
      momentaryMax: -10,
      shortTermMax: -12.1,
      truePeak: 0.4,
      channels: [],
    },
    format: {
      format: "wav",
      duration: 40,
      audio: {
        codec: "pcm_s16le",
        channels: 2,
        channelLayout: "stereo",
        sampleRate: 44_100,
        bitDepth: 16,
      },
      metadata: {
        tags: { title: "Maple Leaf Rag", artist: "Endless Hall Records" },
        bext: { description: "Maple Leaf Rag, V2 dry", originator: "Endless Hall Records" },
      },
    },
    findings: [
      finding({}),
      finding({
        check: "true-peak",
        start: null,
        end: null,
        summary: "True peak 0.4 dBTP, over the −1.0 dBTP ceiling",
        details: { truePeak: 0.4, ceiling: -1 },
      }),
      finding({ check: "dropouts", start: 31, end: 31.04, channel: 1, summary: "Dropout" }),
      finding({
        check: "loudness",
        severity: "warn",
        start: null,
        end: null,
        summary: "−16.4 LUFS, 2.4 LU below the −14 LUFS target",
        details: { integrated: -16.4, target: -14 },
      }),
      finding({ check: "dc-offset", severity: "pass", start: null, end: null }),
      ...extra,
    ],
    peaks: peaks(),
    shortTerm: {
      values: Array.from({ length: 400 }, (_, i) => -17 + 3 * Math.sin(i / 20)),
      secondsPerFrame: 0.1,
    },
    link: "https://review.endlesshall.example/files/0190a6f0-0000-7000-8000-000000000001?view=qa",
  });

const look = (over: Partial<ReportLook> = {}): ReportLook => ({
  accent: PRINT.signal,
  logo: null,
  mark: {
    text: "Tomas Varga · tomas@endlesshall.example\nEndless Hall Records · 31 October 2026",
    style: { position: "tiled", opacity: 30 },
  },
  qr: encode("https://review.endlesshall.example/files/x", { ecc: "M", border: 0 }).data,
  ...over,
});

/** A PNG of a few pixels, its rows filtered each of PNG's five ways. */
function png(width: number, height: number, rgba: number[][]) {
  const crc = (bytes: Buffer) => {
    let c = ~0;
    for (const b of bytes) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(typed));
    return Buffer.concat([head, typed, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  // Each row "Sub" filtered (1): every byte less the one a pixel to its left.
  const rows = Array.from({ length: height }, (_, y) => {
    const row = rgba.slice(y * width, (y + 1) * width).flat();
    const filtered = row.map((v, i) => (v - (i >= 4 ? (row[i - 4] as number) : 0)) & 0xff);
    return [1, ...filtered];
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows.flat()))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("the QA report as a document (#515)", () => {
  it("carries the brand at the head of every page, Hekate and the recipient's mark at its foot", () => {
    const pages = qaReportPages(fixtureDocument(), look());
    expect(pages.length).toBeGreaterThanOrEqual(4);
    pages.forEach((page, i) => {
      // The workspace's name beside Hekate's mark (two stems and the point in the accent).
      expect(page).toContain("(Endless Hall Records) Tj");
      expect(page).toMatch(/^0\.71 0\.24 0\.04 rg [\d. ]+ m .* c f$/m);
      expect(page).toContain("(Made with Hekate) Tj");
      expect(page).toContain(`(Page ${i + 1} of ${pages.length}) Tj`);
      // Whose copy it is, at the foot and across the page.
      expect(page).toContain("Prepared for Tomas Varga");
      expect(page).toContain("/Mark gs");
    });
  });

  it("puts the workspace's logo at the head of every page where it has one", () => {
    const logo = pdfImageOfPng(
      png(2, 2, [
        [255, 0, 0, 255],
        [0, 255, 0, 128],
        [0, 0, 255, 0],
        [10, 20, 30, 255],
      ]),
    );
    expect(logo).not.toBeNull();
    const pages = qaReportPages(fixtureDocument(), look({ logo }));
    for (const page of pages) expect(page).toContain("/Logo Do");
    const pdf = qaReportPdf(fixtureDocument(), look({ logo })).toString("latin1");
    expect(pdf).toContain("/Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /SMask");
    expect(pdf).toMatch(/\/XObject << \/Logo \d+ 0 R >>/);
  });

  it("sets the cover, the summary, the findings and the appendices", () => {
    const pages = qaReportPages(fixtureDocument(), look());
    const all = pages.join("\n");
    expect(pages[0]).toContain("(Maple Leaf Rag) Tj");
    expect(pages[0]).toContain("(Version 2 \\267 Dry) Tj");
    expect(pages[0]).toContain("(Not ready for Streaming: clipping, true peak and) Tj");
    // A minus sign, which Helvetica lacks, is set as an en dash.
    expect(pages[1]).toContain("(\\22616.4) Tj");
    expect(all).toContain("(What to do) Tj");
    expect(all).toContain("(A. Loudness over the whole file) Tj");
    expect(all).toContain("(C. Rules checked) Tj");
    expect(all).toContain("(D. The file in Hekate) Tj");
    // The link, and its QR code's modules.
    expect(all).toContain("https://review.endlesshall.example/files/");
    expect((all.match(/ re /g) ?? []).length).toBeGreaterThan(200);
  });

  it("never sets words into words, nor off the page, however many findings", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      finding({
        check: "clicks",
        severity: "warn",
        start: 1 + i,
        end: 1.01 + i,
        summary: `A click on channel ${(i % 2) + 1}, 18 dB above the music around it, the kind a declicker takes out`,
      }),
    );
    for (const doc of [fixtureDocument(), fixtureDocument(many)]) {
      const layout: SetWords[][] = [];
      qaReportPages(doc, look(), layout);
      layout.forEach((words, page) => {
        for (const w of words) {
          expect(w.x, `${w.words} on page ${page + 1}`).toBeGreaterThanOrEqual(24);
          expect(w.x + w.width, `${w.words} on page ${page + 1}`).toBeLessThanOrEqual(
            QA_REPORT_PAGE.width - 24,
          );
          expect(w.top).toBeLessThan(QA_REPORT_PAGE.height - 24);
        }
        const box = (w: SetWords) => ({
          left: w.x,
          right: w.x + w.width,
          top: w.top - w.size * 0.72,
          bottom: w.top + w.size * 0.2,
        });
        words.forEach((a, i) => {
          for (const b of words.slice(i + 1)) {
            const p = box(a);
            const q = box(b);
            const overlap =
              p.left < q.right - 0.5 &&
              q.left < p.right - 0.5 &&
              p.top < q.bottom - 0.5 &&
              q.top < p.bottom - 0.5;
            expect(overlap, `"${a.words}" runs into "${b.words}" on page ${page + 1}`).toBe(false);
          }
        });
      });
    }
  });

  it("sets the fifth and later of a check a line each", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      finding({
        check: "clicks",
        severity: "warn",
        start: 1 + i,
        end: 1.01 + i,
        summary: `Click ${i}`,
      }),
    );
    const all = qaReportPages(fixtureDocument(many), look()).join("\n");
    // Four of the clicks set out in full, beside the four other findings.
    expect(all.match(/\(What to do\) Tj/g)?.length).toBe(8);
    expect(all).toContain("(Click 9) Tj");
  });

  it("writes a PDF whose cross-references point at each object", () => {
    const text = qaReportPdf(fixtureDocument(), look()).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/ExtGState << /Mark << /Type /ExtGState /ca 0.3 /CA 0.3 >> >>");
    const offset = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(text.slice(offset, offset + 4)).toBe("xref");
    const offsets = [...text.matchAll(/(\d{10}) 00000 n \n/g)].map((m) => Number(m[1]));
    offsets.forEach((at, i) => {
      expect(text.slice(at).startsWith(`${i + 1} 0 obj`)).toBe(true);
    });
  });

  it("draws the mark once across the middle, or in the corner, as the project chooses", () => {
    const centre = qaReportPages(
      fixtureDocument(),
      look({
        mark: {
          text: "A · a@example.test\nB · 1 November 2026",
          style: { position: "centre", opacity: 50 },
        },
      }),
    );
    expect(centre[1]?.match(/\/Mark gs/g)?.length).toBe(1);
    const corner = qaReportPages(
      fixtureDocument(),
      look({
        mark: {
          text: "A · a@example.test\nB · 1 November 2026",
          style: { position: "corner", opacity: 50 },
        },
      }),
    );
    expect(corner[1]?.match(/\/Mark gs/g)?.length).toBe(2);
  });
});

describe("a logo as a PDF draws it", () => {
  it("undoes the PNG's filters and keeps its colour and opacity apart", async () => {
    const { inflateSync } = await import("node:zlib");
    const image = pdfImageOfPng(
      png(2, 1, [
        [200, 100, 50, 255],
        [10, 20, 30, 64],
      ]),
    );
    expect(image).toMatchObject({ width: 2, height: 1 });
    expect([...inflateSync(image?.rgb as Buffer)]).toEqual([200, 100, 50, 10, 20, 30]);
    expect([...inflateSync(image?.alpha as Buffer)]).toEqual([255, 64]);
  });

  it("refuses what is not an eight-bit RGB or RGBA PNG", () => {
    expect(pdfImageOfPng(Buffer.from("not a picture"))).toBeNull();
    const paletted = png(1, 1, [[0, 0, 0, 255]]);
    paletted[8 + 8 + 9] = 3;
    expect(pdfImageOfPng(paletted)).toBeNull();
  });
});

describe("words on the page", () => {
  it("wrap at spaces within the width", () => {
    const lines = wrapped("word ".repeat(60).trim(), 200, 10);
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.every((l) => !l.startsWith(" ") && !l.endsWith(" "))).toBe(true);
  });

  it("mix a colour towards paper", () => {
    expect(tint("#b53c0a", 1)).toBe("#b53c0a");
    expect(tint("#b53c0a", 0)).toBe("#ffffff");
  });
});
