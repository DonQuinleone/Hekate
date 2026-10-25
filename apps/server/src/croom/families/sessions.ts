import { aliases, crud, type Family, or } from "../family.ts";
import type { CrSession } from "../model.ts";
import { dateOf } from "./values.ts";

/**
 * Sessions (provisional, decision 242): `add_session`, `update_session`, `remove_session`, with
 * `name`, `date`, `venue_id` and `notes`.
 */
const session = crud<CrSession>(
  "session",
  (m) => m.sessions,
  (id) => ({ id, name: "", date: null, venueId: null, notes: "" }),
  (f, base, ctx) => {
    const date = f.strOrNull("date", "day", "recorded_on");
    return {
      ...base,
      name: or(f.str("name", "title", "label"), base.name),
      date: date === undefined ? base.date : dateOf(date, ctx),
      venueId: or(f.id("venue_id", "venue"), base.venueId),
      notes: or(f.str("notes", "note"), base.notes),
    };
  },
);

export const sessions: Family = {
  name: "sessions",
  nouns: aliases(["session", "recording_session"], session),
};
