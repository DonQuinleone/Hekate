import { eachOf } from "../fields.ts";
import { absent, type Family, removeFrom } from "../family.ts";
import type { CrPiece } from "../model.ts";

/**
 * The repertoire (decision 242). `add_piece` carries nothing: it makes an empty work, and
 * `update_piece` then writes the whole of it (`id`, `title`, `composer`, `arranger`, `forces`,
 * `abbr`, `notes`, `pdf`, and `movements`, each with `num`, `title`, `forces`, `abbr`, `pdf`,
 * and its printed pages `p0` and `p1`, 0 for unset). A movement has no id: takes and schedule
 * slots name it by its place in the list, from 1. `delete_piece` removes one by `id`.
 *
 * Older files also hold the take log's first structure, `add_work` (`name`, `numbering`) and
 * `add_movement` (`work`, `name`, `base`), which ControlRoom still replays and no longer writes.
 */
export const repertoire: Family = {
  name: "repertoire",
  events: {
    add_piece(ctx) {
      const id = ctx.nextId();
      ctx.model.pieces.set(id, {
        id,
        title: "",
        composer: "",
        arranger: "",
        forces: "",
        abbreviation: "",
        notes: "",
        pdfId: null,
        movements: [],
      });
    },
    update_piece(ctx, f) {
      const id = f.id("id");
      const next: CrPiece = {
        id: id ?? "",
        title: f.str("title"),
        composer: f.str("composer"),
        arranger: f.str("arranger"),
        forces: f.str("forces"),
        abbreviation: f.str("abbr"),
        notes: f.str("notes"),
        pdfId: f.id("pdf"),
        movements: eachOf(f.list("movements"), `${ctx.type}.movements`, ctx.report, (m) => {
          const from = m.int("p0", 0);
          const to = m.int("p1", 0);
          return {
            number: m.str("num"),
            title: m.str("title"),
            forces: m.str("forces"),
            abbreviation: m.str("abbr"),
            pdfId: m.id("pdf"),
            pageFrom: from > 0 ? from : null,
            pageTo: to > 0 ? to : null,
          };
        }),
      };
      if (!id || !ctx.model.pieces.has(id)) return absent(ctx, "a work");
      ctx.model.pieces.set(id, next);
    },
    delete_piece(ctx, f) {
      removeFrom(ctx, f, ctx.model.pieces, "a work");
    },
    add_work(ctx, f) {
      const id = ctx.nextId();
      ctx.model.logWorks.set(id, {
        id,
        name: f.str("name"),
        numbering: f.str("numbering", "continuous"),
      });
    },
    add_movement(ctx, f) {
      const id = ctx.nextId();
      ctx.model.logMovements.set(id, { id, workId: f.id("work"), name: f.str("name") });
      // Where its take numbers start, for the desktop app's numbering only.
      f.skip("base");
    },
  },
};
