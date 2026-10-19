import { describe, expect, it } from "vitest";
import { readerOf, waveBytes } from "./fixtures/wave.ts";
import {
  chooseMix,
  compileNamePattern,
  type ImportSource,
  importable,
  isoDay,
  leaveOut,
  markImported,
  mixOf,
  nameLikeness,
  placeTakes,
  proposeTakeImport,
  renameSession,
  sameSpan,
  takeHeld,
} from "./take-import.ts";
import { readWaveHeader } from "./wave.ts";

const tracks = [
  { id: "maple", name: "Maple Leaf Rag" },
  { id: "solace", name: "Solace" },
  { id: "entertainer", name: "The Entertainer" },
];

let n = 0;
async function source(
  name: string,
  options: Parameters<typeof waveBytes>[0] = {},
  folder = "",
): Promise<ImportSource> {
  const bytes = waveBytes(options);
  n += 1;
  return {
    key: `f${n}`,
    name,
    folder,
    size: bytes.length,
    header: name.endsWith(".wav") ? await readWaveHeader(readerOf(bytes), bytes.length) : null,
  };
}

/** A recorder's take: one mono file per microphone and a stereo mix, all from one moment. */
const take = (number: string, start: number, scene: string, day = "2026-10-14") =>
  Promise.all(
    ["Mix", "Spot", "Tree"].map((mic) =>
      source(`T${number}_${mic}.wav`, {
        channels: mic === "Mix" ? 2 : 1,
        seconds: 0.5,
        day,
        start,
        ixml: { scene, take: number, tape: "Day 3", tracks: mic === "Mix" ? ["L", "R"] : [mic] },
      }),
    ),
  );

describe("file-name patterns (#45)", () => {
  it("reads the take, the microphone and the timecode from a name", () => {
    const pattern = compileNamePattern("T{take} {mic}.wav");
    expect(pattern?.exec("T27_Spot vln.WAV")?.groups).toMatchObject({
      take: "27",
      mic: "Spot vln",
    });
    expect(
      compileNamePattern("{session}-{tc}-T{take}")?.exec("Day3-101402-T12A.wav")?.groups,
    ).toMatchObject({ session: "Day3", tc: "101402", take: "12A" });
    expect(compileNamePattern("*T{take}")?.exec("Hall A take T5.wav")?.groups?.take).toBe("5");
  });

  it("refuses a pattern naming nothing, something unknown, or a thing twice", () => {
    expect(compileNamePattern("")).toBeNull();
    expect(compileNamePattern("take.wav")).toBeNull();
    expect(compileNamePattern("{bar}.wav")).toBeNull();
    expect(compileNamePattern("{take}-{take}")).toBeNull();
    // Other characters are matched as written, never as pattern syntax.
    expect(compileNamePattern("(T{take})")?.test("(T3).wav")).toBe(true);
  });

  it("reads a day however a recorder writes it, and only a real one", () => {
    expect(isoDay("2026:10:14")).toBe("2026-10-14");
    expect(isoDay("2026/10/14")).toBe("2026-10-14");
    expect(isoDay("2026-02-30")).toBeNull();
    expect(isoDay(undefined)).toBeNull();
  });
});

describe("matching names to tracks (#45)", () => {
  it("is surest of the same name, then one held in the other, then words in common", () => {
    expect(nameLikeness("maple leaf rag", "Maple Leaf Rag")).toBe(1);
    expect(nameLikeness("Maple Leaf Rag, session 2", "Maple Leaf Rag")).toBe(0.9);
    expect(nameLikeness("Entertainer", "The Entertainer")).toBe(0.9);
    expect(nameLikeness("Solace, a Mexican serenade", "Solace")).toBe(0.9);
    expect(nameLikeness("Leaf Rag", "Maple Leaf Rag")).toBeGreaterThan(0.5);
    expect(nameLikeness("Room tone", "Maple Leaf Rag")).toBe(0);
  });
});

describe("the summed mix among a take's files (#45)", () => {
  const file = (name: string, channels: number, microphone: string | null = null) => ({
    key: name,
    name,
    microphone,
    channels,
    size: 1,
  });
  it("is the one named so, the one stereo file among mono ones, or the only file", () => {
    expect(mixOf([file("T1 Spot.wav", 1), file("T1 Mix.wav", 2)])).toBe("T1 Mix.wav");
    expect(mixOf([file("a.wav", 1, "Spot"), file("b.wav", 1, "LR sum")])).toBe("b.wav");
    expect(mixOf([file("a.wav", 1), file("b.wav", 2)])).toBe("b.wav");
    expect(mixOf([file("a.wav", 8)])).toBe("a.wav");
    // Two stereo pairs and nothing named: someone has to say.
    expect(mixOf([file("a.wav", 2), file("b.wav", 2)])).toBeNull();
  });
});

describe("files recorded together (#45)", () => {
  it("start within a second, or share at least half of the shorter's length", () => {
    // Microphones started together, or a few seconds apart and stopped at different times.
    expect(sameSpan({ start: 100, length: 60 }, { start: 100.5, length: null })).toBe(true);
    expect(sameSpan({ start: 100, length: 120 }, { start: 103, length: 118 })).toBe(true);
    expect(sameSpan({ start: 100, length: 120 }, { start: 140, length: 30 })).toBe(true);
    // One take after another, or a file with no length starting well apart.
    expect(sameSpan({ start: 100, length: 60 }, { start: 161, length: 60 })).toBe(false);
    expect(sameSpan({ start: 100, length: 60 }, { start: 150, length: 60 })).toBe(false);
    expect(sameSpan({ start: 100, length: null }, { start: 105, length: 60 })).toBe(false);
    expect(sameSpan({ start: null, length: 60 }, { start: 100, length: 60 })).toBe(false);
  });
});

describe("proposing the organisation of a day's files (#45)", () => {
  it("groups files into takes and takes into the day's session, matched to tracks", async () => {
    const files = [
      ...(await take("27", 36_842, "Maple Leaf Rag")),
      ...(await take("28", 37_180, "Maple Leaf Rag")),
      ...(await take("30", 50_520, "Solace")),
      await source("Room tone.wav", { channels: 2 }),
      await source("Notes.txt"),
    ];
    const proposal = proposeTakeImport(files, {
      tracks,
      dayName: (day) => `Day of ${day}`,
    });
    expect(proposal.sessions).toHaveLength(1);
    const [day] = proposal.sessions;
    expect(day).toMatchObject({ name: "Day of 2026-10-14", recordedOn: "2026-10-14" });
    expect(day?.takes.map((t) => [t.label, t.timecode, t.files.length, t.trackId])).toEqual([
      ["T27", "10:14:02", 3, "maple"],
      ["T28", "10:19:40", 3, "maple"],
      ["T30", "14:02:00", 3, "solace"],
    ]);
    const first = day?.takes[0];
    expect(first?.files.find((f) => f.key === first.mix)?.name).toBe("T27_Mix.wav");
    expect(first?.files.map((f) => f.microphone)).toEqual(["Mix", "Spot", "Tree"]);
    expect(first?.confidence).toBe(1);
    expect(first?.length).toBeCloseTo(0.5);
    expect(proposal.unplaced.map((u) => [u.name, u.reason])).toEqual([
      ["Notes.txt", "is not a recording"],
      ["Room tone.wav", "has no take number or timecode"],
    ]);
  });

  it("joins files without take numbers by their timecode, and reads names by the pattern", async () => {
    const files = [
      await source(
        "A_Mix.wav",
        { channels: 2, start: 100, seconds: 8, day: "2026-10-13" },
        "Day 2",
      ),
      await source("A_Spot.wav", { start: 100.4, day: "2026-10-13" }, "Day 2"),
      // Started a few seconds late, and stopped late: recorded with them all the same.
      await source("A_Tree.wav", { start: 103, seconds: 6, day: "2026-10-13" }, "Day 2"),
      await source("B_Mix.wav", { channels: 2, start: 400, day: "2026-10-13" }, "Day 2"),
      await source("Solace T4 Mix.wav", {}, "Day 4/Solace"),
    ];
    const proposal = proposeTakeImport(files, {
      tracks,
      pattern: "{track} T{take} {mic}",
      sessions: [{ id: "day-2", name: "Day 2", recordedOn: "2026-10-13" }],
    });
    const [day2, day4] = proposal.sessions;
    // Recorded the day an existing session was: added to it.
    expect(day2).toMatchObject({ sessionId: "day-2", name: "Day 2" });
    expect(day2?.takes.map((t) => [t.label, t.files.length, t.trackId])).toEqual([
      ["Take at 00:01:40", 3, null],
      ["Take at 00:06:40", 1, null],
    ]);
    // No day or tape: the folder names the session, and the name gives take and track.
    expect(day4).toMatchObject({ name: "Solace", sessionId: null });
    expect(day4?.takes.map((t) => [t.label, t.trackId, t.confidence])).toEqual([
      ["T4", "solace", 1],
    ]);
  });

  it("adds files that give no day to the session of their name, as an earlier import made it", async () => {
    const files = [await source("Solace T7 Mix.wav", {}, "Day 4/Solace")];
    const proposal = proposeTakeImport(files, {
      tracks,
      pattern: "{track} T{take} {mic}",
      sessions: [
        { id: "solace", name: "solace", recordedOn: null },
        { id: "day-2", name: "Day 2", recordedOn: "2026-10-13" },
      ],
    });
    expect(proposal.sessions[0]).toMatchObject({ sessionId: "solace", name: "solace" });
  });

  it("proposes the only track there is, less surely", async () => {
    const files = await take("1", 10, "Something else");
    const proposal = proposeTakeImport(files, { tracks: [{ id: "only", name: "Solace" }] });
    expect(proposal.sessions[0]?.takes[0]).toMatchObject({ trackId: "only", confidence: 0.5 });
    expect(proposal.sessions[0]?.takes[0]?.label).toBe("Something else T1");
  });

  it("is corrected by hand, and imports only what is placed, with a mix, and not left out", async () => {
    const files = [
      ...(await take("1", 10, "Maple Leaf Rag")),
      ...(await take("2", 400, "Unknown")),
      ...(await take("3", 800, "Solace")),
    ];
    let p = proposeTakeImport(files, { tracks });
    const [one, two, three] = p.sessions[0]?.takes ?? [];
    expect(takeHeld(two ?? ({} as never))).toBe("Choose a track");
    expect(importable(p)[0]?.takes.map((t) => t.label)).toEqual(["T1", "T3"]);

    p = placeTakes(p, new Set([two?.key ?? ""]), "entertainer");
    p = leaveOut(p, new Set([three?.key ?? ""]), true);
    const spot = one?.files.find((f) => f.microphone === "Spot");
    p = chooseMix(p, one?.key ?? "", spot?.key ?? "");
    // A file of another take is never a take's mix.
    p = chooseMix(p, one?.key ?? "", three?.files[0]?.key ?? "");
    p = renameSession(p, p.sessions[0]?.key ?? "", "Day 3");

    const plan = importable(p);
    expect(plan[0]?.name).toBe("Day 3");
    expect(plan[0]?.takes.map((t) => [t.label, t.trackId, t.chosen])).toEqual([
      ["T1", "maple", false],
      ["Unknown T2", "entertainer", true],
    ]);
    expect(plan[0]?.takes[0]?.mix).toBe(spot?.key);
    expect(takeHeld(p.sessions[0]?.takes[2] ?? ({} as never))).toBe("Left out");
  });

  it("skips the takes made already in their session, from the same file", async () => {
    const files = [
      ...(await take("5", 10, "Solace", "2026-10-13")),
      ...(await take("6", 400, "Solace", "2026-10-13")),
    ];
    const p = markImported(
      proposeTakeImport(files, {
        tracks,
        sessions: [{ id: "day-2", name: "Day 2", recordedOn: "2026-10-13" }],
      }),
      new Set(["day-2/T5_Mix.wav", "elsewhere/T6_Mix.wav"]),
    );
    expect(p.sessions[0]?.takes.map((t) => [t.label, takeHeld(t)])).toEqual([
      ["T5", "Already imported"],
      ["T6", null],
    ]);
  });
});
