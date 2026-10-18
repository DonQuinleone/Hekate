import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBext, parseIxml, readWaveChunks, tagsOf } from "./metadata.ts";
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
