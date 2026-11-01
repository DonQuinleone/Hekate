import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "~/lib/queries";
import { failureText, isRefusal, referenceOf } from "./states";

const src = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".tsx") && !path.endsWith("states.tsx") ? [path] : [];
  });
}

/**
 * The queries a function reads, by the name its error goes by: `const { data, error } =
 * useQuery(…)`, `error: loadError`, or the whole result (`const log = useInfiniteQuery(…)`).
 */
function queryErrors(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(
    /const \{([^}]*)\}\s*=\s*use(?:Infinite)?Query\(|const (\w+)\s*=\s*use(?:Infinite)?Query\(/g,
  )) {
    if (m[2]) names.push(`${m[2]}.error`);
    const renamed = m[1]?.match(/\berror\s*:\s*(\w+)/);
    if (renamed?.[1]) names.push(renamed[1]);
    else if (m[1] && /\berror\b/.test(m[1])) names.push("error");
  }
  return names;
}

describe("loading, failed and refused (#545)", () => {
  // A place that is loading shows its shape, and one that could not load says what failed
  // and how to try again, through components/ui/states, never a bare word or the raw error.
  it("are never a bare word or a query's raw error message", () => {
    const found: string[] = [];
    for (const path of sources(src)) {
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (/>\s*Loading(\s*[.…]*)?\s*</.test(line) || /^\s*Loading\s*$/.test(line))
          found.push(`${relative(src, path)}:${i + 1} bare Loading`);
      });
      // Each function on its own: the error it reads from a query is not shown raw.
      for (const fn of text.split(/\n(?=(?:export )?function |const \w+ = \()/)) {
        const start = text.indexOf(fn);
        for (const name of queryErrors(fn)) {
          const raw = new RegExp(`\\{${name.replace(".", "\\.")}\\??\\.message\\}`);
          const at = fn.split("\n").findIndex((l) => raw.test(l));
          if (at >= 0) {
            const line = text.slice(0, start).split("\n").length + at;
            found.push(`${relative(src, path)}:${line} raw ${name}.message`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("tell a refusal from a failure, and keep the reference apart from the words", () => {
    const missing = new ApiError("Track not found", "not_found");
    const broken = new ApiError(
      "Something went wrong. Quote HK-7F3A-2C to support.",
      "internal",
      "HK-7F3A-2C",
    );
    const refused = new ApiError("That version is still being prepared", "conflict");
    expect(isRefusal(missing)).toBe(true);
    expect(isRefusal(new ApiError("No", "forbidden"))).toBe(true);
    expect(isRefusal(broken)).toBe(false);
    expect(referenceOf(broken)).toBe("HK-7F3A-2C");
    expect(failureText(broken)).not.toContain("HK-");
    // The server's own words, where it said why.
    expect(failureText(refused)).toBe("That version is still being prepared");
    // No answer at all: the network, not the server.
    expect(failureText(new TypeError("Failed to fetch"))).toMatch(/could not reach the server/);
  });
});
