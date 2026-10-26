import type { Family, Handler } from "../family.ts";

/**
 * Saved views (decision 242): the desktop app's window layouts, `add_view` (`name`, `builder`,
 * `layout`, `builtin`), `set_active_view`, `update_view_layout`, `rename_view` and
 * `delete_view`. They describe ControlRoom's own windows, not the project, so each is read and
 * set aside, and counted in the report. `add_view` still draws its id from the counter, as it
 * does in ControlRoom, or every entry after it would be numbered wrongly.
 */
const reason = "The desktop app's own window layout, not part of the project";

const setAside: Handler = (ctx, f) => {
  f.skipAll();
  ctx.report.ignore(ctx.type, reason);
};

export const views: Family = {
  name: "views",
  events: {
    add_view(ctx, f) {
      ctx.nextId();
      setAside(ctx, f);
    },
    set_active_view: setAside,
    update_view_layout: setAside,
    rename_view: setAside,
    delete_view: setAside,
  },
};
