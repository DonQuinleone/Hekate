import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PeoplePicker, type Person } from "./people-picker";

const people: Person[] = [
  { key: "member:u1", name: "Anna Berg", hint: "Producer", kind: "member" },
  { key: "member:u2", name: "Ben Osei", hint: "Engineer", kind: "member" },
  { key: "group:g1", name: "Soloists", hint: "3", kind: "group" },
  { key: "guest:mira@example.com", name: "Mira", hint: "Conductor", kind: "guest" },
];

function Harness({ onChange }: { onChange?: (keys: string[]) => void }) {
  const [chosen, setChosen] = useState<Person[]>([]);
  return (
    <PeoplePicker
      label="Who"
      people={people}
      chosen={chosen}
      onChange={(next) => {
        setChosen(next);
        onChange?.(next.map((p) => p.key));
      }}
    />
  );
}

describe("PeoplePicker (#489)", () => {
  afterEach(cleanup);
  it("offers everyone on a click, not on focus alone, narrows as you type, and takes the pick with Enter", () => {
    const keys: string[][] = [];
    const view = render(<Harness onChange={(k) => keys.push(k)} />);
    const field = view.getByRole("combobox", { name: "Who" });
    // Focus alone (the sheet opens on it) offers nothing: a list would cover the fields below.
    fireEvent.focus(field);
    expect(view.queryAllByRole("option")).toHaveLength(0);
    fireEvent.click(field);
    expect(view.getAllByRole("option")).toHaveLength(4);
    fireEvent.change(field, { target: { value: "sol" } });
    expect(view.getAllByRole("option").map((o) => o.textContent)).toEqual(["Soloists3"]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(keys.at(-1)).toEqual(["group:g1"]);
    expect(view.getByRole("button", { name: "Remove Soloists" })).toBeTruthy();
    // Taken, so no longer offered.
    fireEvent.click(field);
    expect(view.getAllByRole("option").map((o) => o.textContent)).not.toContain("Soloists3");
  });

  it("offers an unknown address as a new guest, and no known one twice", () => {
    const keys: string[][] = [];
    const view = render(<Harness onChange={(k) => keys.push(k)} />);
    const field = view.getByRole("combobox", { name: "Who" });
    fireEvent.change(field, { target: { value: "mira@example.com" } });
    expect(view.getAllByRole("option").map((o) => o.textContent)).toEqual(["MiraConductor"]);
    fireEvent.change(field, { target: { value: "new.one@example.com" } });
    expect(view.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "new.one@example.comNew guest",
    ]);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(keys.at(-1)).toEqual(["guest:new.one@example.com"]);
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("opens on ArrowDown, moves with the arrows and lets the last one go with Backspace", () => {
    const keys: string[][] = [];
    const view = render(<Harness onChange={(k) => keys.push(k)} />);
    const field = view.getByRole("combobox", { name: "Who" });
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toMatch(/-0$/);
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(field.getAttribute("aria-activedescendant")).toMatch(/-1$/);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(keys.at(-1)).toEqual(["member:u2"]);
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(keys.at(-1)).toEqual([]);
  });
});
