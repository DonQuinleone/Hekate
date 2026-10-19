import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseAdm,
  parseBext,
  parseChna,
  parseIxml,
  readWaveChunks,
  speakerRole,
  tagsOf,
} from "./metadata.ts";
import { withWorkspace } from "./workspace.ts";

/** A chunk: its id, its size and its body, padded to an even length. */
const chunk = (id: string, body: Buffer, size = body.length) => {
  const header = Buffer.alloc(8);
  header.write(id, 0, "latin1");
  header.writeUInt32LE(size, 4);
  return Buffer.concat([header, body, Buffer.alloc(body.length % 2)]);
};

/** A wave file of the given form holding these chunks. */
const wave = (chunks: Buffer[], form = "RIFF") => {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write(form, 0, "latin1");
  head.writeUInt32LE(form === "RIFF" ? body.length + 4 : 0xffffffff, 4);
  head.write("WAVE", 8, "latin1");
  return Buffer.concat([head, body]);
};

/** A bext body as EBU Tech 3285 lays it out. */
const bextBody = (fields: { description?: string; originator?: string; history?: string }) => {
  const body = Buffer.alloc(602);
  body.write(fields.description ?? "", 0, "latin1");
  body.write(fields.originator ?? "", 256, "latin1");
  body.write("EHR-001", 288, "latin1");
  body.write("2026-10-14", 320, "latin1");
  body.write("09:58:00", 330, "latin1");
  // Ten hours at 48 kHz, past what 32 bits can hold at a high rate: low word, then high.
  const reference = 10 * 3600 * 48_000;
  body.writeUInt32LE(reference % 2 ** 32, 338);
  body.writeUInt32LE(Math.floor(reference / 2 ** 32), 342);
  return Buffer.concat([body, Buffer.from(fields.history ?? "", "latin1")]);
};

const fmt = chunk("fmt ", Buffer.alloc(16));

/** A chna body listing these tracks (index, track format), as an ADM master lays it out. */
/** chna entries: each track, its track format and its pack (a bed's or an object's by default). */
const chnaBody = (tracks: ([number, string] | [number, string, string])[]) => {
  const body = Buffer.alloc(4 + 40 * tracks.length);
  body.writeUInt16LE(tracks.length, 0);
  body.writeUInt16LE(tracks.length, 2);
  tracks.forEach(([index, trackRef, packRef], i) => {
    const at = 4 + 40 * i;
    body.writeUInt16LE(index, at);
    body.write(`ATU_${String(i + 1).padStart(8, "0")}`, at + 2, "latin1");
    body.write(trackRef, at + 14, "latin1");
    const pack = packRef ?? (trackRef.startsWith("AT_0003") ? "AP_00031001" : "AP_00010017");
    body.write(pack, at + 28, "latin1");
  });
  return body;
};

/** A 7.1.4 bed by the common definitions (ITU-R BS.2094), then two objects. */
const atmosTracks: [number, string][] = [
  ...[
    "0001",
    "0002",
    "0003",
    "0004",
    "000a",
    "000b",
    "001c",
    "001d",
    "000d",
    "000f",
    "0010",
    "0012",
  ].map((id, i): [number, string] => [i + 1, `AT_0001${id}_01`]),
  [13, "AT_00031001_01"],
  [14, "AT_00031002_01"],
];

const axml = Buffer.from(
  `<ebuCoreMain><coreMetadata><format><audioFormatExtended>
  <audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Maple Leaf Rag &amp; Bethena" start="00:00:00.00000">
  </audioProgramme>
  <audioChannelFormat audioChannelFormatID="AC_00011001" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_L</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011002" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_R</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011003" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_C</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011004" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_LFE</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011005" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_Ls</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011006" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_Rs</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011007" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_Ltm</speakerLabel></audioBlockFormat></audioChannelFormat>
  <audioChannelFormat audioChannelFormatID="AC_00011008" typeDefinition="DirectSpeakers"><audioBlockFormat><speakerLabel>RC_Rtm</speakerLabel></audioBlockFormat></audioChannelFormat>
  </audioFormatExtended></format></coreMetadata></ebuCoreMain>`,
);

describe("what a recording says about itself (#41)", () => {
  it("reads bext's fields as written", () => {
    expect(
      parseBext(
        bextBody({
          description: "Maple Leaf Rag, V2 dry",
          originator: "Endless Hall Records",
          history: "A=PCM,F=96000,W=24,M=stereo\r\nA=PCM,F=48000,W=24,M=stereo\r\n",
        }),
      ),
    ).toEqual({
      description: "Maple Leaf Rag, V2 dry",
      originator: "Endless Hall Records",
      originatorReference: "EHR-001",
      originationDate: "2026-10-14",
      originationTime: "09:58:00",
      timeReference: 1_728_000_000,
      codingHistory: "A=PCM,F=96000,W=24,M=stereo\r\nA=PCM,F=48000,W=24,M=stereo",
    });
    // Too short to be bext at all.
    expect(parseBext(Buffer.alloc(100))).toBeUndefined();
    // Empty fields are left out; a time reference of zero is midnight, and kept.
    expect(parseBext(Buffer.alloc(602))).toEqual({ timeReference: 0 });
  });

  it("reads the iXML fields an editor wants, whatever else is there", () => {
    const xml =
      "<?xml version='1.0'?><BWFXML><PROJECT>Joplin Rags</PROJECT><SCENE>12</SCENE>" +
      "<TAKE>3</TAKE><TAPE>Day 2</TAPE><NOTE>Piano &amp; room</NOTE>" +
      "<SPEED><TIMECODE_RATE>25/1</TIMECODE_RATE></SPEED><TRACK_LIST /></BWFXML>";
    expect(parseIxml(Buffer.from(xml), 1200)).toEqual({
      bytes: 1200,
      project: "Joplin Rags",
      scene: "12",
      take: "3",
      tape: "Day 2",
      note: "Piano & room",
      timecodeRate: "25/1",
    });
    // An element left open is not read.
    expect(parseIxml(Buffer.from("<SCENE>12"), 9)).toEqual({ bytes: 9 });
  });

  it("finds bext and iXML in a wave file, before or after the audio", async () => {
    await withWorkspace(undefined, async (dir) => {
      const path = join(dir, "take.wav");
      await writeFile(
        path,
        wave([
          fmt,
          chunk("bext", bextBody({ originator: "Endless Hall Records" })),
          chunk("data", Buffer.alloc(301)),
          chunk("iXML", Buffer.from("<BWFXML><SCENE>12</SCENE></BWFXML>")),
        ]),
      );
      expect(await readWaveChunks(path)).toMatchObject({
        bext: { originator: "Endless Hall Records" },
        ixml: { bytes: 34, scene: "12" },
      });
    });
  });

  it("follows RF64's real data size to the chunks after the audio", async () => {
    await withWorkspace(undefined, async (dir) => {
      const path = join(dir, "long.wav");
      const ds64 = Buffer.alloc(28);
      ds64.writeBigUInt64LE(0n, 0);
      ds64.writeBigUInt64LE(64n, 8);
      await writeFile(
        path,
        wave(
          [
            chunk("ds64", ds64),
            fmt,
            chunk("data", Buffer.alloc(64), 0xffffffff),
            chunk("bext", bextBody({ description: "Opening titles" })),
          ],
          "RF64",
        ),
      );
      expect((await readWaveChunks(path)).bext?.description).toBe("Opening titles");
    });
  });

  it("reads an ADM master's bed, objects and programme (#74)", async () => {
    await withWorkspace(undefined, async (dir) => {
      const path = join(dir, "atmos.wav");
      await writeFile(
        path,
        wave([
          fmt,
          chunk("chna", chnaBody(atmosTracks)),
          chunk("data", Buffer.alloc(64)),
          chunk("axml", axml),
          chunk("dbmd", Buffer.alloc(16)),
        ]),
      );
      expect((await readWaveChunks(path)).adm).toEqual({
        bytes: axml.length,
        programme: "Maple Leaf Rag & Bethena",
        bed: 12,
        layout: "7.1.4",
        objects: 2,
        lfe: [3],
        dolby: true,
      });
      // A wave file without chna is no ADM master: read, and found to have none.
      const plain = join(dir, "plain.wav");
      await writeFile(plain, wave([fmt, chunk("data", Buffer.alloc(8))]));
      expect((await readWaveChunks(plain)).adm).toBeNull();
    });
  });

  it("names a bed from the speaker labels a renderer gives its own channels (#74)", () => {
    const tracks = (list: [number, string][]) =>
      list.map(([index, trackRef]) => ({ index, trackRef }));
    const custom = Array.from({ length: 8 }, (_, i): [number, string] => [
      i + 1,
      `AT_0001100${i + 1}_01`,
    ]);
    expect(parseAdm(tracks(custom), axml, axml.length, false)).toMatchObject({
      bed: 8,
      layout: "5.1.2",
      objects: 0,
      lfe: [3],
      dolby: false,
    });
    // A channel the axml does not describe leaves the bed unnamed, never misnamed.
    const unknown = parseAdm(tracks([...custom, [9, "AT_00011009_01"]]), axml, axml.length, false);
    expect(unknown).toMatchObject({ bed: 9 });
    expect(unknown.layout).toBeUndefined();
    // An entry for track 0 is unused; a track listed twice counts once.
    expect(
      parseChna(
        chnaBody([
          [0, "AT_00010001_01"],
          [1, "AT_00010001_01"],
        ]),
      ),
    ).toEqual([{ index: 1, trackRef: "AT_00010001_01", packRef: "AP_00010017" }]);
    const twice: [number, string][] = [
      [1, "AT_00031001_01"],
      [1, "AT_00031001_01"],
    ];
    expect(parseAdm(tracks(twice), undefined, 0, false)).toMatchObject({ bed: 0, objects: 1 });
  });

  it("tells an object by its pack, as the EBU ADM Renderer's masters have them (#74)", () => {
    // A track format's type digits are its format (0001, PCM): only the pack says "object".
    const object = parseChna(chnaBody([[1, "AT_00011001_01", "AP_00031001"]]));
    expect(object).toEqual([{ index: 1, trackRef: "AT_00011001_01", packRef: "AP_00031001" }]);
    expect(parseAdm(object, undefined, 0, false)).toMatchObject({ bed: 0, objects: 1 });
  });

  it("tells LFE and height speakers from the rest, by ITU's labels and Dolby's", () => {
    expect(speakerRole("urn:itu:bs:2051:0:speaker:LFE1")).toBe("lfe");
    expect(speakerRole("RC_LFE")).toBe("lfe");
    expect(speakerRole("urn:itu:bs:2051:0:speaker:U+030")).toBe("height");
    expect(speakerRole("T+000")).toBe("height");
    expect(speakerRole("RC_Rtr")).toBe("height");
    expect(speakerRole("RC_Lts")).toBe("height");
    expect(speakerRole("M+030")).toBe("main");
    expect(speakerRole("RC_Ls")).toBe("main");
  });

  it("gives up quietly on what is not a wave file, or stops making sense", async () => {
    await withWorkspace(undefined, async (dir) => {
      const flac = join(dir, "tone.flac");
      await writeFile(flac, Buffer.from("fLaC and the rest"));
      expect(await readWaveChunks(flac)).toEqual({});
      // A chunk claiming more than the file holds ends the walk with what was found.
      const broken = join(dir, "broken.wav");
      await writeFile(
        broken,
        wave([
          chunk("bext", bextBody({ originator: "Endless Hall Records" })),
          chunk("junk", Buffer.alloc(4), 0x7fffffff),
          chunk("iXML", Buffer.from("<SCENE>1</SCENE>")),
        ]),
      );
      expect(await readWaveChunks(broken)).toEqual({
        bext: expect.objectContaining({ originator: "Endless Hall Records" }),
        adm: null,
      });
    });
  });

  it("takes the common tags by their names in each container, the container's first", () => {
    expect(
      tagsOf(
        { TITLE: "Maple Leaf Rag", tsrc: "GBEHR2600001", "Album Artist": "Endless Hall Records" },
        { title: "Not this one", composer: "  ", genre: "Ragtime" },
      ),
    ).toEqual({
      title: "Maple Leaf Rag",
      isrc: "GBEHR2600001",
      albumArtist: "Endless Hall Records",
      genre: "Ragtime",
    });
    expect(tagsOf(undefined)).toEqual({});
  });
});
