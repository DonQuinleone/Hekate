import { aliases, crud, type Family, or } from "../family.ts";
import type { CrPdf } from "../model.ts";

/**
 * PDFs (provisional, decision 242): `add_pdf` with `name`, `blob_id` (the blobs table's id of
 * its bytes) and optionally `piece_id`, the piece whose score it is. Each becomes a document in
 * the project, stored encrypted as any upload is, and a piece's becomes its work's score.
 */
const pdf = crud<CrPdf>(
  "pdf",
  (m) => m.pdfs,
  (id) => ({ id, name: "", blobId: null }),
  (f, base, ctx) => {
    const next: CrPdf = {
      ...base,
      name: or(f.str("name", "filename", "file_name", "title"), base.name),
      blobId: or(f.id("blob_id", "blob", "hash", "blob_hash", "sha256"), base.blobId),
    };
    const pieceId = f.id("piece_id", "work_id", "piece");
    const work = pieceId ? ctx.model.works.get(pieceId) : undefined;
    if (pieceId && !work) ctx.report.problem(`${ctx.type}: names a piece the file never added`);
    if (work && !work.pdfId) work.pdfId = base.id;
    return next;
  },
);

export const pdfs: Family = {
  name: "pdfs",
  nouns: aliases(["pdf", "score_pdf", "document", "attachment"], pdf),
};
