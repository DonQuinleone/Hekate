import { type Family, removeFrom } from "../family.ts";

/**
 * Files attached to the session (decision 242): `add_attachment` with `name` (the original file
 * name) and `blob` (its row in the blobs table); `delete_attachment` by `id`.
 */
export const attachments: Family = {
  name: "attachments",
  events: {
    add_attachment(ctx, f) {
      const id = ctx.nextId();
      ctx.model.attachments.set(id, { id, name: f.str("name"), blobId: f.id("blob") });
    },
    delete_attachment(ctx, f) {
      removeFrom(ctx, f, ctx.model.attachments, "an attachment");
    },
  },
};
