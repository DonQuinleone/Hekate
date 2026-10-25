import { aliases, crud, type Family, or } from "../family.ts";
import type { CrVenue } from "../model.ts";

/**
 * Venues (provisional, decision 242): `add_venue` with `name`, `address` (text, or a list of
 * lines) and `notes`.
 */
const venue = crud<CrVenue>(
  "venue",
  (m) => m.venues,
  (id) => ({ id, name: "", address: "", notes: "" }),
  (f, base) => {
    // An address as text, or as its lines.
    const written = f.raw("address", "address_lines", "location", "postal_address");
    const address =
      written === undefined || written === null
        ? undefined
        : Array.isArray(written)
          ? written.map(String).join("\n")
          : String(written);
    return {
      ...base,
      name: or(f.str("name", "title"), base.name),
      address: or(address, base.address),
      notes: or(f.str("notes", "note", "get_in"), base.notes),
    };
  },
);

export const venues: Family = {
  name: "venues",
  nouns: aliases(["venue", "location"], venue),
};
