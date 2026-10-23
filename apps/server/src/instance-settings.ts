import { type Database, schema } from "@hekate/db";
import {
  defaultInstanceSettings,
  type InstanceSettings,
  type InstanceSettingsInput,
  instanceSettingsOf,
  withStored,
} from "@hekate/shared";
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
  // Raised by each `forget`: a read begun before one may have the old row, and is not kept.
  let generation = 0;
  const get = async (): Promise<InstanceSettings> => {
    if (read && now() - read.at < FRESH_MS) return read.settings;
    const started = generation;
    let settings: InstanceSettings;
    try {
      const [row] = await db.select().from(schema.instanceSettings);
      settings = instanceSettingsOf(row?.settings);
    } catch {
      // Unreadable: keep what was last read, or the defaults, rather than fail a request.
      settings = read?.settings ?? defaultInstanceSettings;
    }
    if (started === generation) read = { at: now(), settings };
    return settings;
  };
  return {
    get,
    current: (): InstanceSettings => read?.settings ?? defaultInstanceSettings,
    /**
     * Writes the settings in the caller's transaction, the row held so two operators saving at
     * once each see what the other saved; returns what they were before. The caller forgets
     * the last read once the transaction commits, so nothing reads the old row back meanwhile.
     */
    async write(
      tx: Tx,
      /** The save, or how to make it from what is stored (the support desk's part alone, say). */
      input: InstanceSettingsInput | ((stored: InstanceSettings) => InstanceSettingsInput),
      by: string,
    ): Promise<{ before: InstanceSettings; after: InstanceSettings }> {
      // The row made first if it is not there yet, so even the first two saves take turns.
      await tx
        .insert(schema.instanceSettings)
        .values({ id: "instance", settings: defaultInstanceSettings })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.instanceSettings)
        .where(eq(schema.instanceSettings.id, "instance"))
        .for("update");
      const before = instanceSettingsOf(row?.settings);
      // Under the lock: what the save leaves out is what is stored now, not a default.
      const after = withStored(typeof input === "function" ? input(before) : input, before);
      await tx
        .update(schema.instanceSettings)
        .set({ settings: after, updatedBy: by, updatedAt: new Date() })
        .where(eq(schema.instanceSettings.id, "instance"));
      return { before, after };
    },
    /** Forget the last read, so the next `get` reads again. */
    forget() {
      read = null;
      generation += 1;
    },
  };
}

export type InstanceSettingsStore = ReturnType<typeof createInstanceSettings>;
