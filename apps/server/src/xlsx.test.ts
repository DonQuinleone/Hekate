import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { columnOf, sheetNames, xlsxOf } from "./xlsx.ts";

const hasPython = spawnSync("python3", ["-c", "import zipfile"]).status === 0;

describe("spreadsheets", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-xlsx-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("names columns as a spreadsheet does", () => {
    expect([0, 25, 26, 51, 701, 702].map(columnOf)).toEqual(["A", "Z", "AA", "AZ", "ZZ", "AAA"]);
  });

  it("names sheets as a workbook allows them", () => {
    expect(sheetNames(["Stage box A", "Stage box A", "a/b:c", "", "x".repeat(40)])).toEqual([
      "Stage box A",
      "Stage box A (2)",
      "a b c",
      "Sheet 4",
      "x".repeat(31),
    ]);
    // No apostrophe at either end, nor a sheet left with nothing else.
    expect(sheetNames(["'Piano' box", "Ines' box'", "''"])).toEqual([
      "Piano' box",
      "Ines' box",
      "Sheet 3",
    ]);
  });

  it.runIf(hasPython || process.env.CI)(
    "writes a zip any reader opens, with each sheet in it",
    () => {
      const path = join(dir, "patch.xlsx");
      writeFileSync(
        path,
        xlsxOf([
          {
            name: "Stage box A",
            rows: [
              ["In", "Source", "Device"],
              [1, "Main L & R <pair>", "DPA 4006"],
            ],
          },
          { name: "Stage box B", rows: [["In", "Source"]] },
        ]),
      );
      const read = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import sys, zipfile",
            "z = zipfile.ZipFile(sys.argv[1])",
            "assert z.testzip() is None",
            "print(sorted(z.namelist()))",
            "print(z.read('xl/workbook.xml').decode())",
            "print(z.read('xl/worksheets/sheet1.xml').decode())",
          ].join("\n"),
          path,
        ],
        { encoding: "utf8" },
      );
      expect(read.status, read.stderr).toBe(0);
      expect(read.stdout).toContain("xl/worksheets/sheet2.xml");
      expect(read.stdout).toContain('<sheet name="Stage box B" sheetId="2" r:id="rId2"/>');
      expect(read.stdout).toContain('<c r="A2"><v>1</v></c>');
      expect(read.stdout).toContain("Main L &amp; R &lt;pair&gt;");
    },
  );
});
