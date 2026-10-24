import { describe, expect, it } from "vitest";
import {
  activeCue,
  type CaptionCue,
  CaptionError,
  canonicalLanguage,
  captionFileName,
  captionFormatOf,
  captionFormats,
  captionKindOf,
  captionLanguage,
  captionLanguageOf,
  commonCaptionLanguages,
  cuesAt,
  defaultCaptionLabel,
  languageName,
  matchRanges,
  parseCaptions,
  searchCues,
  writeCaptions,
} from "./captions.ts";

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

  it("counts ticks as TTML does where no tick rate is given", () => {
    const ticks = (root: string) =>
      parseCaptions(`<tt${root}><body><p begin="50t" end="100t">x</p></body></tt>`, "ttml")[0];
    // No timing parameters: a tick is a second.
    expect(ticks("")).toMatchObject({ start: 50, end: 100 });
    // A frame rate: a tick is a sub-frame of it.
    expect(ticks(' ttp:frameRate="25" ttp:subFrameRate="2"')).toMatchObject({ start: 1, end: 2 });
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

describe("caption tracks: languages, kinds, transcripts and export (#201)", () => {
  const cues: CaptionCue[] = [
    { start: 0.5, end: 3.25, text: "[Strings swell]" },
    { start: 6, end: 9.5, text: "ENDLESS HALL RECORDS\nPRESENTS" },
    { start: 20.04, end: 24, text: "Café & bar, 5 < 6 > 4" },
    { start: 3600, end: 3602.001, text: "Fin de l’été" },
  ];

  it("writes each format so it reads back the same", () => {
    for (const format of captionFormats) {
      const text = writeCaptions(cues, format, "fr-CA");
      expect(captionFormatOf("whatever.txt", text)).toBe(format);
      const back = parseCaptions(text, format);
      // SubRip has no escapes: what looks like a tag there (`< 6 >`) is read as one.
      expect(back.map((c) => c.text)).toEqual(
        cues.map((c) =>
          format === "srt" && c.text === "Café & bar, 5 < 6 > 4" ? "Café & bar, 5  4" : c.text,
        ),
      );
      back.forEach((c, i) => {
        expect(c.start).toBeCloseTo(cues[i]?.start ?? -1, 3);
        expect(c.end).toBeCloseTo(cues[i]?.end ?? -1, 3);
      });
      if (format !== "srt") expect(captionLanguageOf("x", text, format)).toBe("fr-CA");
    }
  });

  it("writes SubRip, WebVTT and TTML as players expect them", () => {
    const two = cues.slice(1, 3);
    expect(writeCaptions(two, "srt")).toBe(
      "1\r\n00:00:06,000 --> 00:00:09,500\r\nENDLESS HALL RECORDS\r\nPRESENTS\r\n\r\n" +
        "2\r\n00:00:20,040 --> 00:00:24,000\r\nCafé & bar, 5 < 6 > 4\r\n",
    );
    expect(writeCaptions(two, "vtt")).toBe(
      "WEBVTT\n\n00:00:06.000 --> 00:00:09.500\nENDLESS HALL RECORDS\nPRESENTS\n\n" +
        "00:00:20.040 --> 00:00:24.000\nCafé &amp; bar, 5 &lt; 6 &gt; 4\n",
    );
    expect(writeCaptions(two, "ttml", "en")).toContain(
      '<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">',
    );
    expect(writeCaptions(two, "ttml")).toContain(
      '<p begin="00:00:06.000" end="00:00:09.500">ENDLESS HALL RECORDS<br/>PRESENTS</p>',
    );
    // A blank line would end a cue early, so none is written inside one.
    expect(writeCaptions([{ start: 1, end: 2, text: "One\n\nTwo" }], "vtt")).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\nTwo\n",
    );
  });

  it("names an exported track as players look for it beside its video", () => {
    const at = { language: "en", kind: "captions" as const };
    expect(captionFileName("Opening titles - Cut 3.mov", at, "srt")).toBe(
      "Opening titles - Cut 3.en.sdh.srt",
    );
    expect(captionFileName("Joplin Rags.wav", { language: null, kind: "subtitles" }, "ttml")).toBe(
      "Joplin Rags.ttml",
    );
    expect(captionFileName(".mov", { language: "fr", kind: "subtitles" }, "vtt")).toBe(
      "Captions.fr.vtt",
    );
  });

  it("finds the language a file says it is in, and what it is for", () => {
    expect(captionLanguageOf("titles.srt", "WEBVTT\nLanguage: EN-gb\n\n", "vtt")).toBe("en-GB");
    expect(captionLanguageOf("titles.vtt", "WEBVTT\n\n00:01.000 --> 00:02.000\nx", "vtt")).toBe(
      null,
    );
    expect(captionLanguageOf("t.ttml", `<?xml version="1.0"?><tt xml:lang='de'>`, "ttml")).toBe(
      "de",
    );
    expect(captionLanguageOf("Titles.fr_CA.srt", "1\n", "srt")).toBe("fr-CA");
    expect(captionLanguageOf("Titles.en.sdh.srt", "1\n", "srt")).toBe("en");
    expect(captionLanguageOf("Opening titles - Cut 3.srt", "1\n", "srt")).toBeNull();
    expect(captionLanguageOf("Cut.3.final.srt", "1\n", "srt")).toBeNull();
    expect(captionKindOf("Titles.en.SDH.srt")).toBe("captions");
    expect(captionKindOf("Titles.en.srt")).toBeNull();
  });

  it("reads and names languages", () => {
    expect(canonicalLanguage("EN-gb")).toBe("en-GB");
    expect(canonicalLanguage("zh-hant")).toBe("zh-Hant");
    expect(canonicalLanguage("english")).toBeNull();
    expect(canonicalLanguage("")).toBeNull();
    expect(captionLanguage.parse(" fr-ca ")).toBe("fr-CA");
    expect(captionLanguage.safeParse("not a tag").success).toBe(false);
    expect(defaultCaptionLabel("en", "subtitles")).toBe("English");
    expect(defaultCaptionLabel("fr-CA", "captions")).toBe("Canadian French (SDH)");
    expect(defaultCaptionLabel(null, "captions")).toBe("Captions (SDH)");
    expect(defaultCaptionLabel(null, "subtitles")).toBe("Subtitles");
    for (const tag of commonCaptionLanguages) {
      expect(canonicalLanguage(tag)).toBe(tag);
      expect(languageName(tag)).toBeTruthy();
    }
  });

  it("follows playback through a transcript, overlaps and gaps included", () => {
    expect(activeCue(cues, 0)).toBe(-1);
    expect(activeCue(cues, 0.5)).toBe(0);
    expect(activeCue(cues, 4)).toBe(-1);
    expect(activeCue(cues, 9.49)).toBe(1);
    expect(activeCue(cues, 9.5)).toBe(-1);
    expect(activeCue(cues, 3601)).toBe(3);
    expect(activeCue([], 1)).toBe(-1);
    const long: CaptionCue[] = [
      { start: 0, end: 100, text: "Long" },
      { start: 10, end: 12, text: "Short" },
    ];
    expect(activeCue(long, 11)).toBe(1);
    expect(activeCue(long, 13)).toBe(0);
  });

  it("searches a transcript whatever the case, accents and line breaks", () => {
    expect(searchCues(cues, "records presents")).toEqual([1]);
    expect(searchCues(cues, "  CAFE ")).toEqual([2]);
    expect(searchCues(cues, "ete")).toEqual([3]);
    expect(searchCues(cues, "swell")).toEqual([0]);
    expect(searchCues(cues, "   ")).toEqual([]);
    expect(searchCues(cues, "nowhere")).toEqual([]);
  });

  it("marks where a search matches, in the original text", () => {
    const text = "ENDLESS HALL RECORDS\nPRESENTS";
    const marked = (t: string, q: string) => matchRanges(t, q).map(([a, b]) => t.slice(a, b));
    expect(marked(text, "records presents")).toEqual(["RECORDS\nPRESENTS"]);
    expect(marked("Fin de l’été, été", "ete")).toEqual(["été", "été"]);
    expect(marked("Two  spaces", "two spaces")).toEqual(["Two  spaces"]);
    expect(marked("ﬁne", "x")).toEqual([]);
    expect(matchRanges(text, "")).toEqual([]);
  });
});
