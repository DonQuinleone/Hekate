import { type Database, inOrg, schema } from "@hekate/db";
import { eq, inArray, sql } from "drizzle-orm";

const { files } = schema;

type Db = Pick<Database, "select" | "execute">;

/** The longest chain walked either way: far beyond any a person makes, short of a runaway. */
const LIMIT = 500;

/**
 * A file's simple version chain (#149), oldest first: every file it replaces and every file
 * that replaces it, each with its number. A file alone has a chain of one.
 */
export async function chainOf(db: Db, organisationId: string, fileId: string) {
  const rows = await db.execute<{ id: string; depth: number }>(sql`
    with recursive back(id, previous_file_id, depth) as (
      select id, previous_file_id, 0 from files
        where id = ${fileId} and organisation_id = ${organisationId}
      union all
      select f.id, f.previous_file_id, b.depth - 1 from files f
        join back b on f.id = b.previous_file_id
        where f.organisation_id = ${organisationId} and b.depth > ${-LIMIT}
    ), forth(id, depth) as (
      select id, 0 from files where id = ${fileId} and organisation_id = ${organisationId}
      union all
      select f.id, n.depth + 1 from files f
        join forth n on f.previous_file_id = n.id
        where f.organisation_id = ${organisationId} and n.depth < ${LIMIT}
    )
    select id, depth from back union select id, depth from forth order by depth`);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const found = await db
    .select({ id: files.id, name: files.name, createdAt: files.createdAt })
    .from(files)
    .where(inOrg(files, organisationId, inArray(files.id, ids)));
  const byId = new Map(found.map((f) => [f.id, f]));
  return ids.flatMap((id, i) => {
    const file = byId.get(id);
    return file ? [{ ...file, number: i + 1 }] : [];
  });
}

/** The file that replaces this one, if any. */
export async function nextOf(db: Pick<Database, "select">, organisationId: string, id: string) {
  const [next] = await db
    .select({ id: files.id })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.previousFileId, id)));
  return next ?? null;
}
