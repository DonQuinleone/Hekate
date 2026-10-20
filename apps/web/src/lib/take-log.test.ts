import { describe, expect, it } from "vitest";
import {
  clock,
  keyTake,
  type LoggedTake,
  liveTake,
  logOrder,
  nextTrack,
  rolled,
  slotLeft,
  slotMoment,
  slotTime,
} from "./take-log";

const take = (number: number, over: Partial<LoggedTake> = {}): LoggedTake => ({
  id: `t${number}`,
  number,
  label: null,
  notes: null,
  rating: 0,
  starred: false,
  page: null,
  pageTo: null,
  sessionId: "s",
  lifecycle: "recorded",
  falseStarts: 0,
  timecodeIn: null,
  timecodeOut: null,
  wallIn: null,
  wallOut: null,
  barFrom: null,
  barTo: null,
  inPoint: null,
  outPoint: null,
  file: null,
  createdAt: `2026-10-14T14:${String(number).padStart(2, "0")}:00.000Z`,
  track: { id: "maple", name: "Maple Leaf Rag" },
  ...over,
});

describe("the take log's reckoning (#51)", () => {
  it("keeps takes in the order they were logged, whatever their numbers", () => {
    const rows = [take(12), take(3, { createdAt: "2026-10-14T15:00:00.000Z" }), take(7)];
    expect(logOrder(rows).map((t) => t.number)).toEqual([7, 12, 3]);
  });

  it("acts on the take rolling or armed, else the last logged", () => {
    const rows = [take(1), take(2, { lifecycle: "recording" }), take(3, { lifecycle: "aborted" })];
    expect(liveTake(rows)?.number).toBe(2);
    expect(keyTake(rows)?.number).toBe(2);
    expect(liveTake([take(1), take(2)])).toBeNull();
    expect(keyTake([take(1), take(2)])?.number).toBe(2);
    expect(keyTake([])).toBeNull();
  });

  it("times a take from the clock, so sleep loses nothing", () => {
    const start = Date.parse("2026-10-14T14:00:00Z");
    const rolling = { wallIn: "2026-10-14T14:00:00Z", wallOut: null };
    expect(rolled(rolling, start + 247_900)).toBe(247);
    expect(rolled({ ...rolling, wallOut: "2026-10-14T14:01:30Z" }, start + 999_000)).toBe(90);
    expect(rolled({ wallIn: null, wallOut: null }, start)).toBe(0);
  });

  it("counts the slot down to its end, and not past it", () => {
    const now = Date.parse("2026-10-14T15:12:00Z");
    expect(slotLeft({ slotEnd: "2026-10-14T16:00:00Z" }, now)).toBe(48 * 60);
    expect(slotLeft({ slotEnd: "2026-10-14T15:00:00Z" }, now)).toBe(0);
    expect(slotLeft({ slotEnd: null }, now)).toBeNull();
  });

  it("writes a clock as people read one", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(247)).toBe("4:07");
    expect(clock(3847)).toBe("1:04:07");
  });

  it("logs the next take of the track chosen, else the last take's, else the first", () => {
    const tracks = [{ id: "maple" }, { id: "trio" }];
    expect(nextTrack("trio", [take(1)], tracks)).toBe("trio");
    expect(nextTrack(null, [take(1)], tracks)).toBe("maple");
    expect(nextTrack("gone", [], tracks)).toBe("maple");
    expect(nextTrack(null, [], [])).toBeNull();
  });

  it("reads a slot typed as times on the session's day, and shows it back", () => {
    const start = slotMoment("2026-10-14", "14:00");
    expect(start).not.toBeNull();
    expect(slotTime(start)).toBe("14:00");
    expect(new Date(start ?? "").getDate()).toBe(14);
    // Without a day, today's.
    const today = new Date(2026, 9, 19, 9, 30);
    expect(new Date(slotMoment(null, "16:00", today) ?? "").getDate()).toBe(19);
    expect(slotMoment("2026-10-14", "")).toBeNull();
    expect(slotTime(null)).toBe("");
  });
});
