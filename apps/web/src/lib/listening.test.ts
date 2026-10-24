import { describe, expect, it } from "vitest";
import { clockOffset, createSender, followStep } from "./listening";

const at = "2026-10-14T21:00:00.000Z";
const t0 = Date.parse(at);
const local = { time: 10, paused: true, rate: 1, duration: 120 };

describe("followStep", () => {
  it("does nothing when the listener is already where the leader is", () => {
    expect(
      followStep(local, { playing: false, position: 10.2, rate: 1, at }, t0 + 5_000, false),
    ).toEqual({ seek: null, play: null, rate: null });
  });

  it("plays from where the leader is now, not where they were", () => {
    expect(
      followStep(local, { playing: true, position: 10, rate: 1, at }, t0 + 3_000, true),
    ).toEqual({ seek: 13, play: true, rate: null });
  });

  it("pauses with the leader, and takes their speed", () => {
    const playing = { ...local, paused: false };
    expect(followStep(playing, { playing: false, position: 10, rate: 0.5, at }, t0, false)).toEqual(
      { seek: null, play: false, rate: 0.5 },
    );
  });

  it("lets a small drift be, but moves a listener back once it grows", () => {
    const playing = { ...local, paused: false, time: 13.3 };
    const room = { playing: true, position: 10, rate: 1, at };
    expect(followStep(playing, room, t0 + 3_000, false).seek).toBeNull();
    expect(followStep({ ...playing, time: 14 }, room, t0 + 3_000, false).seek).toBe(13);
    // The leader's own seek lands exactly, small or not.
    expect(followStep(playing, room, t0 + 3_000, true).seek).toBe(13);
  });

  it("never seeks past the end of the listener's file", () => {
    expect(
      followStep(
        { ...local, duration: 40 },
        { playing: true, position: 39, rate: 1, at },
        t0 + 10_000,
        false,
      ).seek,
    ).toBe(40);
  });
});

describe("clockOffset", () => {
  it("is how far the server's clock is ahead of this browser's", () => {
    expect(clockOffset(at, t0 - 1_500)).toBe(1_500);
    expect(clockOffset(at, t0 + 200)).toBe(-200);
  });
});

describe("createSender", () => {
  it("sends the first at once, then only the latest of a burst, one at a time", async () => {
    const sent: number[] = [];
    let release = () => {};
    const send = createSender(async (n: number) => {
      sent.push(n);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    send(1);
    send(2);
    send(3);
    expect(sent).toEqual([1]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([1, 3]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    send(4);
    expect(sent).toEqual([1, 3, 4]);
    release();
  });

  it("carries on after a refusal", async () => {
    const sent: number[] = [];
    const send = createSender(async (n: number) => {
      sent.push(n);
      if (n === 1) throw new Error("refused");
    });
    send(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    send(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([1, 2]);
  });
});
