import { describe, expect, it } from "vitest";
import { CaptionError, captionFormatOf, cuesAt, parseCaptions } from "./captions.ts";

describe("captions from a sidecar file (#146)", () => {
  it("reads SubRip, markup and position codes dropped, lines kept", () => {
    const srt = [
      "1",
      "00:00:06,000 --> 00:00:09,500",
      "{\\an8}<i>ENDLESS HALL RECORDS</i>",
      "PRESENTS",
      "",
      "2",
      "00:00:20,040 --> 00:00:24,000",
      "A film by &lt;Mira Solberg&gt;",
      "",
    ].join("\r\n");
    expect(captionFormatOf("titles.txt", srt)).toBe("srt");
    expect(parseCaptions(srt, "srt")).toEqual([
      { start: 6, end: 9.5, text: "ENDLESS HALL RECORDS\nPRESENTS" },
      { start: 20.04, end: 24, text: "A film by <Mira Solberg>" },
    ]);
  });

  it("reads WebVTT: short times, settings, voices, notes and styles", () => {
    const vtt = [
      "﻿WEBVTT - Opening titles",
      "",
      "NOTE Checked against Cut 3",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "intro",
      "00:06.000 --> 00:09.500 line:10% align:center",
      "<v Narrator>Endless Hall Records</v> presents",
      "",
      "01:00:00.000 --> 01:00:02.250",
      "<c.loud>The end</c><00:00:01.000>",
    ].join("\n");
    expect(captionFormatOf("whatever.srt", vtt)).toBe("vtt");
    expect(parseCaptions(vtt, "vtt")).toEqual([
      { start: 6, end: 9.5, text: "Endless Hall Records presents" },
      { start: 3600, end: 3602.25, text: "The end" },
    ]);
  });

  it("reads TTML: clock times, frames, offsets, durations, breaks and divisions", () => {
    const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    ttp:frameRate="25" ttp:tickRate="10000000" xml:lang="en">
  <body>
    <div>
      <p begin="00:00:06.000" end="00:00:09:12">ENDLESS HALL<br/>RECORDS</p>
      <p begin="200000000t" dur="5s"><span tts:fontStyle="italic">A film by</span> Mira&#160;Solberg</p>
      <p begin="40s"/>
    </div>
    <div begin="60s">
      <p begin="1s" end="3s">The end</p>
    </div>
  </body>
</tt>`;
    expect(captionFormatOf("titles.xml", ttml)).toBe("ttml");
    expect(parseCaptions(ttml, "ttml")).toEqual([
      { start: 6, end: 9.48, text: "ENDLESS HALL\nRECORDS" },
      { start: 20, end: 25, text: "A film by Mira Solberg" },
      { start: 61, end: 63, text: "The end" },
    ]);
  });

  it("reads namespaced TTML at NTSC's rate", () => {
    const ttml = `<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" ttp:frameRate="30" ttp:frameRateMultiplier="1000 1001">
<tt:body><tt:div><tt:p begin="00:00:01:00" end="00:00:01:15">One</tt:p></tt:div></tt:body></tt:tt>`;
    const [cue] = parseCaptions(ttml, "ttml");
    expect(cue?.text).toBe("One");
    expect(cue?.start).toBeCloseTo(1, 6);
    expect(cue?.end).toBeCloseTo(1 + 15 / (30000 / 1001), 6);
  });

  it("says why a file cannot be read", () => {
    expect(() => parseCaptions("Nothing timed here", "srt")).toThrow(CaptionError);
    expect(() => parseCaptions("1\n00:00:01 --> 00:00:02\nHi", "srt")).toThrow(
      "This timing cannot be read",
    );
    expect(() => parseCaptions("00:01.000 --> 00:02.000\nHi", "vtt")).toThrow("begins with WEBVTT");
    expect(() =>
      parseCaptions("<tt><body><p begin='soon' end='2s'>x</p></body></tt>", "ttml"),
    ).toThrow("This begin cannot be read: soon");
    expect(captionFormatOf("notes.txt", "Just some words")).toBeNull();
    // Comments before the root, however many, and an unclosed one.
    expect(captionFormatOf("x", `<!-- a --><!-- b -->\n<tt>`)).toBe("ttml");
    expect(captionFormatOf("x", `<!--${"--><!--".repeat(5000)}`)).toBeNull();
  });

  it("leaves no tag behind, however it is nested", () => {
    const [cue] = parseCaptions("1\n00:00:01,000 --> 00:00:02,000\n<<b>i>Hello</<b>i>\n", "srt");
    expect(cue?.text).toBe("Hello");
  });

  it("orders cues by time and shows those under the playhead", () => {
    const cues = parseCaptions(
      "WEBVTT\n\n00:05.000 --> 00:08.000\nLater\n\n00:01.000 --> 00:06.000\nFirst\n",
      "vtt",
    );
    expect(cues.map((c) => c.text)).toEqual(["First", "Later"]);
    expect(cuesAt(cues, 5.5).map((c) => c.text)).toEqual(["First", "Later"]);
    expect(cuesAt(cues, 6).map((c) => c.text)).toEqual(["Later"]);
    expect(cuesAt(cues, 8)).toEqual([]);
  });
});
