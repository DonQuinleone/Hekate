import { createWriteStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { MetadataCorrections } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { waveBytes } from "../../../../packages/shared/src/fixtures/wave.ts";
import { probe, run } from "./ffmpeg.ts";
import { waveData } from "./forensic-audio.ts";
import {
  bextBody,
  carriesCorrections,
  correctedWave,
  infoBody,
  ixmlText,
  retagArgs,
} from "./metadata-write.ts";
import { withWorkspace } from "./workspace.ts";

const corrected = (fields: Record<string, string>): MetadataCorrections =>
  Object.fromEntries(Object.entries(fields).map(([k, value]) => [k, { value, read: null }]));

async function written(
  path: string,
  out: string,
  corrections: MetadataCorrections,
  samples?: { path: string; offset: number; size: number },
) {
  const pieces = await correctedWave(path, corrections, samples);
  if (!pieces) throw new Error("not a wave file");
  await pipeline(Readable.from(pieces), createWriteStream(out));
  return out;
}

const fixes = corrected({
  description: "Maple Leaf Rag, V3 dry",
  originator: "Endless Hall Records",
  timeReference: String(10 * 3600 * 48_000),
  scene: "14",
  note: "Ines & Tomas <after the break>",
  title: "Maple Leaf Rag",
  isrc: "GB-ABC-26-00001",
});

describe("corrected metadata as a recording leaves (decision 260)", () => {
  it("writes bext fields into their slots and keeps the rest of the chunk", () => {
    const original = Buffer.alloc(640);
    original.write("Old", 0, "latin1");
    original.writeUInt16LE(2, 346);
    original.write("A=PCM,F=48000,W=24,M=stereo", 602, "latin1");
    const body = bextBody(original, corrected({ description: "Café", originator: "" }));
    // One byte a character, in Latin-1.
    expect(body.subarray(0, 4).toString("latin1")).toBe("Café");
    expect(body[4]).toBe(0);
    expect(body.subarray(256, 288).every((b) => b === 0)).toBe(true);
    expect(body.readUInt16LE(346)).toBe(2);
    expect(body.length).toBe(640);
    expect(body.subarray(602, 629).toString("latin1")).toBe("A=PCM,F=48000,W=24,M=stereo");
    // None in the file: a new one of version 1.
    expect(bextBody(null, {}).readUInt16LE(346)).toBe(1);
  });

  it("replaces iXML elements where they are and adds the rest, escaped", () => {
    const xml = '<?xml version="1.0"?><BWFXML><SCENE>12</SCENE><TAKE>3</TAKE></BWFXML>';
    expect(ixmlText(xml, corrected({ scene: "14", note: "a & b" }))).toBe(
      '<?xml version="1.0"?><BWFXML><SCENE>14</SCENE><TAKE>3</TAKE><NOTE>a &amp; b</NOTE></BWFXML>',
    );
    expect(ixmlText("<BWFXML>", corrected({ scene: "1" }))).toBeNull();
    expect(ixmlText(null, corrected({ tape: "A01" }))).toContain("<TAPE>A01</TAPE></BWFXML>");
  });

  it("replaces, removes and adds RIFF INFO tags, keeping the others", () => {
    const entry = (id: string, text: string) => {
      const body = Buffer.from(`${text}\0`);
      const head = Buffer.alloc(8);
      head.write(id, 0, "latin1");
      head.writeUInt32LE(body.length, 4);
      return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
    };
    const original = Buffer.concat([
      Buffer.from("INFO"),
      entry("INAM", "Old title"),
      entry("ISFT", "Recorder 2"),
      entry("ICOP", "2025"),
    ]);
    const body = infoBody(original, corrected({ title: "Maple Leaf Rag", copyright: "", isrc: "GBABC2600001" }));
    const text = body.toString("latin1");
    expect(text.startsWith("INFO")).toBe(true);
    expect(text).toContain("INAM");
    expect(text).toContain("Maple Leaf Rag");
    expect(text).toContain("Recorder 2");
    expect(text).not.toContain("ICOP");
    expect(text).toContain("ISRCGBABC2600001".slice(0, 4));
  });

  it("gives a wave file corrected bext, iXML and tags that ffprobe and Hekate read back, its audio untouched", async () => {
    await withWorkspace(undefined, async (dir) => {
      const input = join(dir, "take.wav");
      await writeFile(
        input,
        waveBytes({
          channels: 2,
          seconds: 0.5,
          description: "Maple Leaf Rag, V2 dry",
          day: "2026-10-14",
          ixml: { scene: "12", take: "3", rate: "25/1" },
        }),
      );
      const out = await written(input, join(dir, "out.wav"), fixes);
      const info = await probe(out);
      expect(info.audio?.channels).toBe(2);
      expect(info.metadata?.bext).toMatchObject({
        description: "Maple Leaf Rag, V3 dry",
        originator: "Endless Hall Records",
        originationDate: "2026-10-14",
        timeReference: 10 * 3600 * 48_000,
      });
      expect(info.metadata?.ixml).toMatchObject({
        scene: "14",
        take: "3",
        note: "Ines & Tomas <after the break>",
        timecodeRate: "25/1",
      });
      expect(info.metadata?.tags).toMatchObject({ title: "Maple Leaf Rag", isrc: "GB-ABC-26-00001" });
      // The samples are the original's, byte for byte, and the RIFF size is the file's.
      const [a, b] = [await waveData(input), await waveData(out)];
      if (!a || !b) throw new Error("no data");
      const [x, y] = [await readFile(input), await readFile(out)];
      expect(y.subarray(b.offset, b.offset + b.size).equals(x.subarray(a.offset, a.offset + a.size))).toBe(true);
      expect(y.readUInt32LE(4)).toBe((await stat(out)).size - 8);
    });
  });

  it("adds what a bare wave file lacks before its audio, and rewrites iXML kept after it in place", async () => {
    await withWorkspace(undefined, async (dir) => {
      const bare = join(dir, "bare.wav");
      await writeFile(bare, waveBytes({ seconds: 0.1 }));
      const info = await probe(await written(bare, join(dir, "bare-out.wav"), fixes));
      expect(info.metadata?.bext?.originator).toBe("Endless Hall Records");
      expect(info.metadata?.ixml?.scene).toBe("14");
      expect(info.metadata?.tags.title).toBe("Maple Leaf Rag");

      const last = join(dir, "last.wav");
      await writeFile(last, waveBytes({ seconds: 0.1, ixmlLast: true, ixml: { scene: "12" } }));
      const out = await written(last, join(dir, "last-out.wav"), corrected({ scene: "14" }));
      const bytes = (await readFile(out)).toString("latin1");
      // One iXML, after the audio, as it was.
      expect(bytes.split("iXML").length).toBe(2);
      expect(bytes.indexOf("iXML")).toBeGreaterThan(bytes.indexOf("data"));
      expect((await probe(out)).metadata?.ixml?.scene).toBe("14");
    });
  });

  it("keeps an RF64 file's sizes right in its ds64 chunk", async () => {
    await withWorkspace(undefined, async (dir) => {
      const input = join(dir, "rf64.wav");
      await run("ffmpeg", [
        ...["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2"],
        ...["-c:a", "pcm_s24le", "-rf64", "always", "-y", input],
      ]);
      const out = await written(input, join(dir, "rf64-out.wav"), fixes);
      const bytes = await readFile(out);
      expect(bytes.subarray(0, 4).toString("latin1")).toBe("RF64");
      expect(Number(bytes.readBigUInt64LE(20))).toBe(bytes.length - 8);
      const info = await probe(out);
      expect(info.metadata?.bext?.description).toBe("Maple Leaf Rag, V3 dry");
      expect(info.duration).toBeCloseTo(0.2, 2);
    });
  });

  it("sends a marked download's samples in the original's chunks", async () => {
    await withWorkspace(undefined, async (dir) => {
      const input = join(dir, "take.wav");
      await writeFile(input, waveBytes({ seconds: 0.1, description: "x" }));
      const data = await waveData(input);
      if (!data) throw new Error("no data");
      const marked = join(dir, "marked.raw");
      await writeFile(marked, Buffer.alloc(data.size, 7));
      const out = await written(input, join(dir, "out.wav"), fixes, {
        path: marked,
        offset: 0,
        size: data.size,
      });
      const sent = await waveData(out);
      if (!sent) throw new Error("no data");
      const bytes = await readFile(out);
      expect(bytes.subarray(sent.offset, sent.offset + sent.size).every((b) => b === 7)).toBe(true);
      // Samples of another size are not spliced.
      expect(await correctedWave(input, fixes, { path: marked, offset: 0, size: 2 })).toBeNull();
    });
  });

  it("writes FLAC and MP3 tags with ffmpeg, copying the sound as it is", async () => {
    await withWorkspace(undefined, async (dir) => {
      for (const muxer of ["flac", "mp3"] as const) {
        const input = join(dir, `in.${muxer}`);
        await run("ffmpeg", [
          ...["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5"],
          ...["-metadata", "title=Old title", "-metadata", "artist=Endless Hall Records"],
          ...["-metadata", "copyright=2025", "-y", input],
        ]);
        const output = join(dir, `out.${muxer}`);
        await run(
          "ffmpeg",
          retagArgs(
            input,
            output,
            muxer,
            corrected({ title: "Maple Leaf Rag", isrc: "GBABC2600001", copyright: "", albumArtist: "Joplin Rags" }),
          ),
        );
        const info = await probe(output);
        expect(info.metadata?.tags).toEqual({
          title: "Maple Leaf Rag",
          artist: "Endless Hall Records",
          albumArtist: "Joplin Rags",
          isrc: "GBABC2600001",
        });
        expect(info.audio?.codec).toBe(muxer);
      }
    });
  });

  it("says whether a download carries anything of a file's corrections", () => {
    expect(carriesCorrections("wave", corrected({ scene: "1" }))).toBe(true);
    expect(carriesCorrections("flac", corrected({ scene: "1" }))).toBe(false);
    expect(carriesCorrections("flac", corrected({ title: "x" }))).toBe(true);
    expect(carriesCorrections("wave", null)).toBe(false);
    expect(carriesCorrections(null, corrected({ title: "x" }))).toBe(false);
  });
});
