import { type Database, schema } from "@hekate/db";
import { type FlagKey, flagOn, flagUntil, type InstanceFlag, instanceFlags } from "@hekate/shared";

/** How long a flag read is trusted before it is read again. */
const FRESH_MS = 15_000;

/**
 * The instance's flags (#159), read from the database at start-up and again every few seconds
 * as the server runs, so a flag an operator turns reaches every process without a restart.
 */
export function createFlags(db: Database, now = () => new Date()) {
  let read: { at: number; rows: Map<string, { on: boolean; until: Date | null }> } | null = null;
  const rows = async () => {
    if (read && now().getTime() - read.at < FRESH_MS) return read.rows;
    const all = await db.select().from(schema.instanceFlags);
    read = { at: now().getTime(), rows: new Map(all.map((r) => [r.key, r])) };
    return read.rows;
  };
  return {
    /** Whether a flag is on now. A flag that cannot be read is off. */
    async isOn(key: FlagKey) {
      try {
        return flagOn((await rows()).get(key), now());
      } catch {
        return false;
      }
    },
    /** Every flag, as Debug tools shows it. */
    async list(): Promise<InstanceFlag[]> {
      read = null;
      const stored = await rows();
      return (Object.keys(instanceFlags) as FlagKey[]).map((key) => {
        const row = stored.get(key);
        const on = flagOn(row, now());
        return {
          key,
          label: instanceFlags[key].label,
          hint: instanceFlags[key].hint,
          on,
          until: on && row?.until ? row.until.toISOString() : null,
        };
      });
    },
    /** Turns a flag on (for its time) or off. */
    async set(key: FlagKey, on: boolean, by: string, into: Pick<Database, "insert"> = db) {
      const row = { on, until: on ? flagUntil(key, now()) : null, updatedBy: by, updatedAt: now() };
      await into
        .insert(schema.instanceFlags)
        .values({ key, ...row })
        .onConflictDoUpdate({ target: schema.instanceFlags.key, set: row });
      read = null;
    },
  };
}

export type Flags = ReturnType<typeof createFlags>;
