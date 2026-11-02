import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const src = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") && !path.endsWith(".test.tsx") ? [path] : [];
  });
}

/** The object literal around `at`: from its opening brace to the one that closes it. */
function objectAround(text: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = text[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Every menu item in the app: an object with a label and an `onSelect`, where it is written. */
function menuItems() {
  return sources(src).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/\blabel:\s/g)].flatMap((m) => {
      const item = objectAround(text, m.index);
      if (!item?.includes("onSelect:")) return [];
      // The label's words: each string it may be, whether written plainly or chosen.
      const from = item.indexOf("label:");
      const end = /,\s*(hint|icon|danger|checked|disabled|onSelect):/.exec(item.slice(from))?.index;
      const label = item.slice(from, from + (end ?? item.length));
      const words = [...label.matchAll(/"([^"]*)"|`([^`]*)`/g)].map((w) => w[1] ?? w[2] ?? "");
      const onSelect = item.slice(item.indexOf("onSelect:"));
      const line = text.slice(0, m.index).split("\n").length;
      return [{ where: `${relative(src, path)}:${line}`, item, words, onSelect }];
    });
  });
}

/**
 * What opens a dialog when chosen: a confirmation, or the state that shows one. Editing a
 * comment where it is (`setEditing(true)`) and naming a folder in the list are not dialogs.
 */
const opensDialog =
  /^onSelect:\s*\(\)\s*=>\s*(confirm\(|ask\w*\(|onEdit\(|set(Editing\((?!true)|(Dialog|Deleting|Moving|Renaming|Revoking|Granting|Asking|Exporting|Attaching|Suspending|Rotating|Retiring|Requesting|Sharing|Versioning|Laying|Cancelling|Reading|Ending|Picking)\())/;
/** What changes something at once. */
const actsAtOnce = /^onSelect:\s*\(\)\s*=>\s*\w+(\.\w+)*\.mutate\(/;

describe("menu items", () => {
  const items = menuItems();

  it("are found", () => {
    expect(items.length).toBeGreaterThan(100);
  });

  // docs/brand.md, Voice: an item that opens a dialog ends in an ellipsis; one that acts at
  // once does not.
  it("end in an ellipsis when they open a dialog, and only then", () => {
    const wrong = items.flatMap(({ where, words, onSelect }) => {
      const dotted = words.length > 0 && words.every((w) => w.endsWith("…"));
      if (opensDialog.test(onSelect) && !dotted) return [`${where} opens a dialog: ${words[0]}`];
      if (actsAtOnce.test(onSelect) && words.some((w) => w.endsWith("…")))
        return [`${where} acts at once: ${words[0]}`];
      return [];
    });
    expect(wrong).toEqual([]);
  });

  // Nothing is deleted by one click: a destructive item asks first.
  it("ask before anything destructive", () => {
    const wrong = items.flatMap(({ where, item, words, onSelect }) =>
      /\bdanger:\s*true/.test(item) && actsAtOnce.test(onSelect) ? [`${where}: ${words[0]}`] : [],
    );
    expect(wrong).toEqual([]);
  });
});
