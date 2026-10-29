import { beforeEach, describe, expect, it } from "vitest";
import {
  actionFor,
  byName,
  defaultChoice,
  describePlan,
  isAudio,
  planUpload,
  rememberChoice,
  sharedTrackName,
  trackNameFrom,
} from "./upload-plan";

const file = (name: string, key = name) => ({ key, name });
const maple = { id: "t1", name: "Maple Leaf Rag", versions: 3 };

describe("what uploaded audio becomes (#485)", () => {
  it("knows audio by its type, and by its name where the browser does not say", () => {
    expect(isAudio({ name: "take 7", type: "audio/wav" })).toBe(true);
    expect(isAudio({ name: "Maple Leaf Rag.flac", type: "" })).toBe(true);
    expect(isAudio({ name: "Maple Leaf Rag - Score.pdf", type: "application/pdf" })).toBe(false);
    expect(isAudio({ name: "titles.mov" })).toBe(false);
  });

  it("names a track from a file: extension off, separators tidied", () => {
    expect(trackNameFrom("Maple Leaf Rag.wav")).toBe("Maple Leaf Rag");
    expect(trackNameFrom("maple_leaf_rag.flac")).toBe("maple leaf rag");
    expect(trackNameFrom("maple-leaf-rag  final.aif")).toBe("maple leaf rag final");
    expect(trackNameFrom("Maple Leaf Rag - Dry mix.wav")).toBe("Maple Leaf Rag - Dry mix");
    expect(trackNameFrom("_.wav")).toBe("Untitled");
    expect(trackNameFrom(`${"a".repeat(250)}.wav`)).toHaveLength(200);
  });

  it("names one track for several files from what their names share", () => {
    expect(sharedTrackName(["Maple Leaf Rag - V1 mix.wav", "Maple Leaf Rag - V2 mix.wav"])).toBe(
      "Maple Leaf Rag",
    );
    expect(sharedTrackName(["Solace_take1.wav", "Solace_take2.wav"])).toBe("Solace");
    // Nothing shared worth keeping: the first file's name.
    expect(sharedTrackName(["Solace.wav", "The Entertainer.wav"])).toBe("Solace");
    expect(sharedTrackName(["Solace.wav"])).toBe("Solace");
  });

  it("orders files naturally, so V2 comes before V10", () => {
    expect(
      byName([file("Rag V10.wav"), file("Rag V2.wav"), file("Rag V1.wav")]).map((f) => f.name),
    ).toEqual(["Rag V1.wav", "Rag V2.wav", "Rag V10.wav"]);
  });

  it("makes one track per file, each named from its file unless renamed", () => {
    const plan = planUpload([file("Solace.wav", "a"), file("the_entertainer.wav", "b")], "track", {
      grouping: "each",
      names: { b: "The Entertainer" },
    });
    expect(plan).toEqual({
      kind: "tracks",
      tracks: [
        { key: "a", name: "Solace" },
        { key: "b", name: "The Entertainer" },
      ],
    });
    expect(describePlan(plan, null)).toBe(
      "2 files become 2 tracks at the top of the project, each at version 1.",
    );
    expect(actionFor(plan)).toBe("Make 2 tracks");
    const one = planUpload([file("Solace.wav")], "track", { grouping: "one" });
    expect(one.kind).toBe("tracks");
    expect(describePlan(one, "Mixes")).toBe("The file becomes version 1 of a new track in Mixes.");
    expect(actionFor(one)).toBe("Make a track");
  });

  it("makes one track with a version per file, in name order", () => {
    const plan = planUpload(
      [file("Rag - V2.wav", "b"), file("Rag - V10.wav", "c"), file("Rag - V1.wav", "a")],
      "track",
      { grouping: "one" },
    );
    expect(plan).toEqual({
      kind: "one-track",
      name: "Rag",
      versions: [
        { key: "a", number: 1 },
        { key: "b", number: 2 },
        { key: "c", number: 3 },
      ],
    });
    expect(describePlan(plan, "Mixes")).toBe(
      "3 files become versions 1 to 3 of one track in Mixes, in name order.",
    );
    expect(actionFor(plan)).toBe("Make the track");
    // A name typed over the shared one.
    expect(
      planUpload([file("a.wav"), file("b.wav")], "track", {
        grouping: "one",
        names: { track: "  Solace " },
      }),
    ).toMatchObject({ kind: "one-track", name: "Solace" });
  });

  it("makes the next version of a track, the files its variations with one primary", () => {
    const plan = planUpload(
      [file("Maple Leaf Rag - Dry.wav", "d"), file("Maple Leaf Rag - Wet.wav", "w")],
      "version",
      { grouping: "each", track: maple, primary: "w" },
    );
    expect(plan).toEqual({
      kind: "version",
      track: maple,
      number: 4,
      variations: [
        { key: "d", name: "Dry", primary: false },
        { key: "w", name: "Wet", primary: true },
      ],
    });
    expect(describePlan(plan, "Mixes")).toBe(
      "2 files become the variations of version 4 of Maple Leaf Rag.",
    );
    expect(actionFor(plan)).toBe("Upload version 4");
    // Without a primary named, or one that was taken off the list, the first is primary.
    expect(
      planUpload([file("x.wav", "x")], "version", {
        grouping: "each",
        track: maple,
        primary: "gone",
      }),
    ).toMatchObject({ variations: [{ key: "x", primary: true }] });
    expect(
      describePlan(
        planUpload([file("x.wav", "x")], "version", { grouping: "each", track: maple }),
        "Mixes",
      ),
    ).toBe("The file becomes version 4 of Maple Leaf Rag.");
    // No track to go to: the files stay files.
    expect(planUpload([file("x.wav")], "version", { grouping: "each", track: null })).toEqual({
      kind: "files",
      count: 1,
    });
  });

  it("leaves files as they are, and counts the ones beside the audio", () => {
    const plan = planUpload([file("a.wav"), file("b.wav"), file("c.wav")], "file", {
      grouping: "each",
    });
    expect(plan).toEqual({ kind: "files", count: 3 });
    expect(describePlan(plan, "Mixes")).toBe("3 files are uploaded to Mixes as they are.");
    expect(actionFor(plan)).toBe("Upload 3 files");
    expect(actionFor(plan, 2)).toBe("Upload 5 files");
    expect(describePlan(planUpload([file("a.wav")], "file", { grouping: "each" }), null)).toBe(
      "The file is uploaded to the top of the project as it is.",
    );
    const tracks = planUpload([file("a.wav")], "track", { grouping: "each" });
    expect(describePlan(tracks, "Mixes", 1)).toBe(
      "The file becomes version 1 of a new track in Mixes, and the other file is uploaded as it is.",
    );
    expect(describePlan(tracks, "Mixes", 2)).toBe(
      "The file becomes version 1 of a new track in Mixes, and the 2 other files are uploaded as they are.",
    );
  });

  describe("the choice the dialog opens with", () => {
    beforeEach(() => localStorage.clear());
    const base = { projectId: "p1", droppedOnTrack: false, mayMakeTracks: true, hasTracks: true };

    it("is a new version of the track the files were dropped on", () => {
      rememberChoice("p1", "file");
      expect(defaultChoice({ ...base, droppedOnTrack: true })).toBe("version");
    });

    it("is what was chosen last time in this project, where it is still on offer", () => {
      rememberChoice("p1", "file");
      expect(defaultChoice(base)).toBe("file");
      rememberChoice("p1", "version");
      expect(defaultChoice(base)).toBe("version");
      expect(defaultChoice({ ...base, hasTracks: false })).toBe("track");
      rememberChoice("p1", "track");
      expect(defaultChoice({ ...base, mayMakeTracks: false })).toBe("version");
      // Another project's choice is not this one's.
      expect(defaultChoice({ ...base, projectId: "p2" })).toBe("track");
    });

    it("is a new track for those who may make one, else a version, else a file", () => {
      expect(defaultChoice(base)).toBe("track");
      expect(defaultChoice({ ...base, mayMakeTracks: false })).toBe("version");
      expect(defaultChoice({ ...base, mayMakeTracks: false, hasTracks: false })).toBe("file");
    });
  });
});
