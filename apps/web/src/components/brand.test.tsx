import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Mark } from "./brand";
import { StatusPill } from "./ui/status";

describe("brand components", () => {
  it("draws the small cut of the mark below 24 px", () => {
    const { container } = render(<Mark size={16} />);
    expect(container.querySelector("rect")?.getAttribute("width")).toBe("3.6");
    expect(container.querySelector("circle")?.getAttribute("fill")).toBe("var(--hk-signal)");
  });

  it("keeps the point in ink when monochrome", () => {
    const { container } = render(<Mark size={32} mono />);
    expect(container.querySelector("circle")?.getAttribute("fill")).toBe("currentColor");
  });

  it("labels review states in words", () => {
    const { getByText } = render(<StatusPill state="changes_requested" />);
    expect(getByText("Changes requested")).toBeTruthy();
  });
});
