import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import { eq, inArray, ne, type SQL, type SQLWrapper } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Every write to a variant goes through here, in the caller's transaction, scoped to the
 * workspace. The table under its old name, written beside this one while the rename ran
 * (decision 275), is gone (decision 295, #484).
 */

const { variants } = schema;

/** A variant as it is inserted; the id is made here. */
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

const conditions = (by: VariantsBy): SQL[] => [
  ...(by.id ? [eq(variants.id, by.id)] : []),
  ...(by.versionId ? [eq(variants.versionId, by.versionId)] : []),
  ...(by.exceptId ? [ne(variants.id, by.exceptId)] : []),
];

/** Inserts the variants, and answers their ids in the order given. */
export async function insertVariants(tx: Tx, rows: NewVariant[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const withIds = rows.map((row) => ({ ...row, id: uuidv7() }));
  await tx.insert(variants).values(withIds);
  return withIds.map((row) => row.id);
}

/** Updates the variants chosen. */
export async function updateVariants(
  tx: Tx,
  organisationId: string,
  by: VariantsBy,
  set: VariantChanges,
): Promise<void> {
  await tx
    .update(variants)
    .set(set)
    .where(inOrg(variants, organisationId, ...conditions(by)));
}

/**
 * Deletes a workspace's variants: those of the files chosen, or every one.
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
}

/** True when a statement failed because the file is already a variant of a version. */
export function violatesOneVariantPerFile(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === "variants_file_idx";
}
