import { aliases, crud, type Family, or } from "../family.ts";
import type { CrCategory } from "../model.ts";

/**
 * Categories of score issue (provisional, decision 242): `add_category` and its update and
 * removal, with `name`, `colour` (or `color`) and `key`. They become the project's score mark
 * categories.
 */
const category = crud<CrCategory>(
  "category",
  (m) => m.categories,
  (id) => ({ id, name: "", colour: null, key: null }),
  (f, base) => ({
    ...base,
    name: or(f.str("name", "title", "label"), base.name),
    colour: or(f.strOrNull("colour", "color"), base.colour),
    key: or(f.strOrNull("key", "shortcut", "hotkey"), base.key),
  }),
);

export const categories: Family = {
  name: "categories",
  nouns: aliases(["category", "issue_category", "annotation_category"], category),
};
