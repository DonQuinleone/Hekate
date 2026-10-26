import { absent, type Family, removeFrom } from "../family.ts";
import { idOf } from "../fields.ts";
import type { CrTodo } from "../model.ts";

/**
 * The session's to-do list (decision 242): `add_todo` with `text`; `toggle_todo` and
 * `delete_todo` by `id`; `reorder_todos` with `order`, the list's ids in their new order (ids
 * it leaves out keep their order after those it names, ids it does not know are ignored, and an
 * order naming one twice changes nothing).
 */
export const todos: Family = {
  name: "to-dos",
  events: {
    add_todo(ctx, f) {
      const id = ctx.nextId();
      ctx.model.todos.set(id, { id, text: f.str("text"), done: false });
    },
    toggle_todo(ctx, f) {
      const held = ctx.model.todos.get(f.id("id") ?? "");
      if (!held) return absent(ctx, "a to-do");
      held.done = !held.done;
    },
    delete_todo(ctx, f) {
      removeFrom(ctx, f, ctx.model.todos, "a to-do");
    },
    reorder_todos(ctx, f) {
      const held = ctx.model.todos;
      const named: string[] = [];
      for (const value of f.list("order") ?? []) {
        const id = idOf(value);
        if (id && held.has(id)) named.push(id);
      }
      const order = [...named, ...[...held.keys()].filter((id) => !named.includes(id))];
      // An order naming a to-do twice would not come out the list's length: ControlRoom then
      // leaves the list as it was.
      if (order.length !== held.size) return;
      ctx.model.todos = new Map(order.map((id) => [id, held.get(id) as CrTodo]));
    },
  },
};
