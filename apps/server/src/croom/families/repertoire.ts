import { aliases, crud, type Family, or, type ReplayContext } from "../family.ts";
import type { Fields } from "../fields.ts";
import { eachFields } from "../fields.ts";
import type { CrMovement, CrWork } from "../model.ts";

/**
 * Pieces and their movements (provisional, decision 242). A piece becomes a work; each of its
 * movements a track of that work, as Hekate has no movements. A piece with no movements becomes
 * a work of one track. `add_piece` has `title`, `composer`, `forces`, `abbreviation`, `notes`,
 * `pdf_id` and `page_offset`, and may carry its `movements` inline; `add_movement` has
 * `piece_id`, `title`, `number`, `page_from` and `page_to`.
 */
function readMovement(f: Fields, base: CrMovement): CrMovement {
  return {
    ...base,
    workId: or(f.id("piece_id", "work_id", "piece") ?? undefined, base.workId),
    title: or(f.str("title", "name", "label"), base.title),
    number: or(f.str("number", "num", "numeral", "index_label"), base.number),
    pageFrom: or(f.intOrNull("page_from", "start_page", "first_page", "page_start"), base.pageFrom),
    pageTo: or(f.intOrNull("page_to", "end_page", "last_page", "page_end"), base.pageTo),
  };
}

const blankMovement = (id: string, workId = ""): CrMovement => ({
  id,
  workId,
  title: "",
  number: "",
  pageFrom: null,
  pageTo: null,
});

function inlineMovements(f: Fields, workId: string, ctx: ReplayContext) {
  const listed = f.list("movements", "parts");
  for (const m of eachFields(listed, `${ctx.type}.movements`, ctx.report)) {
    const id = ctx.newId(m);
    ctx.model.movements.set(id, readMovement(m, blankMovement(id, workId)));
    m.skip("piece_id", "work_id", "piece");
    m.done();
  }
}

const piece = crud<CrWork>(
  "piece",
  (m) => m.works,
  (id) => ({
    id,
    title: "",
    composer: "",
    forces: "",
    abbreviation: "",
    notes: "",
    pdfId: null,
    pageOffset: 0,
  }),
  (f, base, ctx) => {
    const work: CrWork = {
      ...base,
      title: or(f.str("title", "name"), base.title),
      composer: or(f.str("composer", "author"), base.composer),
      forces: or(f.str("forces", "instrumentation", "scoring"), base.forces),
      abbreviation: or(f.str("abbreviation", "abbr", "short_name", "short"), base.abbreviation),
      notes: or(f.str("notes", "note"), base.notes),
      pdfId: or(f.id("pdf_id", "pdf", "score_pdf_id", "score_id", "score"), base.pdfId),
      pageOffset: or(f.int("page_offset", "pdf_page_offset", "offset"), base.pageOffset),
    };
    inlineMovements(f, base.id, ctx);
    return work;
  },
  (ctx, id) => {
    for (const [movementId, m] of ctx.model.movements)
      if (m.workId === id) ctx.model.movements.delete(movementId);
  },
);

const movement = crud<CrMovement>("movement", (m) => m.movements, blankMovement, readMovement);

export const repertoire: Family = {
  name: "repertoire",
  nouns: {
    ...aliases(["piece", "work", "repertoire"], piece),
    ...aliases(["movement", "part"], movement),
  },
};
