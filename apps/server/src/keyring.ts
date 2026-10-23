import { type Database, inOrg, schema } from "@hekate/db";
import { generateKey, keyId, unwrapKey, wrapKey } from "@hekate/storage";
import { and, desc, eq } from "drizzle-orm";

const { organisationKeys } = schema;

export interface MasterKeys {
  current: Buffer;
  /** Earlier master keys, accepted for unwrapping while rotating. */
  previous: Buffer[];
}

/**
 * The envelope key hierarchy (docs/security.md): master key, then one key per
 * organisation, then one data key per blob. Unwrapped organisation keys are held
 * in memory only; the database holds them wrapped by the master key.
 */
export interface Keyring {
  /** The organisation's current key, created on first use. */
  current(organisationId: string): Promise<{ version: number; key: Buffer }>;
  /** A specific version of the organisation's key, for reading older blobs. */
  version(organisationId: string, version: number): Promise<Buffer>;
  /**
   * A new version of the organisation's key, which everything wraps with from now on. The
   * earlier versions stay, so what they wrap still opens until it is rewrapped (#174).
   */
  rotate(organisationId: string, tx?: Writer): Promise<number>;
  /**
   * Check every organisation key against the configured master keys, and re-wrap
   * any wrapped by a previous master key with the current one. Run at start-up.
   */
  reconcile(): Promise<{ rewrapped: number }>;
  /**
   * Forget an organisation's keys held in memory, zeroed, once it has been purged (#186): its
   * wrapped keys went with its rows, and nothing here should outlive them.
   */
  forget(organisationId: string): void;
}

/** A transaction, or the database itself, to write a new key version with. */
type Writer = Pick<Database, "insert">;

export class UnknownMasterKeyError extends Error {
  override name = "UnknownMasterKeyError";
}

const context = (organisationId: string, version: number) =>
  `organisation-key:${organisationId}:${version}`;

export function createKeyring(db: Database, master: MasterKeys): Keyring {
  const currentId = keyId(master.current);
  const masterById = new Map<string, Buffer>([[currentId, master.current]]);
  for (const key of master.previous) masterById.set(keyId(key), key);

  const cache = new Map<string, Buffer>();

  const unwrapRow = (row: typeof organisationKeys.$inferSelect) => {
    const masterKey = masterById.get(row.masterKeyId);
    if (!masterKey) {
      throw new UnknownMasterKeyError(
        `Organisation ${row.organisationId} key v${row.version} is wrapped by master key ${row.masterKeyId}, which is not configured. Set MASTER_KEY, or list the old key in MASTER_KEYS_PREVIOUS.`,
      );
    }
    return unwrapKey(masterKey, row.wrappedKey, context(row.organisationId, row.version));
  };

  const remember = (organisationId: string, version: number, key: Buffer) => {
    cache.set(`${organisationId}:${version}`, key);
    return key;
  };

  async function version(organisationId: string, v: number) {
    const cached = cache.get(`${organisationId}:${v}`);
    if (cached) return cached;
    const [row] = await db
      .select()
      .from(organisationKeys)
      .where(inOrg(organisationKeys, organisationId, eq(organisationKeys.version, v)));
    if (!row) throw new Error(`Organisation ${organisationId} has no key version ${v}`);
    return remember(organisationId, v, unwrapRow(row));
  }

  async function current(organisationId: string) {
    const latest = async () => {
      const [row] = await db
        .select()
        .from(organisationKeys)
        .where(inOrg(organisationKeys, organisationId))
        .orderBy(desc(organisationKeys.version))
        .limit(1);
      return row;
    };
    let row = await latest();
    if (!row) {
      const key = generateKey();
      // Two requests may race to create the first key; the unique index keeps one.
      await db
        .insert(organisationKeys)
        .values({
          organisationId,
          version: 1,
          masterKeyId: currentId,
          wrappedKey: wrapKey(master.current, key, context(organisationId, 1)),
        })
        .onConflictDoNothing();
      row = await latest();
      if (!row) throw new Error(`Could not create a key for organisation ${organisationId}`);
    }
    const cached = cache.get(`${organisationId}:${row.version}`);
    return {
      version: row.version,
      key: cached ?? remember(organisationId, row.version, unwrapRow(row)),
    };
  }

  return {
    version,

    current,

    forget(organisationId) {
      for (const [id, key] of cache)
        if (id.startsWith(`${organisationId}:`)) {
          key.fill(0);
          cache.delete(id);
        }
    },

    async rotate(organisationId, tx) {
      const { version: from } = await current(organisationId);
      const next = from + 1;
      const key = generateKey();
      // Two rotations at once make one version; the unique index refuses the second.
      const [made] = await (tx ?? db)
        .insert(organisationKeys)
        .values({
          organisationId,
          version: next,
          masterKeyId: currentId,
          wrappedKey: wrapKey(master.current, key, context(organisationId, next)),
        })
        .onConflictDoNothing()
        .returning({ version: organisationKeys.version });
      // Inside a caller's transaction the key is not cached: if it rolls back, the version never
      // existed, and the next read loads whichever version did.
      if (made && !tx) remember(organisationId, next, key);
      return next;
    },

    async reconcile() {
      // Opens every organisation key, so a key that cannot be unwrapped (unknown master key,
      // corrupted record) stops start-up instead of surfacing on the first read.
      // Deliberately instance-wide (no organisation condition): master-key rotation is an
      // operator task across every tenant, and it runs only at start-up, never for a request.
      const rows = await db.select().from(organisationKeys);
      let rewrapped = 0;
      for (const row of rows) {
        let key: Buffer;
        try {
          key = unwrapRow(row);
        } catch (error) {
          if (error instanceof UnknownMasterKeyError) throw error;
          throw new UnknownMasterKeyError(
            `Organisation ${row.organisationId} key v${row.version} cannot be unwrapped with master key ${row.masterKeyId}: the record is corrupt or the key is wrong. Restore it from a backup.`,
          );
        }
        remember(row.organisationId, row.version, key);
        if (row.masterKeyId === currentId) continue;
        await db
          .update(organisationKeys)
          .set({
            masterKeyId: currentId,
            wrappedKey: wrapKey(master.current, key, context(row.organisationId, row.version)),
          })
          .where(
            and(
              inOrg(organisationKeys, row.organisationId, eq(organisationKeys.id, row.id)),
              eq(organisationKeys.masterKeyId, row.masterKeyId),
            ),
          );
        rewrapped += 1;
      }
      return { rewrapped };
    },
  };
}
