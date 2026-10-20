import type { SessionDetail } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { fallingBack, memoryStore, type OutboxStore } from "./outbox-store";
import { baseOf, outcomeOf, type PendingWrite, rolledAt, withPending } from "./take-outbox";
import { uuidv7 } from "./uuidv7";

const session = {
  id: "s1",
  numbering: "continuous",
  tracks: [
    { id: "maple", name: "Maple Leaf Rag", scoreFileId: null },
    { id: "trio", name: "Trio", scoreFileId: null },
  ],
  takeRows: [
    {
      id: "t3",
      number: 3,
      notes: "Keeper into the trio",
      rating: 4,
      starred: false,
      lifecycle: "recorded",
      wallIn: "2026-10-14T14:00:00.000Z",
      wallOut: "2026-10-14T14:03:00.000Z",
      track: { id: "maple", name: "Maple Leaf Rag" },
    },
  ],
  nextNumbers: { maple: 4, trio: 4 },
} as unknown as SessionDetail;

const start = (takeId: string, at: string, number = 4): PendingWrite => ({
  kind: "start",
  sessionId: "s1",
  takeId,
  number,
  body: { trackId: "maple", lifecycle: "recording", id: takeId, at },
});

describe("withPending", () => {
  it("shows a take started offline at once, rolling since it started, and moves the numbers on", () => {
    const shown = withPending(session, [start("t4", "2026-10-14T14:10:00.000Z")]);
    expect(shown.takeRows.at(-1)).toMatchObject({
      id: "t4",
      number: 4,
      lifecycle: "recording",
      wallIn: "2026-10-14T14:10:00.000Z",
      track: { name: "Maple Leaf Rag" },
    });
    // Numbered continuously, every track's next number moves on.
    expect(shown.nextNumbers).toEqual({ maple: 5, trio: 5 });
  });

  it("lays changes over the takes, timing a stop as the server would", () => {
    const shown = withPending(session, [
      start("t4", "2026-10-14T14:10:00.000Z"),
      {
        kind: "change",
        sessionId: "s1",
        takeId: "t4",
        body: { lifecycle: "recorded", at: "2026-10-14T14:12:30.000Z" },
      },
      { kind: "change", sessionId: "s1", takeId: "t3", body: { rating: 5, at: "x" } },
    ]);
    expect(shown.takeRows.find((t) => t.id === "t4")).toMatchObject({
      lifecycle: "recorded",
      wallOut: "2026-10-14T14:12:30.000Z",
    });
    expect(shown.takeRows.find((t) => t.id === "t3")?.rating).toBe(5);
  });

  it("does not show a take twice once the server has it, nor another session's writes", () => {
    const served = {
      ...session,
      takeRows: [...session.takeRows, { ...session.takeRows[0], id: "t4" }],
    };
    expect(withPending(served as SessionDetail, [start("t4", "x")]).takeRows).toHaveLength(2);
    expect(withPending(session, [{ ...start("t9", "x"), sessionId: "other" }])).toBe(session);
  });
});

describe("baseOf", () => {
  it("sends what the log last saw of the fields it changes", () => {
    expect(baseOf(session.takeRows[0], { notes: "Lovely rubato", rating: 5 })).toEqual({
      notes: "Keeper into the trio",
      rating: 4,
    });
  });
});

describe("outcomeOf", () => {
  it("keeps what could not be sent, and lets go of what the server refused", () => {
    expect(outcomeOf("offline")).toBe("retry");
    expect(outcomeOf(503)).toBe("retry");
    expect(outcomeOf(401)).toBe("retry");
    expect(outcomeOf(409)).toBe("refused");
    expect(outcomeOf(422)).toBe("refused");
    expect(outcomeOf(201)).toBe("sent");
  });
});

describe("memoryStore", () => {
  it("keeps a session's writes in the order they were made, until each is sent", async () => {
    const store = memoryStore();
    const a = await store.add(start("a", "x"));
    await store.add({ ...start("b", "x"), sessionId: "other" });
    const c = await store.add(start("c", "x", 5));
    expect((await store.list("s1")).map((w) => w.takeId)).toEqual(["a", "c"]);
    await store.remove(a.seq ?? 0);
    expect((await store.list("s1")).map((w) => w.seq)).toEqual([c.seq]);
  });
});

describe("uuidv7", () => {
  it("makes version 7 ids that sort in the order they were made", () => {
    const ids = Array.from({ length: 50 }, () => uuidv7(1_792_000_000_000));
    for (const id of ids)
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe("rolledAt", () => {
  const armed = {
    ...session.takeRows[0],
    lifecycle: "armed",
    wallIn: null,
    wallOut: null,
  } as SessionDetail["takeRows"][number];
  it("sends the moment a take rolled or stopped, so a late send keeps the room's time", () => {
    expect(rolledAt(armed, { lifecycle: "recording" }, "T1")).toEqual({
      lifecycle: "recording",
      wallIn: "T1",
    });
    const rolling = { ...armed, lifecycle: "recording", wallIn: "T1" } as typeof armed;
    expect(rolledAt(rolling, { lifecycle: "recorded" }, "T2")).toEqual({
      lifecycle: "recorded",
      wallOut: "T2",
    });
    // Anything else, or a time already given, is left as it is.
    expect(rolledAt(rolling, { rating: 4 }, "T2")).toEqual({ rating: 4 });
    expect(rolledAt(rolling, { lifecycle: "aborted", wallOut: "T3" }, "T2")).toEqual({
      lifecycle: "aborted",
      wallOut: "T3",
    });
  });
});

describe("fallingBack", () => {
  it("keeps writing in memory once the browser's storage fails, and says it will not last", async () => {
    const broken: OutboxStore = {
      list: async () => {
        throw new Error("QuotaExceededError");
      },
      add: async () => {
        throw new Error("QuotaExceededError");
      },
      remove: async () => {
        throw new Error("QuotaExceededError");
      },
      durable: () => true,
    };
    const store = fallingBack(broken);
    expect(store.durable()).toBe(true);
    const kept = await store.add(start("a", "x"));
    expect(kept.seq).toBeDefined();
    expect(store.durable()).toBe(false);
    expect((await store.list("s1")).map((w) => w.takeId)).toEqual(["a"]);
  });
});
