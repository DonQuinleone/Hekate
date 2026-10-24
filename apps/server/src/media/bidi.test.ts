import { describe, expect, it } from "vitest";
import { hasRightToLeft, shapeArabic, visualOrder } from "./bidi.ts";

const every = () => true;

describe("right-to-left text for the PDFs", () => {
  it("leaves left-to-right text as it is", () => {
    expect(visualOrder("Joplin Rags · Take 3")).toBe("Joplin Rags · Take 3");
    expect(visualOrder("Дмитрий, 東京")).toBe("Дмитрий, 東京");
    expect(hasRightToLeft("Mira Solberg")).toBe(false);
  });

  it("draws a Hebrew line right to left, its numbers left to right", () => {
    expect(hasRightToLeft("שלום")).toBe(true);
    expect(visualOrder("שלום עולם")).toBe("םלוע םולש");
    expect(visualOrder("תיבה 12")).toBe("12 הבית");
    // In a Latin line, a Hebrew word turns round in its place; a number after it goes with it.
    expect(visualOrder("Take שלום now")).toBe("Take םולש now");
    expect(visualOrder("Take שלום 3")).toBe("Take 3 םולש");
  });

  it("mirrors brackets and keeps a mark after its letter", () => {
    expect(visualOrder("שלום (עולם)")).toBe("(םלוע) םולש");
    // Shin with its dot (U+05C1) stays one letter with its mark after it.
    expect(visualOrder("שׁב")).toBe("בשׁ");
  });

  it("joins Arabic letters into the forms they take beside each other", () => {
    // Seen: initial, lam-alef final, meem isolated (the ligature does not join onward).
    expect(shapeArabic("سلام", every)).toBe("ﺳﻼﻡ");
    // Beh: isolated alone; initial, medial and final in a row of three.
    expect(shapeArabic("ب", every)).toBe("ﺏ");
    expect(shapeArabic("ببب", every)).toBe("ﺑﺒﺐ");
    // A right-joining letter (dal) ends the joining: the beh after it starts again.
    expect(shapeArabic("بدب", every)).toBe("ﺑﺪﺏ");
    // Marks are skipped over when joining.
    expect(shapeArabic("بَب", every)).toBe("ﺑَﺐ");
  });

  it("keeps a plain letter where the font has no form for it, and other text as it is", () => {
    expect(shapeArabic("بب", () => false)).toBe("بب");
    expect(shapeArabic("Opening titles", every)).toBe("Opening titles");
  });

  it("puts Arabic in drawing order after joining it, Arabic-Indic digits left to right", () => {
    const shaped = shapeArabic("باب ١٢", every);
    expect(visualOrder(shaped)).toBe(`١٢ ${[...shaped.slice(0, 3)].reverse().join("")}`);
  });
});
