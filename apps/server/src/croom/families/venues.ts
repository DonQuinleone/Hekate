import { absent, type Family, removeFrom } from "../family.ts";

/**
 * Venues (decision 242): `add_venue` carries nothing, and `update_venue` then writes the whole
 * entry: `id`, `name` and `address` (its lines). `delete_venue` removes one by `id`.
 */
export const venues: Family = {
  name: "venues",
  events: {
    add_venue(ctx) {
      const id = ctx.nextId();
      ctx.model.venues.set(id, { id, name: "", address: "" });
    },
    update_venue(ctx, f) {
      const id = f.id("id");
      const next = { name: f.str("name"), address: f.str("address") };
      const held = id ? ctx.model.venues.get(id) : undefined;
      if (!held) return absent(ctx, "a venue");
      Object.assign(held, next);
    },
    delete_venue(ctx, f) {
      removeFrom(ctx, f, ctx.model.venues, "a venue");
    },
  },
};
