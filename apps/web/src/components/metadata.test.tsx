import type { EmbeddedMetadata } from "@hekate/shared";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetadataForm } from "./metadata";

const metadata: EmbeddedMetadata = {
  bext: { originator: "Endless Hall Records", timeReference: 10 * 3600 * 48_000 },
  ixml: { bytes: 1200, scene: "14", timecodeRate: "25/1" },
  tags: { title: "Maple Leaf Rag" },
};

const form = (onSave = vi.fn(), onCancel = vi.fn()) => ({
  onSave,
  onCancel,
  view: render(
    <MetadataForm
      fields={["originator", "timeReference", "scene", "title", "isrc"]}
      metadata={metadata}
      corrections={{ scene: { value: "14", read: "12" } }}
      sampleRate={48_000}
      saving={false}
      error={null}
      onSave={onSave}
      onCancel={onCancel}
    />,
  ),
});

describe("the metadata editor (decision 260)", () => {
  afterEach(cleanup);

  it("sends only what changed, a timecode as samples since midnight", () => {
    const { view, onSave } = form();
    expect((view.getByLabelText(/^Time reference/) as HTMLInputElement).value).toBe("10:00:00:00");
    fireEvent.change(view.getByLabelText("ISRC"), { target: { value: "GB-ABC-26-00001" } });
    fireEvent.change(view.getByLabelText(/^Time reference/), { target: { value: "10:00:01:00" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      isrc: "GB-ABC-26-00001",
      timeReference: String((10 * 3600 + 1) * 48_000),
    });
  });

  it("says what the file says beside a correction, and restores it as the file has it", () => {
    const { view, onSave } = form();
    expect(view.getByText("In the file: 12")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Restore Scene as the file has it" }));
    expect((view.getByLabelText("Scene") as HTMLInputElement).value).toBe("12");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ scene: null });
  });

  it("refuses what a field cannot hold, in words, and leaves on Escape", () => {
    const { view, onSave, onCancel } = form();
    fireEvent.change(view.getByLabelText("ISRC"), { target: { value: "none" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(view.getByRole("alert").textContent).toMatch(/ISRC as GB-ABC-26-00001/);
    fireEvent.keyDown(view.getByLabelText(/^ISRC/), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
