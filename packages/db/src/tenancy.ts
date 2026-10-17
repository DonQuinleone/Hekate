import { and, eq, is, type SQL } from "drizzle-orm";
import { type PgColumn, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema.ts";

type TenantTable = PgTable & { organisationId: PgColumn };

/** Tables that are not owned by a single organisation. Everything else must be scoped. */
export const globalTables = new Set<PgTable>([
  schema.organisations,
  schema.users,
  schema.authSessions,
  schema.authAccounts,
  schema.authVerifications,
  // A failure may belong to no workspace; only operators read them (#159).
  schema.errorReports,
]);

export const tenantTables: TenantTable[] = (Object.values(schema) as unknown[]).filter(
  (value): value is TenantTable =>
    is(value, PgTable) && "organisationId" in value && !globalTables.has(value),
);

/**
 * The organisation condition for a query, combined with any others.
 * Use it for every read, update and delete on a tenant-owned table:
 *
 *   db.select().from(projects).where(inOrg(projects, orgId, eq(projects.id, id)))
 */
export function inOrg(
  table: TenantTable,
  organisationId: string,
  ...conditions: (SQL | undefined)[]
): SQL {
  return and(eq(table.organisationId, organisationId), ...conditions) as SQL;
}
