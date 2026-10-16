import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { keyOf, QrCode } from "./second-factor";

const uri = "otpauth://totp/Hekate:producer%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Hekate";

describe("second factor", () => {
  it("shows the key in groups of four, for typing by hand", () => {
    expect(keyOf(uri)).toBe("JBSW Y3DP EHPK 3PXP");
  });

  it("draws the setup link as a QR code", () => {
    const { getByRole } = render(<QrCode value={uri} label="QR code" />);
    const svg = getByRole("img", { name: "QR code" });
    expect(svg.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  });
});
