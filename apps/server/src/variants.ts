import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import { eq, inArray, ne, type SQL, type SQLWrapper } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Every write to a variant goes through here while the rename runs (decision 275, #484): the
 * row is written to `variants`, which this release reads, and to `variations`, which the
 * release before still reads, under the same id, in the caller's transaction so the two tables
 * never part. Release 2 of the rename drops `variations` and this module with it.
 */

const { variants, variations } = schema;

/** A variant as it is inserted; the id is made here so both tables hold the same one. */
export type NewVariant = Omit<typeof variants.$inferInsert, "id">;

/** Which variants a write is about: one by id, or a version's, less one. */
export interface VariantsBy {
  id?: string;
  versionId?: string;
  exceptId?: string;
}

/** Changes to a variant, as `update` sets them. */
export type VariantChanges = Partial<
  Pick<NewVariant, "name" | "isPrimary" | "position" | "fileId" | "subtitled" | "graded">
> & { updatedAt: Date };

const conditions = (table: typeof variants | typeof variations, by: VariantsBy): SQL[] => [
  ...(by.id ? [eq(table.id, by.id)] : []),
  ...(by.versionId ? [eq(table.versionId, by.versionId)] : []),
  ...(by.exceptId ? [ne(table.id, by.exceptId)] : []),
];

/** Inserts the variants into both tables, and answers their ids in the order given. */
export async function insertVariants(tx: Tx, rows: NewVariant[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const withIds = rows.map((row) => ({ ...row, id: uuidv7() }));
  await tx.insert(variants).values(withIds);
  await tx.insert(variations).values(withIds);
  return withIds.map((row) => row.id);
}

/** Updates the variants chosen, in both tables. */
export async function updateVariants(
  tx: Tx,
  organisationId: string,
  by: VariantsBy,
  set: VariantChanges,
): Promise<void> {
  await tx
    .update(variants)
    .set(set)
    .where(inOrg(variants, organisationId, ...conditions(variants, by)));
  await tx
    .update(variations)
    .set(set)
    .where(inOrg(variations, organisationId, ...conditions(variations, by)));
}

/**
 * Deletes a workspace's variants from both tables: those of the files chosen, or every one.
 * Purges only; a variant is otherwise never deleted, its version going with its track.
 */
export async function deleteVariants(
  tx: Tx,
  organisationId: string,
  by: { fileIn?: SQLWrapper } = {},
): Promise<void> {
  await tx
    .delete(variants)
    .where(inOrg(variants, organisationId, by.fileIn && inArray(variants.fileId, by.fileIn)));
  await tx
    .delete(variations)
    .where(inOrg(variations, organisationId, by.fileIn && inArray(variations.fileId, by.fileIn)));
}

/** The unique indexes that refuse a file already a variant of a version, in either table. */
export const variantFileIndexes = ["variants_file_idx", "variations_file_idx"] as const;

/** True when a statement failed because the file is already a variant of a version. */
export function violatesOneVariantPerFile(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return (
    cause?.code === "23505" &&
    (variantFileIndexes as readonly string[]).includes(cause.constraint_name ?? "")
  );
}
