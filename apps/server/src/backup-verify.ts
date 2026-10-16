import { createHash, randomInt } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { asc } from "drizzle-orm";
import type { Keyring } from "./keyring.ts";
import type { Storage } from "./storage.ts";

const { blobs, organisationKeys, organisations } = schema;

export interface VerifyReport {
  /** Organisation key versions that open with the configured master keys. */
  keys: { checked: number; failed: string[] };
  /** Blobs whose bytes are in their backend. */
  objects: { checked: number; missing: string[] };
  /** Blobs read in full and decrypted, compared with their checksum where it is known. */
  sample: { checked: number; failed: string[] };
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
    for (const blob of await db
      .select({ id: blobs.id, backend: blobs.backend, key: blobs.key, sha256: blobs.sha256 })
      .from(blobs)
      .where(inOrg(blobs, workspace.id))
      .orderBy(asc(blobs.id)))
      recorded.push({ organisationId: workspace.id, ...blob });
  }

  for (const blob of recorded) {
    report.objects.checked += 1;
    const backend = storage.backends.has(blob.backend) ? storage.backends.get(blob.backend) : null;
    if (!backend) {
      report.objects.missing.push(`${blob.key}: backend "${blob.backend}" is not configured`);
      continue;
    }
    if (!(await backend.head(blob.key))) report.objects.missing.push(`${blob.backend}:${blob.key}`);
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
    "",
    report.ok
      ? "The database, the storage and the master key belong together."
      : "This backup does not restore cleanly: see above.",
  ].join("\n");
}
