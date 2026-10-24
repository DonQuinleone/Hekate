import { describe, expect, it } from "vitest";
import {
  LEADER_GONE_MS,
  LISTENER_GONE_MS,
  LISTENING_MAX_POSITION,
  listeningStateInput,
  positionAt,
  roomOpen,
  stillThere,
} from "./listening.ts";

const at = "2026-10-14T21:00:00.000Z";
const t0 = Date.parse(at);

describe("positionAt", () => {
  it("holds a paused room where it was", () => {
    expect(positionAt({ playing: false, position: 42, rate: 1, at }, t0 + 10_000)).toBe(42);
  });

  it("plays on from where the leader was, at their speed", () => {
    expect(positionAt({ playing: true, position: 42, rate: 1, at }, t0 + 2_500)).toBe(44.5);
    expect(positionAt({ playing: true, position: 10, rate: 0.5, at }, t0 + 4_000)).toBe(12);
  });

  it("never runs backwards on a clock a little behind, nor past the longest position", () => {
    expect(positionAt({ playing: true, position: 5, rate: 1, at }, t0 - 1_000)).toBe(5);
    expect(
      positionAt({ playing: true, position: LISTENING_MAX_POSITION - 1, rate: 2, at }, t0 + 60_000),
    ).toBe(LISTENING_MAX_POSITION);
  });
});

describe("roomOpen", () => {
  const now = new Date(t0);
  it("is open while its leader is heard from", () => {
    expect(roomOpen({ endedAt: null, leaderSeenAt: new Date(t0 - 10_000) }, now)).toBe(true);
  });
  it("ends when ended, or when the leader has gone", () => {
    expect(roomOpen({ endedAt: new Date(t0 - 1), leaderSeenAt: now }, now)).toBe(false);
    expect(roomOpen({ endedAt: null, leaderSeenAt: new Date(t0 - LEADER_GONE_MS - 1) }, now)).toBe(
      false,
    );
    expect(roomOpen({ endedAt: null, leaderSeenAt: null }, now)).toBe(false);
  });
});

describe("stillThere", () => {
  it("lets a listener go once their page has been quiet too long", () => {
    const now = new Date(t0);
    expect(stillThere(new Date(t0 - LISTENER_GONE_MS), now)).toBe(true);
    expect(stillThere(new Date(t0 - LISTENER_GONE_MS - 1), now)).toBe(false);
  });
});

describe("listeningStateInput", () => {
  it("takes a file, whether it plays, a position and a speed", () => {
    const fileId = "019a0000-0000-7000-8000-000000000001";
    expect(listeningStateInput.parse({ fileId, playing: true, position: 3.5 })).toEqual({
      fileId,
      playing: true,
      position: 3.5,
      rate: 1,
    });
    expect(listeningStateInput.safeParse({ fileId, playing: true, position: -1 }).success).toBe(
      false,
    );
    expect(
      listeningStateInput.safeParse({ fileId, playing: true, position: 1, rate: 16 }).success,
    ).toBe(false);
    expect(listeningStateInput.safeParse({ fileId: "x", playing: true, position: 1 }).success).toBe(
      false,
    );
  });
});
