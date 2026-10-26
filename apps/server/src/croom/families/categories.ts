import type { Family } from "../family.ts";

/**
 * Categories of score mark (decision 242): `add_category` with `label`, `color` (packed as ImGui
 * packs a colour, red in the lowest byte) and `keybind` (the key that places one). ControlRoom
 * adds six to every new project (Red, Orange, Yellow, Green, Blue and Pink, on Q W E A S D) and
 * has no event that changes or removes one.
 */
export const categories: Family = {
  name: "categories",
  events: {
    add_category(ctx, f) {
      const id = ctx.nextId();
      ctx.model.categories.set(id, {
        id,
        label: f.str("label"),
        colour: f.num("color", 0xffffffff),
        keybind: f.str("keybind"),
      });
    },
  },
};
