import { SILENCE } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { formatLevel, historyPoints, meterFraction } from "./loudness";

describe("meter scale", () => {
  it("places levels between the floor and full scale", () => {
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(3)).toBe(1);
    expect(meterFraction(-30)).toBe(0.5);
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(SILENCE)).toBe(0);
    expect(meterFraction(null)).toBe(0);
  });

  it("writes levels with a true minus sign, and silence as minus infinity", () => {
    expect(formatLevel(-14.04)).toBe("−14.0");
    expect(formatLevel(-0.04)).toBe("0.0");
    expect(formatLevel(1.25)).toBe("1.3");
    expect(formatLevel(SILENCE)).toBe("−∞");
    expect(formatLevel(null)).toBe("−∞");
  });
});

describe("loudness history", () => {
  it("keeps the loudest frame per pixel and breaks the line at silence", () => {
    const values = Float32Array.from([SILENCE, SILENCE, -30, -20, -10, -40]);
    const points = historyPoints(values, 3, 60);
    expect(points[0]).toBeNull();
    expect(points[1]?.x).toBeCloseTo(1.5);
    expect(points[1]?.y).toBeCloseTo(20);
    expect(points[2]?.x).toBeCloseTo(3);
    expect(points[2]?.y).toBeCloseTo(10);
  });
});
