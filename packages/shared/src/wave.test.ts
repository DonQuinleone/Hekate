import { describe, expect, it } from "vitest";
import { readerOf, waveBytes } from "./fixtures/wave.ts";
import { ixmlTrackNames, readWaveHeader, waveSeconds } from "./wave.ts";

const header = (bytes: Uint8Array) => readWaveHeader(readerOf(bytes), bytes.length);

describe("a wave file's header, read without its audio (#45)", () => {
  it("reads the format, the length, bext and iXML with its microphones", async () => {
    const bytes = waveBytes({
      channels: 2,
      seconds: 1.5,
      day: "2026-10-14",
      start: 36_842,
      ixml: { scene: "Maple Leaf Rag", take: "27", tape: "Day 3", tracks: ["Mix L", "Mix R"] },
    });
    const found = await header(bytes);
    expect(found).toMatchObject({
      channels: 2,
      sampleRate: 48_000,
      bitsPerSample: 24,
      bext: { originationDate: "2026-10-14", timeReference: 36_842 * 48_000 },
      ixml: { scene: "Maple Leaf Rag", take: "27", tape: "Day 3" },
      microphones: ["Mix L", "Mix R"],
    });
    expect(waveSeconds(found ?? {})).toBeCloseTo(1.5);
  });

  it("finds iXML written after the audio", async () => {
    const found = await header(waveBytes({ ixml: { take: "4" }, ixmlLast: true, seconds: 2 }));
    expect(found?.ixml?.take).toBe("4");
  });

  it("is null for anything that is not a wave file, and says nothing it cannot", async () => {
    expect(await header(new TextEncoder().encode("ID3 not a wave file at all"))).toBeNull();
    const bare = await header(waveBytes({}));
    expect(bare?.bext).toBeUndefined();
    expect(waveSeconds({ channels: 1 })).toBeNull();
  });

  it("names the tracks of an iXML track list, skipping a track without a name", () => {
    const xml =
      "<BWFXML><TRACK_LIST><TRACK><NAME>Spot vln</NAME></TRACK><TRACK><CHANNEL_INDEX>2" +
      "</CHANNEL_INDEX></TRACK><TRACK><NAME>Room &amp; tree</NAME></TRACK></TRACK_LIST></BWFXML>";
    expect(ixmlTrackNames(new TextEncoder().encode(xml))).toEqual(["Spot vln", "Room & tree"]);
    expect(ixmlTrackNames(new TextEncoder().encode("<BWFXML />"))).toEqual([]);
  });
});
