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
  // A member's sign-in is their account's, not a workspace's; only operators read them (#157).
  schema.authEvents,
  // The instance's mail sends for everyone; what its provider bounced is everyone's (#161).
  schema.mailSuppressions,
  // A payout belongs to no workspace, and an event outlives its workspace; only operators read
  // them (#178).
  schema.gatewayEvents,
  // The gateway names its customer, not a workspace: where a webhook finds which workspace it
  // is about, and nothing more (#178).
  schema.gatewayCustomers,
  // A code is the instance's, and who used it is read across workspaces by the operators who
  // made it; each use still names its workspace (#178).
  schema.promoRedemptions,
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
