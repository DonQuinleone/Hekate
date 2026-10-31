import { isIP } from "node:net";
import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  bucketBackendName,
  samePlace,
  type WorkspaceBucket,
  type WorkspaceBucketFields,
} from "@hekate/shared";
import {
  type ProbeResult,
  probeBackend,
  type S3BackendOptions,
  type StorageBackend,
  StorageConfigError,
  s3Backend,
} from "@hekate/storage";
import { asc, eq, isNull, type SQL } from "drizzle-orm";
import type { Keyring } from "./keyring.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { mayFetch, privateAddress, publicLookup } from "./sso.ts";

const { workspaceBuckets: buckets, organisations } = schema;

/**
 * A workspace's own bucket (#508). Its details are kept per place (endpoint, bucket, prefix):
 * a save to the same place changes that row, one to another place starts a new row and keeps
 * the old for the files it holds, which name it (`bucket:<id>`) in their blob rows. The access
 * key and secret are sealed with the workspace's key, as its mail's are; they are opened only to
 * reach the bucket, and never logged or sent back.
 */

export const bucketSealContext = (organisationId: string, bucketId: string) =>
  `workspace-bucket:${organisationId}:${bucketId}`;

type Row = typeof buckets.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** A save or test that cannot go ahead, with what to put right. */
export class BucketRefused extends Error {}

/** How a bucket's details become a backend: an S3 client, or anything else a test gives. */
export type BucketFactory = (options: S3BackendOptions) => StorageBackend;

/** A bucket as settings show it: everything but its credentials. */
export const bucketView = (row: Row): WorkspaceBucket => ({
  id: row.id,
  endpoint: row.endpoint,
  region: row.region,
  bucket: row.bucket,
  prefix: row.prefix,
  pathStyle: row.pathStyle,
  credentialsSet: true,
  savedAt: row.updatedAt.toISOString(),
});

/** How long a bucket's opened details are kept in memory before they are read again. */
const KEEP_MS = 30_000;

export interface WorkspaceBuckets {
  /** The backend a blob naming this bucket is read from and written to, within its workspace. */
  backend(organisationId: string, bucketId: string): Promise<StorageBackend>;
  /** Every bucket the workspace has kept, current or not: for a purge. */
  all(organisationId: string): Promise<StorageBackend[]>;
  /** The bucket the workspace has saved and not replaced, used or not. */
  current(organisationId: string): Promise<WorkspaceBucket | null>;
  /** Write and delete a probe object with these details, the saved credentials kept if left out. */
  test(organisationId: string, fields: WorkspaceBucketFields): Promise<ProbeResult>;
  /**
   * Save the details, once a probe object has been written and deleted with them, and make the
   * bucket take the workspace's new files. Returns the bucket.
   */
  save(organisationId: string, fields: WorkspaceBucketFields): Promise<WorkspaceBucket>;
}

export function workspaceBuckets(deps: {
  db: Database;
  keyring: Keyring;
  /** Origins on a private network a workspace's bucket may be (WEBHOOK_TRUSTED_ORIGINS). */
  trusted?: string[];
  create?: BucketFactory;
}): WorkspaceBuckets {
  const { db, keyring } = deps;
  const trusted = deps.trusted ?? [];
  const create = deps.create ?? s3Backend;
  const opened = new Map<string, { stamp: string; at: number; backend: StorageBackend }>();

  const trustedEndpoint = (endpoint: string | null) =>
    endpoint !== null && trusted.includes(new URL(endpoint).origin);

  const backendOf = (
    id: string,
    fields: Pick<Row, "endpoint" | "region" | "bucket" | "prefix" | "pathStyle">,
    credentials: Credentials,
  ) =>
    create({
      name: bucketBackendName(id),
      bucket: fields.bucket,
      region: fields.region,
      ...(fields.endpoint ? { endpoint: fields.endpoint } : {}),
      forcePathStyle: fields.pathStyle,
      ...(fields.prefix ? { prefix: fields.prefix } : {}),
      // Always the workspace's own: never the instance's credentials from its environment.
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      // Connected only to a public address, checked at the connection, unless trusted.
      ...(trustedEndpoint(fields.endpoint) ? {} : { lookup: publicLookup }),
      connectionTimeoutMs: 10_000,
    });

  const credentialsOf = async (row: Row): Promise<Credentials> => {
    const key = await keyring.version(row.organisationId, row.keyVersion);
    return JSON.parse(
      openSecret(key, row.credentialsSealed, bucketSealContext(row.organisationId, row.id)),
    ) as Credentials;
  };

  const rowsOf = (organisationId: string, ...where: (SQL | undefined)[]) =>
    db
      .select()
      .from(buckets)
      .where(inOrg(buckets, organisationId, ...where))
      .orderBy(asc(buckets.createdAt));

  const currentRow = async (organisationId: string, tx: Pick<Database, "select"> = db) => {
    const [row] = await tx
      .select()
      .from(buckets)
      .where(inOrg(buckets, organisationId, isNull(buckets.replacedAt)));
    return row ?? null;
  };

  // Kept by workspace and bucket together, so one workspace never reaches another's by its id.
  const cacheKey = (organisationId: string, bucketId: string) => `${organisationId}:${bucketId}`;
  const opening = async (row: Row) => {
    const stamp = `${row.credentialsSealed}:${row.updatedAt.getTime()}`;
    const at = Date.now();
    const known = opened.get(cacheKey(row.organisationId, row.id));
    if (known?.stamp === stamp) {
      known.at = at;
      return known.backend;
    }
    const backend = backendOf(row.id, row, await credentialsOf(row));
    opened.set(cacheKey(row.organisationId, row.id), { stamp, at, backend });
    return backend;
  };

  /**
   * The details a save or test comes to: checked, the endpoint somewhere the instance may
   * reach, and the saved credentials kept where none are given and the place's endpoint is
   * the same (so they are never sent somewhere new without being typed again).
   */
  const merged = async (
    organisationId: string,
    fields: WorkspaceBucketFields,
  ): Promise<{ credentials: Credentials; saved: Row | null }> => {
    if (fields.endpoint) {
      const url = new URL(fields.endpoint);
      const allowed = trustedEndpoint(fields.endpoint);
      if (url.protocol !== "https:" && !allowed)
        throw new BucketRefused(
          "Only https:// endpoints are reached. The operator can allow one inside their network with WEBHOOK_TRUSTED_ORIGINS.",
        );
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (!allowed && ((isIP(host) && privateAddress(host)) || !(await mayFetch(url.href, []))))
        throw new BucketRefused(
          "That endpoint is on a private network, or cannot be found. The operator can allow one inside their network with WEBHOOK_TRUSTED_ORIGINS.",
        );
    }
    const saved = await currentRow(organisationId);
    const sameEndpoint =
      saved !== null &&
      (saved.endpoint ?? "").toLowerCase() === (fields.endpoint ?? "").toLowerCase();
    const stored = saved && sameEndpoint ? await credentialsOf(saved) : null;
    const accessKeyId = fields.accessKeyId || stored?.accessKeyId;
    const secretAccessKey = fields.secretAccessKey || stored?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey)
      throw new BucketRefused(
        saved && !sameEndpoint
          ? "Give the access key and secret again for a new endpoint."
          : "Give the bucket's access key and secret.",
      );
    return { credentials: { accessKeyId, secretAccessKey }, saved };
  };

  return {
    async backend(organisationId, bucketId) {
      const known = opened.get(cacheKey(organisationId, bucketId));
      if (known && Date.now() - known.at < KEEP_MS) return known.backend;
      const [row] = await rowsOf(organisationId, eq(buckets.id, bucketId));
      if (!row)
        throw new StorageConfigError(
          `Organisation ${organisationId} has no bucket ${bucketId}; its files cannot be reached`,
        );
      return opening(row);
    },

    async all(organisationId) {
      return Promise.all((await rowsOf(organisationId)).map(opening));
    },

    async current(organisationId) {
      const row = await currentRow(organisationId);
      return row ? bucketView(row) : null;
    },

    async test(organisationId, fields) {
      const { credentials } = await merged(organisationId, fields);
      return probeBackend(backendOf("test", fields, credentials));
    },

    async save(organisationId, fields) {
      const { credentials } = await merged(organisationId, fields);
      const probe = await probeBackend(backendOf("test", fields, credentials));
      if (!probe.ok) throw new BucketRefused(probe.message);
      const { version, key } = await keyring.current(organisationId);
      const write = async (t: Tx) => {
        // The same place, current or used before: its details and credentials change, and its
        // files stay with it. A place gets one identity only, so reconciliation never sees one
        // identity's files as another's orphans in the same bucket.
        const known = await t
          .select()
          .from(buckets)
          .where(inOrg(buckets, organisationId))
          .orderBy(asc(buckets.createdAt));
        const place = known.find((row) => samePlace(row, fields)) ?? null;
        const id = place?.id ?? uuidv7();
        const values = {
          endpoint: fields.endpoint,
          region: fields.region,
          bucket: fields.bucket,
          prefix: fields.prefix,
          pathStyle: fields.pathStyle,
          credentialsSealed: sealSecret(
            key,
            JSON.stringify(credentials),
            bucketSealContext(organisationId, id),
          ),
          keyVersion: version,
          updatedAt: new Date(),
        };
        if (place) {
          // Taken up again: the one in use until now is kept for its files, and takes no more.
          if (place.replacedAt)
            await t
              .update(buckets)
              .set({ replacedAt: new Date() })
              .where(inOrg(buckets, organisationId, isNull(buckets.replacedAt)));
          const [row] = await t
            .update(buckets)
            .set({ ...values, replacedAt: null })
            .where(inOrg(buckets, organisationId, eq(buckets.id, place.id)))
            .returning();
          if (!row) throw new BucketRefused("The bucket changed meanwhile; try again.");
          return row;
        }
        // Another place: the one before is kept for the files it holds, but takes no more.
        await t
          .update(buckets)
          .set({ replacedAt: new Date() })
          .where(inOrg(buckets, organisationId, isNull(buckets.replacedAt)));
        const [row] = await t
          .insert(buckets)
          .values({ id, organisationId, ...values })
          .returning();
        if (!row) throw new Error("Bucket insert returned no row");
        return row;
      };
      const row = await db.transaction(async (t) => {
        const written = await write(t);
        // Saving it is choosing it: the workspace's new files go there from now on.
        await t
          .update(organisations)
          .set({ storageBackend: bucketBackendName(written.id) })
          .where(eq(organisations.id, organisationId));
        return written;
      });
      opened.delete(cacheKey(organisationId, row.id));
      return bucketView(row);
    },
  };
}
