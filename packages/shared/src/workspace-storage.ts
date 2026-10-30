import { z } from "zod";

/**
 * A workspace's own storage (#508): on a plan that includes it, its new files can go to an
 * S3-compatible bucket of its own instead of the instance's storage. Files are encrypted before
 * they leave Hekate, so the bucket holds ciphertext only, as every backend does. The access key
 * and secret go in and never come back.
 */

/** How a blob row and a workspace's choice name a workspace's own bucket: never an instance backend's name. */
export const bucketBackendName = (bucketId: string) => `bucket:${bucketId}`;

/** The bucket's id in a backend's name, or null for one of the instance's backends. */
export function bucketIdOf(backend: string): string | null {
  const match = /^bucket:([0-9a-f-]{36})$/.exec(backend);
  return match?.[1] ?? null;
}

/** One segment of a key, as storage keys take them (`packages/storage`). */
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";

export const workspaceBucketInput = z.object({
  /** Empty is Amazon S3 itself; any other service is reached at its address. */
  endpoint: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(v), {
      error: "An address starting https://, or empty for Amazon S3",
    })
    .transform((v) => (v === "" ? null : v.replace(/\/+$/, ""))),
  region: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, {
      error: "The bucket's region, such as eu-central-1 (us-east-1 where the service has none)",
    }),
  bucket: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,254}$/, {
      error: "The bucket's name, as the service shows it",
    }),
  /** Keys go under it, in a bucket shared with other things. */
  prefix: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || new RegExp(`^${SEGMENT}(?:/${SEGMENT})*/?$`).test(v), {
      error: "Letters, digits, dots, hyphens and underscores, in parts separated by /",
    })
    .transform((v) => v.replace(/\/+$/, "")),
  /** Address the bucket as `endpoint/bucket`, as most self-hosted services need. */
  pathStyle: z.boolean().default(false),
  /** Left out (or empty) to keep the ones saved, for the same endpoint. */
  accessKeyId: z.string().trim().max(256).optional(),
  secretAccessKey: z.string().max(1024).optional(),
});
export type WorkspaceBucketInput = z.input<typeof workspaceBucketInput>;
export type WorkspaceBucketFields = z.output<typeof workspaceBucketInput>;

/** Where a bucket keeps things: a different place is a different bucket, kept for its files. */
export const samePlace = (
  a: Pick<WorkspaceBucketFields, "endpoint" | "bucket" | "prefix">,
  b: Pick<WorkspaceBucketFields, "endpoint" | "bucket" | "prefix">,
) =>
  (a.endpoint ?? "").toLowerCase() === (b.endpoint ?? "").toLowerCase() &&
  a.bucket === b.bucket &&
  a.prefix === b.prefix;

/** A bucket in a line: "hekate-endless-hall/hekate at fsn1.your-objectstorage.com". */
export function bucketLine(b: Pick<WorkspaceBucketFields, "endpoint" | "bucket" | "prefix">) {
  const where = b.endpoint ? new URL(b.endpoint).host : "Amazon S3";
  return `${b.bucket}${b.prefix ? `/${b.prefix}` : ""} at ${where}`;
}

/** The workspace's bucket as settings show it: everything but its credentials. */
export interface WorkspaceBucket {
  id: string;
  endpoint: string | null;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** An access key and secret are saved. They are never sent back. */
  credentialsSet: boolean;
  savedAt: string;
}

/** `GET /api/organisation/storage`: where the workspace's new files go. */
export interface WorkspaceStorage {
  /** The instance backend chosen for new files; null follows the instance default. */
  backend: string | null;
  defaultBackend: string;
  /** The instance's backends. */
  available: string[];
  /** New files go to the workspace's own bucket rather than the instance's storage. */
  usesBucket: boolean;
  /** The bucket saved, used or not. */
  bucket: WorkspaceBucket | null;
  /** Whether the workspace's plan includes its own storage, and that plan's name. */
  ownStorage: { entitled: boolean; plan: string | null };
}

/** The answer to a test of a bucket's details: what failed, in words, never the credentials. */
export interface BucketTestResult {
  ok: boolean;
  /** The step that failed: reaching the bucket, writing the probe, or deleting it. */
  step: "reach" | "write" | "delete" | null;
  message: string;
}
