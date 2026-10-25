import type { Fields } from "../fields.ts";
import type { ReplayContext } from "../family.ts";

/**
 * Where a take or a mark belongs: a movement, or a piece. Ids are drawn from one counter for
 * every kind, so an id names one entry whatever field holds it, and a `target_id` is placed by
 * which of the two it turns out to be.
 */
export function placeOf(
  f: Fields,
  ctx: ReplayContext,
  base: { workId: string | null; movementId: string | null },
): { workId: string | null; movementId: string | null } {
  const movement = f.id("movement_id", "movement");
  const piece = f.id("piece_id", "work_id", "piece");
  const target = f.id("target_id", "item_id", "target");
  let workId = piece === undefined ? base.workId : piece;
  let movementId = movement === undefined ? base.movementId : movement;
  if (target) {
    if (ctx.model.movements.has(target)) movementId = target;
    else if (ctx.model.works.has(target)) workId = target;
  }
  if (movementId) {
    const found = ctx.model.movements.get(movementId);
    if (found) workId = found.workId;
  }
  return { workId, movementId };
}
