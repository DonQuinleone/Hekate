import { eachOf } from "../fields.ts";
import { absent, type Family, removeFrom } from "../family.ts";
import { type CrPersonnelKind, moveTo, personnelKinds } from "../model.ts";

/**
 * Personnel (decision 242). `add_personnel` has only `kind` (artist, staff, ensemble or other;
 * any other word ControlRoom reads as artist), and `update_personnel` then writes the whole
 * entry but its kind: `id`, `name`, `role`, `rights` (the session agreement is signed), `cans`
 * (needs headphones), `forces_notes`, `sections` (each with `name`, `members`, each with `name`,
 * `div`, `rights` and `cans`, and `unnamed`, the head-count while no one is named) and, in older
 * files, `observers`, names of guests. `delete_personnel` removes one by `id`, and
 * `move_personnel` moves one to place `to` in the list.
 */
const kindOf = (value: string): CrPersonnelKind =>
  (personnelKinds as readonly string[]).includes(value) ? (value as CrPersonnelKind) : "artist";

export const personnel: Family = {
  name: "personnel",
  events: {
    add_personnel(ctx, f) {
      const id = ctx.nextId();
      ctx.model.personnel.set(id, {
        id,
        kind: kindOf(f.str("kind", "artist")),
        name: "",
        role: "",
        forcesNotes: "",
        rights: false,
        cans: false,
        sections: [],
        observers: [],
      });
    },
    update_personnel(ctx, f) {
      const id = f.id("id");
      // A person's kind is fixed when they are added.
      f.skip("kind");
      const next = {
        name: f.str("name"),
        role: f.str("role"),
        rights: f.bool("rights", false),
        cans: f.bool("cans", false),
        forcesNotes: f.str("forces_notes"),
        sections: eachOf(f.list("sections"), `${ctx.type}.sections`, ctx.report, (s) => ({
          name: s.str("name"),
          unnamed: Math.max(0, s.int("unnamed", 0)),
          members: eachOf(
            s.list("members"),
            `${ctx.type}.sections.members`,
            ctx.report,
            (m) => ({
              name: m.str("name"),
              divisi: m.str("div"),
              rights: m.bool("rights", false),
              cans: m.bool("cans", false),
            }),
          ),
        })),
        observers: (f.list("observers") ?? []).filter((o): o is string => typeof o === "string"),
      };
      const held = id ? ctx.model.personnel.get(id) : undefined;
      if (!held) return absent(ctx, "a person");
      Object.assign(held, next);
    },
    delete_personnel(ctx, f) {
      removeFrom(ctx, f, ctx.model.personnel, "a person");
    },
    move_personnel(ctx, f) {
      const id = f.id("id");
      const to = f.int("to", 0);
      if (!id || !ctx.model.personnel.has(id)) return absent(ctx, "a person");
      ctx.model.personnel = moveTo(ctx.model.personnel, id, to);
    },
  },
};
