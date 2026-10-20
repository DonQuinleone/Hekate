import { describe, expect, it } from "vitest";
import { pdfString, widthOf, winAnsi } from "./helvetica.ts";

describe("Helvetica in WinAnsi", () => {
  it("keeps a Latin name readable where WinAnsi lacks its letters", () => {
    expect(winAnsi("Dvořák")).toBe("Dvorák");
    expect(winAnsi("Łódź, Sœur, Mira Solberg")).toBe("Lódz, Sœur, Mira Solberg");
    expect(winAnsi("Чайковский")).toBe("??????????");
    expect(pdfString("Dvořák (Op. 96)")).toBe("(Dvor\\341k \\(Op. 96\\))");
    expect(pdfString("Œ")).toBe("(\\214)");
  });

  it("measures by Adobe's metrics, bold wider than regular", () => {
    expect(widthOf("W", 10)).toBeCloseTo(9.44);
    expect(widthOf("i", 10)).toBeCloseTo(2.22);
    expect(widthOf("i", 10, true)).toBeCloseTo(2.78);
    expect(widthOf("é", 10)).toBeCloseTo(widthOf("e", 10));
    expect(widthOf("…", 10)).toBeCloseTo(10);
  });
});
