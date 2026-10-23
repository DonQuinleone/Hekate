// Writes docs/openapi.json, the public API's OpenAPI document, from the routes (#197). Refuses
// when the new document breaks what the committed one promised, unless run with --breaking
// (which a new API version needs: decision 224).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { breakingChanges } from "../src/openapi/compat.ts";
import { referenceDocument, referenceText } from "../src/openapi/reference.ts";

const target = join(import.meta.dirname, "../../../docs/openapi.json");
const committed = readCommitted();
if (committed) {
  const broken = breakingChanges(committed, referenceDocument());
  if (broken.length > 0 && !process.argv.includes("--breaking")) {
    console.error(
      `This would break what version 1 of the API promised:\n\n${broken.map((b) => `- ${b}`).join("\n")}\n\nKeep the old shape alongside the new, or, if the break is meant, it needs a new version (decision 224): run again with --breaking.`,
    );
    process.exit(1);
  }
}
writeFileSync(target, referenceText());

/** The committed document, or nothing on a first run. */
function readCommitted() {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
console.log("docs/openapi.json written");
