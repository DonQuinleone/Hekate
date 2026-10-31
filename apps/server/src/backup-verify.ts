import { createHash, randomInt } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { bucketIdOf, bucketLine } from "@hekate/shared";
import type { StorageBackend } from "@hekate/storage";
import { asc, isNull } from "drizzle-orm";
import type { Keyring } from "./keyring.ts";
import type { Storage } from "./storage.ts";

const { blobs, organisationKeys, organisations, workspaceBuckets } = schema;

export interface VerifyReport {
  /** Organisation key versions that open with the configured master keys. */
  keys: { checked: number; failed: string[] };
  /** Blobs whose bytes are in their backend. */
  objects: { checked: number; missing: string[] };
  /** Blobs read in full and decrypted, compared with their checksum where it is known. */
  sample: { checked: number; failed: string[] };
  /**
   * Workspaces that keep files in a bucket of their own (#508): theirs to back up, not the
   * operator's, each with its current bucket and how many objects its buckets hold.
   */
  ownBuckets: { workspace: string; bucket: string | null; objects: number }[];
  ok: boolean;
}

/**
 * Whether a database, its storage and the master key belong together (#152): run after a
 * restore, before anyone uses it. Every workspace key must open with the master key; every
 * blob the database records must be in its backend; and a random sample of blobs must read
 * back, decrypt and match their checksum. It changes nothing.
 */
export async function verifyBackup(
  deps: { db: Database; storage: Storage; keyring: Keyring },
  options: { sample?: number } = {},
): Promise<VerifyReport> {
  const { db, storage, keyring } = deps;
  const report: VerifyReport = {
    keys: { checked: 0, failed: [] },
    objects: { checked: 0, missing: [] },
    sample: { checked: 0, failed: [] },
    ownBuckets: [],
    ok: false,
  };
  const all = await db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations);
  const recorded: {
    organisationId: string;
    id: string;
    backend: string;
    key: string;
    sha256: string | null;
  }[] = [];
  for (const workspace of all) {
    for (const row of await db
      .select({ version: organisationKeys.version })
      .from(organisationKeys)
      .where(inOrg(organisationKeys, workspace.id))) {
      report.keys.checked += 1;
      try {
        await keyring.version(workspace.id, row.version);
      } catch (error) {
        report.keys.failed.push(
          `${workspace.name}, key v${row.version}: ${(error as Error).message}`,
        );
      }
    }
    const before = recorded.length;
    for (const blob of await db
      .select({ id: blobs.id, backend: blobs.backend, key: blobs.key, sha256: blobs.sha256 })
      .from(blobs)
      .where(inOrg(blobs, workspace.id))
      .orderBy(asc(blobs.id)))
      recorded.push({ organisationId: workspace.id, ...blob });
    const [current] = await db
      .select()
      .from(workspaceBuckets)
      .where(inOrg(workspaceBuckets, workspace.id, isNull(workspaceBuckets.replacedAt)));
    const inBuckets = recorded.slice(before).filter((b) => bucketIdOf(b.backend)).length;
    if (current || inBuckets > 0)
      report.ownBuckets.push({
        workspace: workspace.name,
        bucket: current ? bucketLine(current) : null,
        objects: inBuckets,
      });
  }

  for (const blob of recorded) {
    report.objects.checked += 1;
    let backend: StorageBackend;
    if (bucketIdOf(blob.backend)) {
      // A workspace's own bucket, opened with its sealed credentials, as the server opens it.
      try {
        backend = await storage.backendOf(blob.organisationId, blob.backend);
      } catch (error) {
        report.objects.missing.push(`${blob.key}: ${(error as Error).message}`);
        continue;
      }
    } else if (storage.backends.has(blob.backend)) backend = storage.backends.get(blob.backend);
    else {
      report.objects.missing.push(`${blob.key}: backend "${blob.backend}" is not configured`);
      continue;
    }
    try {
      if (!(await backend.head(blob.key)))
        report.objects.missing.push(`${blob.backend}:${blob.key}`);
    } catch (error) {
      report.objects.missing.push(`${blob.backend}:${blob.key}: ${(error as Error).name}`);
    }
  }

  // A random sample, read in full: decryption checks every chunk's tag, the checksum the whole.
  const pool = [...recorded];
  const size = Math.min(options.sample ?? 20, pool.length);
  for (let i = 0; i < size; i++) {
    const [blob] = pool.splice(randomInt(pool.length), 1);
    if (!blob) break;
    report.sample.checked += 1;
    try {
      const { stream } = await storage.open(blob.organisationId, blob.id);
      const hash = createHash("sha256");
      for await (const chunk of stream) hash.update(chunk as Buffer);
      const digest = hash.digest("hex");
      if (blob.sha256 && blob.sha256 !== digest)
        report.sample.failed.push(`${blob.key}: decrypted, but its checksum does not match`);
    } catch (error) {
      report.sample.failed.push(`${blob.key}: ${(error as Error).message}`);
    }
  }

  report.ok =
    report.keys.failed.length === 0 &&
    report.objects.missing.length === 0 &&
    report.sample.failed.length === 0;
  return report;
}

/** The report in words, for the command line. */
export function describeReport(report: VerifyReport): string {
  const line = (ok: boolean, text: string) => `${ok ? "ok  " : "FAIL"}  ${text}`;
  const details = (items: string[]) => items.slice(0, 20).map((item) => `        ${item}`);
  return [
    line(
      report.keys.failed.length === 0,
      `${report.keys.checked} workspace keys open with the master key`,
    ),
    ...details(report.keys.failed),
    line(
      report.objects.missing.length === 0,
      `${report.objects.checked - report.objects.missing.length} of ${report.objects.checked} stored objects are in their backend`,
    ),
    ...details(report.objects.missing),
    line(
      report.sample.failed.length === 0,
      `${report.sample.checked - report.sample.failed.length} of ${report.sample.checked} sampled files decrypt and match their checksum`,
    ),
    ...details(report.sample.failed),
    ...(report.ownBuckets.length === 0
      ? ["note  No workspace keeps files in a bucket of its own."]
      : [
          `note  ${report.ownBuckets.length} ${report.ownBuckets.length === 1 ? "workspace keeps" : "workspaces keep"} files in a bucket of its own, for it to back up (checked above, not part of this backup):`,
          ...details(
            report.ownBuckets.map(
              (w) =>
                `${w.workspace}: ${w.bucket ?? "no bucket now"} · ${w.objects} ${w.objects === 1 ? "object" : "objects"}`,
            ),
          ),
        ]),
    "",
    report.ok
      ? "The database, the storage and the master key belong together."
      : "This backup does not restore cleanly: see above.",
  ].join("\n");
}
