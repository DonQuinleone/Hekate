import { describe, expect, it } from "vitest";
import {
  type CommentExportQuery,
  commentExportQuery,
  type ExportSource,
  type ExportThread,
  encodeText,
  exportChoices,
  exportComments,
  frameRates,
  hourFrames,
  nearestFrameRate,
  threadsForExport,
  timecode,
} from "./comment-export.ts";

const recording: ExportSource = {
  name: "Maple Leaf Rag V3.wav",
  duration: 190,
  sampleRate: 48_000,
  fps: null,
  video: false,
};

const threads: ExportThread[] = [
  {
    anchor: { kind: "time", start: 72.32, end: 72.32 },
    channel: null,
    author: "Mira Solberg",
    body: "The pedal blurs the left hand here.\nTry the dry take.",
    resolved: false,
    replies: [{ author: "Tomas Varga", body: "Agreed, will retake." }],
  },
  {
    anchor: { kind: "time", start: 10, end: 14.5 },
    channel: null,
    author: "Ines Arlow",
    body: "Balance, right hand too loud",
    resolved: true,
    replies: [],
  },
  {
    anchor: { kind: "bar", from: { bar: 25, beat: 1 }, at: 40 },
    channel: null,
    author: "Alex Rivera",
    body: "=SUM(A1) is a joke, but the rubato is not",
    resolved: false,
    replies: [],
  },
  {
    anchor: null,
    channel: null,
    author: "Mira Solberg",
    body: "Overall: lovely.",
    resolved: false,
    replies: [],
  },
];

/** Bytes read one to a character: ASCII as itself, Latin-1 as its letters. */
const chars = (bytes: Uint8Array) => String.fromCharCode(...bytes);
const contains = (bytes: Uint8Array, part: number[]) =>
  bytes.some((_, i) => part.every((c, j) => bytes[i + j] === c));

const options = (query: CommentExportQuery) => commentExportQuery.parse(query);
const run = (query: CommentExportQuery, source = recording) =>
  exportComments(threads, source, options(query));

describe("timecode", () => {
  it("counts non-drop frames", () => {
    expect(timecode(0, frameRates["25"])).toBe("00:00:00:00");
    expect(timecode(1808, frameRates["25"])).toBe("00:01:12:08");
    expect(timecode(hourFrames(frameRates["25"]), frameRates["25"])).toBe("01:00:00:00");
  });

  it("skips drop-frame labels except every tenth minute", () => {
    const df = frameRates["29.97df"];
    expect(timecode(1799, df)).toBe("00:00:59;29");
    expect(timecode(1800, df)).toBe("00:01:00;02");
    expect(timecode(17982, df)).toBe("00:10:00;00");
    expect(hourFrames(df)).toBe(107_892);
    expect(timecode(hourFrames(df), df)).toBe("01:00:00;00");
    expect(timecode(hourFrames(frameRates["59.94df"]), frameRates["59.94df"])).toBe("01:00:00;00");
  });

  it("finds a video's standard rate", () => {
    expect(nearestFrameRate(23.976)).toBe("23.976");
    expect(nearestFrameRate(25)).toBe("25");
    expect(nearestFrameRate(29.97)).toBe("29.97");
  });
});

describe("encodeText", () => {
  it("writes Windows Latin-1 for older systems", () => {
    expect([...encodeText("é – ’", "latin-1")]).toEqual([0xe9, 0x20, 0x96, 0x20, 0x92]);
    // Letters it lacks lose their accents; anything else is a question mark.
    expect(chars(encodeText("Dvořák ♪", "latin-1"))).toBe("Dvorák ?");
    expect(encodeText("é", "utf-8")).toEqual(new Uint8Array([0xc3, 0xa9]));
  });
});

describe("exportChoices", () => {
  it("offers only what each format can carry", () => {
    expect(exportChoices("pro-tools", recording).timeBases).toEqual([]);
    expect(exportChoices("resolve", recording).timeBases).toEqual(["timecode", "timecode-hour"]);
    expect(exportChoices("csv", recording).timeBases).toContain("samples");
    expect(exportChoices("csv", { sampleRate: null }).timeBases).not.toContain("samples");
    expect(exportChoices("final-cut-pro", recording).encoding).toBe(false);
    expect(exportChoices("text", recording).untimed).toBe(true);
    expect(exportChoices("nuendo", recording).untimed).toBe(false);
  });
});

describe("exportComments", () => {
  it("writes open threads in time order by default, leaving out those without a time", () => {
    const out = run({ target: "resolve" });
    expect(out.written).toBe(2);
    expect(out.untimed).toBe(1);
    expect(out.filename).toBe("Maple Leaf Rag V3 comments.edl");
    expect(out.text?.split("\r\n")).toEqual([
      "TITLE: Maple Leaf Rag V3.wav",
      "FCM: NON-DROP FRAME",
      "",
      "001  001      V     C        00:00:40:00 00:00:40:01 00:00:40:00 00:00:40:01  ",
      " |C:ResolveColorRed |M:BAR 25 Alex Rivera: =SUM(A1) is a joke, but the rubato is not |D:1",
      "",
      "002  001      V     C        00:01:12:08 00:01:12:09 00:01:12:08 00:01:12:09  ",
      " |C:ResolveColorRed |M:Mira Solberg: The pedal blurs the left hand here. |D:1",
      "",
    ]);
  });

  it("includes resolved threads and replies when asked, from 01:00:00:00", () => {
    const out = run({ target: "resolve", threads: "all", replies: "true", time: "timecode-hour" });
    expect(out.written).toBe(3);
    expect(out.text).toContain(
      "001  001      V     C        01:00:10:00 01:00:14:13 01:00:10:00 01:00:14:13  ",
    );
    expect(out.text).toContain(
      " |C:ResolveColorGreen |M:Ines Arlow: Balance, right hand too loud |D:113",
    );
    expect(out.text).toContain(
      "|M:Mira Solberg: The pedal blurs the left hand here. / Reply from Tomas Varga: Agreed, will retake. |D:1",
    );
  });

  it("writes a spreadsheet with every thread and no formulas", () => {
    const out = run({ target: "csv", threads: "all", time: "seconds" });
    const lines = out.text?.split("\r\n") ?? [];
    expect(lines[0]).toBe(
      "Start (seconds),End (seconds),Name,Comment,Author,Anchor,Status,Channel",
    );
    expect(lines[1]).toBe(
      '10.000,14.500,"Ines Arlow: Balance, right hand too loud","Balance, right hand too loud",Ines Arlow,00:10.000 – 00:14.500,Resolved,Every channel',
    );
    expect(out.text).toContain(
      `,"'=SUM(A1) is a joke, but the rubato is not",Alex Rivera,BAR 25,Open`,
    );
    expect(out.text).toContain(
      ",,Mira Solberg: Overall: lovely.,Overall: lovely.,Mira Solberg,Whole file,Open,Every channel",
    );
    expect(out.written).toBe(4);
    expect(out.untimed).toBe(0);
  });

  it("writes samples where the recording's rate is known", () => {
    const out = run({ target: "csv", time: "samples" });
    expect(out.text).toContain('\r\n1920000,1920000,"BAR 25 Alex Rivera:');
  });

  it("writes Nuendo's CSV in timecode", () => {
    const out = run({ target: "nuendo", time: "seconds" });
    expect(out.text?.split("\r\n")[0]).toBe(
      "Timecode In,Timecode Out,Name,Comment,Author,Anchor,Status,Channel",
    );
    expect(out.text).toContain('\r\n00:00:40:00,00:00:40:00,"BAR 25 Alex Rivera:');
    expect(out.untimed).toBe(1);
  });

  it("writes Reaper's markers and regions", () => {
    const out = run({ target: "reaper", threads: "all" });
    expect(out.text?.split("\r\n")).toEqual([
      "#,Name,Start,End,Length,Color",
      'R1,"Ines Arlow: Balance, right hand too loud",00:00:10:00,00:00:14:13,00:00:04:13,',
      'M1,"BAR 25 Alex Rivera: =SUM(A1) is a joke, but the rubato is not",00:00:40:00,,,',
      "M2,Mira Solberg: The pedal blurs the left hand here.,00:01:12:08,,,",
      "",
    ]);
  });

  it("writes Avid's tab-separated markers with Unix line ends", () => {
    const out = run(
      { target: "avid", time: "timecode-hour" },
      { ...recording, fps: 25, video: true },
    );
    expect(out.text).toBe(
      [
        "Alex Rivera\t01:00:40:00\tV1\tred\tBAR 25 Alex Rivera: =SUM(A1) is a joke, but the rubato is not\t1\n",
        "Mira Solberg\t01:01:12:08\tV1\tred\tMira Solberg: The pedal blurs the left hand here.\t1\n",
      ].join(""),
    );
    expect(out.text).not.toContain("\r");
  });

  it("writes Final Cut Pro's to-do markers in the video's own rate", () => {
    const video = { ...recording, name: "Opening titles.mov", fps: 23.976, video: true };
    const out = run({ target: "final-cut-pro", threads: "all", replies: "true" }, video);
    expect(out.filename).toBe("Opening titles comments.fcpxml");
    expect(out.contentType).toBe("application/xml; charset=utf-8");
    expect(out.text).toContain('<format id="r1" frameDuration="1001/24000s"');
    expect(out.text).toContain('tcFormat="NDF"');
    // 72.32 s is frame 1734 at 23.976.
    expect(out.text).toContain(
      '<marker start="1735734/24000s" duration="1001/24000s" value="Mira Solberg: The pedal blurs the left hand here." completed="0" note="The pedal blurs the left hand here.\nTry the dry take.\nReply from Tomas Varga: Agreed, will retake."/>',
    );
    expect(out.text).toContain('completed="1"');
  });

  it("writes Premiere's sequence markers in frames", () => {
    const out = run({ target: "premiere", time: "timecode-hour" }, { ...recording, fps: 25 });
    expect(out.text).toContain("<string>01:00:00:00</string>");
    expect(out.text).toContain("<frame>90000</frame>");
    expect(out.text).toContain("<in>1808</in>");
    expect(out.text).toContain("<out>-1</out>");
    expect(out.text).toContain("<duration>4750</duration>");
  });

  it("escapes XML", () => {
    const nasty: ExportThread = {
      anchor: { kind: "time", start: 1, end: 1 },
      channel: null,
      author: "Tomas <Varga>",
      body: 'Say "loud" & mean it\u0007',
      resolved: false,
      replies: [],
    };
    const out = exportComments([nasty], recording, options({ target: "premiere" }));
    expect(out.text).toContain(
      "<name>Tomas &lt;Varga&gt;: Say &quot;loud&quot; &amp; mean it</name>",
    );
    expect(out.text).not.toContain("\u0007");
  });

  it("writes a MIDI file of markers at 120 beats a minute", () => {
    const out = run({ target: "pro-tools" });
    expect(out.text).toBeNull();
    expect(out.filename).toBe("Maple Leaf Rag V3 comments.mid");
    expect(out.contentType).toBe("audio/midi");
    const b = out.bytes;
    expect(chars(b.slice(0, 4))).toBe("MThd");
    expect([...b.slice(8, 14)]).toEqual([0, 0, 0, 1, 0x03, 0xc0]);
    expect(chars(b.slice(14, 18))).toBe("MTrk");
    const [l0 = 0, l1 = 0, l2 = 0, l3 = 0] = b.slice(18, 22);
    const length = (l0 << 24) | (l1 << 16) | (l2 << 8) | l3;
    expect(b.length).toBe(22 + length);
    // The first marker sits 40 s in: 76,800 ticks as a variable-length quantity.
    const at = chars(b).indexOf("BAR 25 Alex Rivera");
    expect(at).toBeGreaterThan(0);
    expect([...b.slice(at - 6, at - 2)]).toEqual([0x84, 0xd8, 0x00, 0xff]);
    expect(b[at - 2]).toBe(0x06);
    expect([...b.slice(-3)]).toEqual([0xff, 0x2f, 0x00]);
  });

  it("writes a sheet to read, replies and all", () => {
    const out = run({ target: "text", threads: "all", replies: "true" });
    const lines = out.text?.split("\r\n") ?? [];
    expect(lines.slice(0, 3)).toEqual([
      "Comments on Maple Leaf Rag V3.wav",
      "",
      "001  00:00:10:00  Ines Arlow (resolved)",
    ]);
    expect(out.text).toContain(
      "003  00:01:12:08  Mira Solberg\r\n     The pedal blurs the left hand here.\r\n     Try the dry take.\r\n     Reply from Tomas Varga: Agreed, will retake.",
    );
    expect(out.text).toContain("002  00:00:40:00  BAR 25  Alex Rivera");
    expect(out.text).toContain("004  Whole file  Mira Solberg");
  });

  it("writes plain seconds in the sheet when seconds are asked for", () => {
    const out = run({ target: "text", threads: "all", time: "seconds" });
    expect(out.text).toContain("001  10.000  Ines Arlow (resolved)");
  });

  it("never lets a name start a formula in a spreadsheet cell", () => {
    const named: ExportThread = {
      anchor: { kind: "time", start: 5, end: 5 },
      channel: null,
      author: "=HYPERLINK(1)",
      body: "Listen",
      resolved: false,
      replies: [],
    };
    const out = exportComments([named], recording, options({ target: "csv", time: "seconds" }));
    expect(out.text?.split("\r\n")[1]).toBe(
      "5.000,5.000,'=HYPERLINK(1): Listen,Listen,'=HYPERLINK(1),00:05.000,Open,Every channel",
    );
  });

  it("encodes text formats as asked, and XML always as UTF-8", () => {
    const accented: ExportThread = {
      ...(threads[0] as ExportThread),
      author: "Inès Arlow",
      replies: [],
    };
    const csv = exportComments(
      [accented],
      recording,
      options({ target: "csv", encoding: "latin-1" }),
    );
    expect(csv.contentType).toBe("text/csv; charset=windows-1252");
    expect(csv.bytes.includes(0xe8)).toBe(true);
    const xml = exportComments(
      [accented],
      recording,
      options({ target: "final-cut-pro", encoding: "latin-1" }),
    );
    expect(xml.contentType).toBe("application/xml; charset=utf-8");
    expect(contains(xml.bytes, [0x49, 0x6e, 0xc3, 0xa8, 0x73])).toBe(true);
  });
});

describe("threadsForExport", () => {
  it("gathers replies under their thread and leaves hidden carries out", () => {
    const at = { kind: "time", start: 3, end: 3 };
    const row = (id: string, more: Partial<Parameters<typeof threadsForExport>[0][number]>) => ({
      id,
      parentId: null,
      anchor: null,
      channel: null,
      authorName: "Mira Solberg",
      body: id,
      resolvedAt: null,
      carry: null,
      ...more,
    });
    expect(
      threadsForExport([
        row("a", { anchor: at }),
        row("b", { carry: { visible: false } }),
        row("a1", { parentId: "a", authorName: null }),
        row("c", { resolvedAt: "2026-10-16T10:00:00Z", carry: { visible: true } }),
        row("a2", { parentId: "a", authorName: "Tomas Varga" }),
      ]),
    ).toEqual([
      {
        anchor: at,
        channel: null,
        author: "Mira Solberg",
        body: "a",
        resolved: false,
        replies: [
          { author: "A former member", body: "a1" },
          { author: "Tomas Varga", body: "a2" },
        ],
      },
      {
        anchor: null,
        channel: null,
        author: "Mira Solberg",
        body: "c",
        resolved: true,
        replies: [],
      },
    ]);
  });

  it("names the channel a thread is about from the file's speakers", () => {
    const row = (id: string, channel: number | null) => ({
      id,
      parentId: null,
      anchor: null,
      channel,
      authorName: "Mira Solberg",
      body: id,
      resolvedAt: null,
      carry: null,
    });
    const named = threadsForExport(
      [row("a", 0), row("b", 3), row("c", null)],
      ["L", "R", "C", "4"],
    );
    expect(named.map((t) => t.channel)).toEqual(["L", "Channel 4", null]);
  });
});

describe("a thread about one channel", () => {
  const left: ExportThread = {
    anchor: { kind: "time", start: 6.2, end: 6.2 },
    channel: "L",
    author: "Alex Rivera",
    body: "Pedal noise on the left.",
    resolved: false,
    replies: [],
  };
  it("says so in the marker's name, the sheet and the text", () => {
    const sheet = exportComments([left], recording, options({ target: "csv", time: "seconds" }));
    expect(sheet.text).toContain(
      "6.200,6.200,[L] Alex Rivera: Pedal noise on the left.,Pedal noise on the left.,Alex Rivera,00:06.200,Open,L",
    );
    const text = exportComments([left], recording, options({ target: "text", time: "seconds" }));
    expect(text.text).toContain("001  6.200  [L]  Alex Rivera");
    const reaper = exportComments([left], recording, options({ target: "reaper" }));
    expect(reaper.text).toContain("M1,[L] Alex Rivera: Pedal noise on the left.,");
  });
});
