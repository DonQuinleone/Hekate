import { describe, expect, it } from "vitest";
import {
  blindLetter,
  blindOrder,
  compareSources,
  gainLabel,
  levelGains,
  levelMatchable,
  needsResync,
  shiftLabel,
  sourceFor,
} from "./compare";
import type { Track, Variation } from "./queries";

const variation = (
  id: string,
  versionId: string,
  name: string,
  extra: Partial<Variation> = {},
): Variation => ({
  id,
  versionId,
  fileId: `file-${id}`,
  name,
  isPrimary: false,
  position: 0,
  fileName: `${name}.wav`,
  kind: "audio",
  streamStatus: "ready",
  subtitled: null,
  graded: null,
  video: null,
  ...extra,
});

const track: Track = {
  id: "t",
  projectId: "p",
  name: "Maple Leaf Rag",
  scoreFileId: null,
  folderId: null,
  position: 0,
  deliveryProfile: null,
  commentReferences: null,
  normalisation: null,
  createdAt: "",
  versions: [
    {
      id: "v1",
      number: 1,
      notes: null,
      createdByName: null,
      edlFileId: null,
      letThroughBy: null,
      createdAt: "",
      variations: [variation("a", "v1", "Mix", { isPrimary: true })],
    },
    {
      id: "v2",
      number: 2,
      notes: null,
      createdByName: null,
      edlFileId: null,
      letThroughBy: null,
      createdAt: "",
      variations: [
        variation("b", "v2", "Dry", { isPrimary: true, position: 0 }),
        variation("c", "v2", "Wet", { position: 1 }),
        variation("d", "v2", "Stems", { position: 2, streamStatus: "pending" }),
      ],
    },
    {
      id: "v3",
      number: 3,
      notes: null,
      createdByName: null,
      edlFileId: null,
      letThroughBy: null,
      createdAt: "",
      variations: [variation("e", "v3", "Dry", { isPrimary: true })],
    },
  ],
};

describe("comparison", () => {
  it("offers sibling variations, then other versions newest first, ready ones only", () => {
    expect(compareSources(track, "file-b").map((s) => s.label)).toEqual([
      "V2 · Wet",
      "V3 · Dry",
      "V1 · Mix",
    ]);
    expect(compareSources(track, "file-e").map((s) => s.label)).toEqual(["V2 · Dry", "V1 · Mix"]);
  });

  it("finds any ready variation as a source, but not one still being prepared", () => {
    expect(sourceFor(track, "file-c")).toEqual({
      fileId: "file-c",
      label: "V2 · Wet",
      versionNumber: 2,
    });
    expect(sourceFor(track, "file-d")).toBeUndefined();
    expect(sourceFor(track, "nowhere")).toBeUndefined();
  });

  it("turns louder sources down to the quietest", () => {
    const gains = levelGains([-14, -20, -20]);
    expect(gains[0]).toBeCloseTo(0.5012, 3);
    expect(gains[1]).toBe(1);
    expect(gains[2]).toBe(1);
    expect(levelMatchable([-14, -20])).toBe(true);
    expect(gainLabel(gains[0] ?? 1)).toBe("−6.0 dB");
    expect(gainLabel(1)).toBe("0 dB");
  });

  it("matches nothing until every source is measured", () => {
    expect(levelGains([-14, -20, null])).toEqual([1, 1, 1]);
    expect(levelMatchable([-14, -20, null])).toBe(false);
    expect(levelMatchable([-14, Number.NEGATIVE_INFINITY])).toBe(false);
    expect(levelMatchable([-14])).toBe(false);
  });

  it("shuffles which source sits behind each key when blind", () => {
    expect(blindOrder(3, () => 0.99)).toEqual([0, 1, 2]);
    expect(blindOrder(4, () => 0)).toEqual([1, 2, 3, 0]);
    expect([...blindOrder(4)].sort()).toEqual([0, 1, 2, 3]);
    expect(blindLetter(0)).toBe("A");
  });

  it("says which way a source is offset", () => {
    expect(shiftLabel(-1.5)).toBe("1.5 s earlier");
    expect(shiftLabel(0.25)).toBe("0.3 s later");
  });

  it("resyncs a follower that has drifted", () => {
    expect(needsResync(10, 10.05)).toBe(false);
    expect(needsResync(10, 10.2)).toBe(true);
  });
});
