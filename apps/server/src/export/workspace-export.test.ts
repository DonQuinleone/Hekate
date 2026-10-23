import { tenantTables } from "@hekate/db";
import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordTables, tablesLeftOut } from "./workspace-export.ts";

/** Column names that could hold a secret, or a way in. */
const secretish =
  /(hash|sealed|wrapped|secret|token|password|nonce|(^|_)iv$|(^|_)key$|config$|_url$)/;

/** Those that do not, and why. */
const notSecret = new Set([
  // The key on the keyboard that picks a score mark's category (#52).
  "score_mark_categories.key",
  // An invoice's PDF at the gateway, which the workspace's owners already read in Billing.
  "invoices.pdf_url",
  // Which API token made a call (#198): its id, name and kind, never the token.
  "api_requests.token_id",
  "api_requests.token_name",
  "api_requests.token_kind",
]);

describe("an export's records (#186)", () => {
  it("holds every tenant table but those left out, each read in pages", () => {
    const names = recordTables().map((t) => t.name);
    for (const table of tenantTables) {
      const name = getTableName(table);
      expect(names.includes(name) !== tablesLeftOut.has(name)).toBe(true);
    }
    for (const t of recordTables()) expect(t.columns).toContain(t.page);
  });

  it("leaves out every wrapped key, sealed secret and hash of a link or code", () => {
    const kept = recordTables().flatMap((t) => t.columns.map((c) => `${t.name}.${c}`));
    const doubtful = kept.filter((c) => secretish.test(c.split(".")[1] ?? ""));
    expect(doubtful.filter((c) => !notSecret.has(c))).toEqual([]);
    // Every table still says which workspace a row is of.
    for (const t of recordTables()) expect(t.columns).toContain("organisation_id");
    // And the tables left out exist.
    const all = new Set(tenantTables.map((t) => getTableName(t)));
    for (const name of tablesLeftOut) expect(all.has(name)).toBe(true);
  });
});
