import { defaultFileColumns, type FileColumnLayout } from "@hekate/shared";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ColumnsMenu, columnNames } from "./file-columns";

function Harness() {
  const [columns, setColumns] = useState<FileColumnLayout>(defaultFileColumns);
  return <ColumnsMenu columns={columns} names={columnNames} onChange={setColumns} />;
}

describe("ColumnsMenu", () => {
  it("shows each column's switch on once it is added", () => {
    const view = render(<Harness />);
    fireEvent.click(view.getByRole("button", { name: "Choose columns" }));
    fireEvent.click(view.getByRole("switch", { name: "Tags" }));
    fireEvent.click(view.getByRole("switch", { name: "Duration" }));
    for (const name of ["Status", "Tags", "Duration"]) {
      expect(view.getByRole("switch", { name }).getAttribute("aria-checked")).toBe("true");
    }
    expect(view.getByRole("switch", { name: "Size" }).getAttribute("aria-checked")).toBe("false");
  });
});
