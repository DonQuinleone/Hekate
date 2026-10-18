/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commentExportQuery,
  type ExportTarget,
  type ExportThread,
  exportComments,
  exportTargets,
} from "./comment-export.ts";
import {
  csvRows,
  decodeList,
  type ListedMarker,
  MarkerListError,
  markerBody,
  markerProblem,
  readMarkerList,
  readTime,
} from "./comment-import.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures", "markers", name)));

/** The parts of each marker a test cares about, times to the millisecond. */
const brief = (markers: ListedMarker[]) =>
  markers.map((m) => ({
    start: m.start === null ? null : Math.round(m.start * 1000) / 1000,
    end: m.end === null ? null : Math.round(m.end * 1000) / 1000,
    name: m.name,
    comment: m.comment,
    colour: m.colour,
  }));

describe("reading marker lists", () => {
  it("reads DaVinci Resolve's marker EDL, its timeline starting on the hour", () => {
    const list = readMarkerList(fixture("resolve.edl"));
    expect(list.format).toBe("edl");
    expect(list.startsAt).toBe(3600);
    expect(list.rate).toBe("25");
    expect(list.rateGuessed).toBe(true);
    expect(brief(list.markers)).toEqual([
      { start: 6.2, end: null, name: "Pedal noise", comment: "", colour: "Red" },
      { start: 17.6, end: 19.6, name: "Keep the rubato", comment: "", colour: "Sky" },
    ]);
  });

  it("reads Final Cut Pro's markers through their clip, to-dos and chapters", () => {
    const list = readMarkerList(fixture("final-cut-pro.fcpxml"));
    expect(list.format).toBe("fcpxml");
    expect(brief(list.markers)).toEqual([
      {
        start: 6,
        end: null,
        name: "Logo too early",
        comment: "Hold it two frames & fade",
        colour: "Standard",
      },
      { start: 20, end: 25, name: "Music swells", comment: "", colour: "To do" },
      { start: 30, end: null, name: "Titles", comment: "", colour: "Chapter" },
    ]);
  });

  it("reads Premiere Pro's sequence markers, in frames at its rate", () => {
    const list = readMarkerList(fixture("premiere.xml"));
    expect(list.format).toBe("xmeml");
    expect(brief(list.markers)).toEqual([
      {
        start: 6.2,
        end: null,
        name: "Logo too early",
        comment: "Hold it two frames",
        colour: null,
      },
      { start: 20, end: 25, name: "Music swells", comment: "", colour: null },
    ]);
  });

  it("reads Media Composer's marker text, with who made each", () => {
    const list = readMarkerList(fixture("avid.txt"));
    expect(list.format).toBe("avid");
    expect(brief(list.markers)).toEqual([
      { start: 6.2, end: null, name: "Pedal noise", comment: "", colour: "red" },
      { start: 17.6, end: 19.6, name: "Keep the rubato", comment: "", colour: "green" },
    ]);
    expect(list.markers.map((m) => m.author)).toEqual(["Tomas Varga", "Ines Arlow"]);
  });

  it("reads Reaper's markers and regions, and says which times it cannot read", () => {
    const list = readMarkerList(fixture("reaper.csv"));
    expect(list.format).toBe("reaper");
    expect(brief(list.markers)).toEqual([
      { start: 6.2, end: null, name: "Pedal noise", comment: "", colour: null },
      {
        start: 17.6,
        end: 19.6,
        name: "Keep the rubato, please",
        comment: "",
        colour: "#FF0000",
      },
      { start: null, end: null, name: "At bar nine", comment: "", colour: null },
    ]);
    expect(list.markers[2]?.time).toBe("9.1.00");
  });

  it("reads a CSV by its headings, in timecode from zero or as a spreadsheet writes it", () => {
    const nuendo = readMarkerList(fixture("nuendo.csv"));
    expect(nuendo.format).toBe("csv");
    expect(nuendo.startsAt).toBe(0);
    expect(brief(nuendo.markers)).toEqual([
      {
        start: 6.2,
        end: null,
        name: "Pedal noise",
        comment: "Left hand, before the downbeat",
        colour: null,
      },
      { start: 17.6, end: 19.6, name: "Keep the rubato", comment: "", colour: null },
    ]);
    expect(nuendo.markers[0]?.author).toBe("Mira Solberg");
    const sheet = readMarkerList(fixture("spreadsheet.csv"));
    expect(brief(sheet.markers)).toEqual([
      {
        start: 72.5,
        end: null,
        name: "The bass drops out",
        comment: "Half a bar, from beat three",
        colour: null,
      },
      { start: 95, end: null, name: "Lovely lift", comment: "", colour: null },
    ]);
  });

  it("reads the markers of Pro Tools' session text by their samples", () => {
    const list = readMarkerList(fixture("pro-tools.txt"));
    expect(list.format).toBe("pro-tools");
    expect(list.startsAt).toBe(0);
    expect(brief(list.markers)).toEqual([
      {
        start: 6.2,
        end: null,
        name: "Pedal noise",
        comment: "Left hand, before the downbeat",
        colour: null,
      },
      { start: 17.6, end: null, name: "Keep the rubato", comment: "", colour: null },
    ]);
    // Without samples, the location is read in the session's timecode, from the hour.
    const located = new TextDecoder()
      .decode(fixture("pro-tools.txt"))
      .replace(/Samples/g, "Timecode");
    const byLocation = readMarkerList(new TextEncoder().encode(located));
    expect(byLocation.rate).toBe("25");
    expect(byLocation.rateGuessed).toBe(false);
    expect(byLocation.markers.map((m) => m.start)).toEqual([
      expect.closeTo(6.2, 5),
      expect.closeTo(17.6, 5),
    ]);
    // A 23.976 session's timecode counts 24 frames, each a thousandth longer.
    const slow = located.replace("25 Frame", "23.976 Frame").replace("01:00:17:15", "01:10:00:00");
    const pulled = readMarkerList(new TextEncoder().encode(slow));
    expect(pulled.rate).toBe("23.976");
    expect(pulled.startsAt).toBeCloseTo(3603.6, 5);
    expect(pulled.markers[1]?.start).toBeCloseTo(600.6, 5);
  });

  it("starts a drop-frame timeline on the hour it is labelled with", () => {
    const list = readMarkerList(
      new TextEncoder().encode(
        "Tomas Varga\t01:00:00;00\tV1\tred\tFirst frame\t1\nTomas Varga\t01:10:00;00\tV1\tred\tTen minutes in\t1\n",
      ),
    );
    expect(list.rate).toBe("29.97df");
    expect(list.markers.map((m) => m.start)).toEqual([0, expect.closeTo(600, 2)]);
  });

  it("reads a MIDI file's markers through its tempo", () => {
    const list = readMarkerList(fixture("pro-tools.mid"));
    expect(list.format).toBe("midi");
    expect(brief(list.markers)).toEqual([
      { start: 6.2, end: null, name: "Mira Solberg: Pedal noise", comment: "", colour: null },
      { start: 17.6, end: null, name: "Ines Arlow: Keep the rubato", comment: "", colour: null },
    ]);
  });

  it("reads a MIDI file counting in SMPTE frames at 29.97", () => {
    // Division -29 frames, 4 ticks a frame; one marker 30 frames (about a second) in.
    const track = [0x1e, 0xff, 0x06, 0x02, 0x48, 0x69, 0x00, 0xff, 0x2f, 0x00];
    const bytes = Uint8Array.from([
      ...[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0xe3, 0x01],
      ...[0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, track.length],
      ...track,
    ]);
    const [marker] = readMarkerList(bytes).markers;
    expect(marker?.name).toBe("Hi");
    expect(marker?.start).toBeCloseTo(1.001, 5);
  });

  it("reads lines of plain text that start with a time", () => {
    const list = readMarkerList(fixture("notes.txt"));
    expect(list.format).toBe("text");
    expect(brief(list.markers)).toEqual([
      {
        start: 6.2,
        end: null,
        name: "Pedal noise on the left",
        comment: "Just before the downbeat.",
        colour: null,
      },
      { start: 72.5, end: null, name: "The bass drops out", comment: "", colour: null },
    ]);
  });

  it("refuses what it cannot read, saying why", () => {
    const text = (s: string) => new TextEncoder().encode(s);
    expect(() => readMarkerList(text("<html><body/></html>"))).toThrow(MarkerListError);
    expect(() =>
      readMarkerList(
        text(
          "TITLE: Cut\nFCM: NON-DROP FRAME\n\n001  AX  V  C  00:00:00:00 00:00:05:00 01:00:00:00 01:00:05:00\n",
        ),
      ),
    ).toThrow(/no markers/);
    expect(() => readMarkerList(text("Nothing here\nat all\n"))).toThrow(/starts with a time/);
    expect(() => readMarkerList(Uint8Array.from([0x4d, 0x54, 0x68, 0x64, 0, 0]))).toThrow(
      MarkerListError,
    );
  });
});

describe("reading back every export", () => {
  const threads: ExportThread[] = [
    {
      anchor: { kind: "time", start: 6.2, end: 6.2 },
      channel: null,
      author: "Mira Solberg",
      body: "Pedal noise",
      resolved: false,
      replies: [],
    },
    {
      anchor: { kind: "time", start: 17.6, end: 19.6 },
      channel: null,
      author: "Ines Arlow",
      body: "Keep the rubato",
      resolved: false,
      replies: [],
    },
  ];
  const source = {
    name: "Maple Leaf Rag.wav",
    duration: 40,
    sampleRate: 48_000,
    fps: null,
    video: false,
  };
  for (const target of Object.keys(exportTargets) as ExportTarget[]) {
    for (const time of ["timecode", "timecode-hour"] as const) {
      it(`places ${exportTargets[target].label}'s markers where they were (${time})`, () => {
        const out = exportComments(threads, source, commentExportQuery.parse({ target, time }));
        const list = readMarkerList(out.bytes);
        expect(list.markers.map((m) => m.start)).toEqual([
          expect.closeTo(6.2, 1),
          expect.closeTo(17.6, 1),
        ]);
        expect(list.markers.map((m) => markerBody(m))).toEqual([
          expect.stringContaining("Pedal noise"),
          expect.stringContaining("Keep the rubato"),
        ]);
      });
    }
  }
});

describe("the pieces", () => {
  it("reads times as lists write them", () => {
    expect(readTime("01:00:06:05")).toEqual({ timecode: "01:00:06:05" });
    expect(readTime("1:00:06;05")).toEqual({ timecode: "01:00:06;05" });
    expect(readTime("1:02:03.5")).toEqual({ seconds: 3723.5 });
    expect(readTime("0:06.200")).toEqual({ seconds: 6.2 });
    expect(readTime("6.2")).toEqual({ seconds: 6.2 });
    expect(readTime("9.1.00")).toEqual({ unreadable: "9.1.00" });
    expect(readTime("5|1|000")).toEqual({ unreadable: "5|1|000" });
  });

  it("reads a long line of plain text in time", () => {
    const line = `9 ${"  ".repeat(50_000)}x\n`;
    const started = Date.now();
    expect(readMarkerList(new TextEncoder().encode(line)).markers[0]).toMatchObject({
      start: 9,
      name: "x",
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("splits CSV as spreadsheets write it", () => {
    expect(csvRows('a,"b, c","say ""hi"""\r\n1,2,3\n', ",")).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("decodes UTF-8, Windows Latin-1 and UTF-16", () => {
    expect(decodeList(Uint8Array.from([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9]))).toBe(
      "café",
    );
    expect(decodeList(Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x61, 0x94]))).toBe(
      "café “a”",
    );
    expect(decodeList(Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00]))).toBe("hé");
  });

  it("says why a marker cannot be a comment, and what it says if it can", () => {
    const marker = (more: Partial<ListedMarker>): ListedMarker => ({
      row: 1,
      start: 6.2,
      end: null,
      time: "6.2",
      name: "Pedal noise",
      comment: "",
      colour: null,
      author: null,
      ...more,
    });
    expect(markerProblem(marker({}), 40)).toBeNull();
    expect(markerProblem(marker({ start: null }), 40)).toBe("no time it can read");
    expect(markerProblem(marker({ start: 52 }), 40)).toBe("past the end of the file");
    expect(markerProblem(marker({ start: 38, end: 45 }), 40)).toBe("past the end of the file");
    expect(markerProblem(marker({ start: 38, end: 40.2 }), 40)).toBeNull();
    expect(markerProblem(marker({ start: -1 }), 40)).toBe("before the start of the file");
    expect(markerProblem(marker({ name: "" }), 40)).toBe("says nothing");
    expect(markerBody(marker({ comment: "Left hand" }))).toBe("Pedal noise\nLeft hand");
    expect(markerBody(marker({ comment: "Pedal noise" }))).toBe("Pedal noise");
    expect(markerBody(marker({ name: "", comment: "Left hand" }))).toBe("Left hand");
  });
});
