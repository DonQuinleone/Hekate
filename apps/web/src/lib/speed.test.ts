import { describe, expect, it } from "vitest";
import { followRate, holdRate } from "./speed";

const element = () => document.createElement("audio");

describe("playback speed (#15)", () => {
  it("plays at the speed chosen, pitch kept, and keeps it through a new source", () => {
    const audio = element();
    const stop = holdRate(audio, 0.75);
    expect(audio.playbackRate).toBe(0.75);
    expect(audio.defaultPlaybackRate).toBe(0.75);
    expect(audio.preservesPitch).toBe(true);
    // A new source resets the element's speed; the one chosen comes back with it.
    audio.playbackRate = 1;
    audio.defaultPlaybackRate = 1;
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(audio.playbackRate).toBe(0.75);
    stop();
    audio.playbackRate = 1;
    audio.dispatchEvent(new Event("loadedmetadata"));
    expect(audio.playbackRate).toBe(1);
  });

  it("keeps a compared version at the leader's speed as it changes", () => {
    const leader = element();
    const follower = element();
    leader.playbackRate = 1.25;
    const stop = followRate(leader, follower);
    expect(follower.playbackRate).toBe(1.25);
    expect(follower.preservesPitch).toBe(true);
    leader.playbackRate = 0.5;
    leader.dispatchEvent(new Event("ratechange"));
    expect(follower.playbackRate).toBe(0.5);
    // Through the follower's own new source as well.
    follower.playbackRate = 1;
    follower.dispatchEvent(new Event("loadedmetadata"));
    expect(follower.playbackRate).toBe(0.5);
    stop();
    leader.playbackRate = 1.5;
    leader.dispatchEvent(new Event("ratechange"));
    expect(follower.playbackRate).toBe(0.5);
  });
});
