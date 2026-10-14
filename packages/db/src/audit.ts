import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run work that may delete access log rows: retention, removing an organisation,
 * or resetting a test database. The log refuses deletes otherwise (migration 0006).
 * The permission lasts only for this transaction.
 */
export async function withAuditPurge<T>(
  db: Database,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local hekate.audit_purge = 'on'`);
    return work(tx);
  });
}
