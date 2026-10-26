import { absent, type Family } from "../family.ts";

/**
 * Score PDFs embedded in the file (decision 242): `add_pdf` with `name`, `blob` (its row in the
 * blobs table) and `pages`; `set_pdf_page_offset` with `pdf` and `offset` (the PDF's page less
 * the printed page); `replace_pdf`, a swapped file under the same identity (`pdf`, `name`,
 * `blob`, `pages`: its marks, takes and repertoire links stay); and `remove_pdf` by `pdf`,
 * which takes the score's marks with it.
 */
export const pdfs: Family = {
  name: "pdfs",
  events: {
    add_pdf(ctx, f) {
      const id = ctx.nextId();
      ctx.model.pdfs.set(id, {
        id,
        name: f.str("name"),
        blobId: f.id("blob"),
        pages: f.int("pages", 0),
        pageOffset: 0,
      });
    },
    set_pdf_page_offset(ctx, f) {
      const held = ctx.model.pdfs.get(f.id("pdf") ?? "");
      const offset = f.int("offset", 0);
      if (!held) return absent(ctx, "a score");
      held.pageOffset = offset;
    },
    replace_pdf(ctx, f) {
      const held = ctx.model.pdfs.get(f.id("pdf") ?? "");
      const next = { name: f.str("name"), blobId: f.id("blob"), pages: f.int("pages", 0) };
      if (!held) return absent(ctx, "a score");
      Object.assign(held, next);
    },
    remove_pdf(ctx, f) {
      const id = f.id("pdf");
      if (!id || !ctx.model.pdfs.delete(id)) return absent(ctx, "a score");
      for (const [key, a] of ctx.model.annotations)
        if (a.pdfId === id) ctx.model.annotations.delete(key);
    },
  },
};
