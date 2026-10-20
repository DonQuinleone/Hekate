import { describe, expect, it } from "vitest";
import { beatsDue, TEMPO_MAX, TEMPO_MIN, tempoOf } from "./reference-audio";

describe("tempoOf", () => {
  it("keeps a typed tempo whole and within what a metronome plays", () => {
    expect(tempoOf(88)).toBe(88);
    expect(tempoOf(92.6)).toBe(93);
    expect(tempoOf(4)).toBe(TEMPO_MIN);
    expect(tempoOf(1000)).toBe(TEMPO_MAX);
  });

  it("takes no tempo from no number", () => {
    expect(tempoOf(Number.NaN)).toBeNull();
    expect(tempoOf(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("beatsDue", () => {
  it("schedules the beats inside the window and says where the next falls", () => {
    // 120 a minute is a beat every half second.
    expect(beatsDue(1, 120, 0.9, 2.2)).toEqual({ times: [1, 1.5, 2], next: 2.5 });
  });

  it("schedules nothing until the next beat is near", () => {
    expect(beatsDue(3, 60, 2.8, 2.9)).toEqual({ times: [], next: 3 });
  });

  it("skips the beats a late wake missed, keeping the rest on the beat", () => {
    // Due at 1, 1.5, 2 and 2.5; the scheduler woke at 2.3.
    expect(beatsDue(1, 120, 2.3, 2.4)).toEqual({ times: [], next: 2.5 });
    expect(beatsDue(1, 120, 2.3, 2.6)).toEqual({ times: [2.5], next: 3 });
  });

  it("carries on from where the last window stopped, without drift", () => {
    let next = 0;
    const heard: number[] = [];
    for (let now = 0; now < 4; now += 0.025) {
      const due = beatsDue(next, 90, now, now + 0.1);
      heard.push(...due.times);
      next = due.next;
    }
    expect(heard).toHaveLength(7);
    expect(heard.at(-1)).toBeCloseTo(4, 9);
  });
});
