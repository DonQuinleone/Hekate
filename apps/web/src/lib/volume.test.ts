import { describe, expect, it } from "vitest";
import { clampVolume, stepVolume, volumeGain } from "./volume";

describe("clampVolume", () => {
  it("keeps a volume between silence and full, whole", () => {
    expect(clampVolume(42.4)).toBe(42);
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume(140)).toBe(100);
    expect(clampVolume("65")).toBe(65);
  });

  it("plays at full where nothing sensible was stored", () => {
    expect(clampVolume("loud")).toBe(100);
    expect(clampVolume(Number.NaN)).toBe(100);
    expect(clampVolume(null)).toBe(0);
  });
});

describe("stepVolume", () => {
  it("moves in steps of five, to the next multiple first", () => {
    expect(stepVolume(50, 1)).toBe(55);
    expect(stepVolume(50, -1)).toBe(45);
    expect(stepVolume(42, 1)).toBe(45);
    expect(stepVolume(42, -1)).toBe(40);
  });

  it("stops at the ends", () => {
    expect(stepVolume(98, 1)).toBe(100);
    expect(stepVolume(100, 1)).toBe(100);
    expect(stepVolume(3, -1)).toBe(0);
    expect(stepVolume(0, -1)).toBe(0);
  });
});

describe("volumeGain", () => {
  it("is the volume as a share of full", () => {
    expect(volumeGain(100)).toBe(1);
    expect(volumeGain(25)).toBe(0.25);
    expect(volumeGain(0)).toBe(0);
  });
});
