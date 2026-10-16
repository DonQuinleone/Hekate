// Writes docs/configuration.md from the settings schema.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configurationReference } from "../src/config-reference.ts";

writeFileSync(
  join(import.meta.dirname, "../../../docs/configuration.md"),
  configurationReference(),
);
console.log("docs/configuration.md written");
