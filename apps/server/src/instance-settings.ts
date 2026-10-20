import { type Database, schema } from "@hekate/db";
import { defaultInstanceSettings, type InstanceSettings, instanceSettingsOf } from "@hekate/shared";
import { eq } from "drizzle-orm";

/** How long a settings read is trusted before it is read again. */
const FRESH_MS = 15_000;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * The instance's settings (#160), read from the database as the server runs, so a change an
 * operator makes reaches every process within seconds, without a restart. `current` answers
 * at once with the last read, for checks that cannot wait; `get` reads again when it is stale.
 */
export function createInstanceSettings(db: Database, now = () => Date.now()) {
  let read: { at: number; settings: InstanceSettings } | null = null;
  const get = async (): Promise<InstanceSettings> => {
    if (read && now() - read.at < FRESH_MS) return read.settings;
    try {
      const [row] = await db.select().from(schema.instanceSettings);
      read = { at: now(), settings: instanceSettingsOf(row?.settings) };
    } catch {
      // Unreadable: keep what was last read, or the defaults, rather than fail a request.
      read = { at: now(), settings: read?.settings ?? defaultInstanceSettings };
    }
    return read.settings;
  };
  return {
    get,
    current: (): InstanceSettings => read?.settings ?? defaultInstanceSettings,
    /**
     * Writes the settings in the caller's transaction, the row held so two operators saving at
     * once each see what the other saved; returns what they were before.
     */
    async write(tx: Tx, next: InstanceSettings, by: string): Promise<InstanceSettings> {
      const [row] = await tx
        .select()
        .from(schema.instanceSettings)
        .where(eq(schema.instanceSettings.id, "instance"))
        .for("update");
      const values = { settings: next, updatedBy: by, updatedAt: new Date() };
      await tx
        .insert(schema.instanceSettings)
        .values({ id: "instance", ...values })
        .onConflictDoUpdate({ target: schema.instanceSettings.id, set: values });
      read = null;
      return instanceSettingsOf(row?.settings);
    },
    /** Forget the last read, so the next `get` reads again. */
    forget() {
      read = null;
    },
  };
}

export type InstanceSettingsStore = ReturnType<typeof createInstanceSettings>;
