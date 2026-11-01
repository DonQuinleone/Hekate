import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "..", "..");
const ui = join(src, "components", "ui");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return path === ui ? [] : sources(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("the component set", () => {
  // Every form control comes from components/ui, so each looks and behaves the same
  // everywhere and changes in one place (docs/brand.md, Components).
  it("is the only place a screen gets a form control from", () => {
    const outside = sources(src).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /<(input|select|textarea)\b/.test(line) ? [`${relative(src, path)}:${i + 1}`] : [],
        ),
    );
    expect(outside).toEqual([]);
  });

  // Monospace is for code people read or edit as code, and nothing else (docs/brand.md, Type):
  // keys, addresses and times are the one face with tabular figures.
  it("keeps monospace to the code views brand.md names", () => {
    const code = new Set([
      "components/ui/code-editor.tsx", // the workflow's YAML
      "components/inspect.tsx", // Debug's JSON and stack traces
      "components/exports.tsx", // an export's text, as the programme reads it
      "components/sso.tsx", // a certificate in PEM
    ]);
    const outside = sources(src).flatMap((path) =>
      code.has(relative(src, path)) || path.endsWith(".test.tsx")
        ? []
        : readFileSync(path, "utf8")
            .split("\n")
            .flatMap((line, i) =>
              /\bfont-mono\b/.test(line) ? [`${relative(src, path)}:${i + 1}`] : [],
            ),
    );
    expect(outside).toEqual([]);
  });
});
