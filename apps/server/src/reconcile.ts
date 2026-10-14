import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, inArray, isNull, lt, notExists, sql } from "drizzle-orm";
import { type Audit, systemActor } from "./audit.ts";
import type { Storage } from "./storage.ts";

const { blobs, files, renditions, renditionSegments, peakLevels, organisations, storageFindings } =
  schema;

/** A finding is acted on only when a run sees it again at least this long after the first. */
export const RECONCILE_GRACE_MS = 24 * 60 * 60 * 1000;

type Kind = (typeof storageFindings.$inferSelect)["kind"];

export interface ReconcileReport {
  backend: string;
  orphanObjects: number;
  unreferencedBlobs: number;
  missingObjects: number;
  removed: number;
}

/** The organisation a key belongs to: keys are `org/<organisation>/<object>`. */
export function ownerOf(key: string): string | null {
  const match = /^org\/([0-9a-f-]{36})\/[^/]+$/.exec(key);
  return match?.[1] ?? null;
}

/**
 * Compare what a backend holds with what the blob table records: keys stored but not
 * recorded, and recorded but not stored.
 */
export function diffKeys(stored: Iterable<string>, recorded: Iterable<string>) {
  const storedSet = new Set(stored);
  const recordedSet = new Set(recorded);
  return {
    orphans: [...storedSet].filter((k) => !recordedSet.has(k)),
    missing: [...recordedSet].filter((k) => !storedSet.has(k)),
  };
}

/**
 * Reconcile every storage backend with the database. Bytes no blob accounts for, and blobs
 * nothing uses, are recorded on first sight and removed only when a run at least a grace
 * period later still finds them, so uploads and jobs in flight are never touched. Blobs
 * whose bytes are missing are reported, never changed: they need a person.
 */
export async function reconcileStorage(
  deps: { db: Database; storage: Storage; audit: Audit },
  options: {
    now?: Date;
    graceMs?: number;
    remove?: boolean;
    /** Limit the sweep to these organisations, for a targeted run. */
    organisations?: string[];
  } = {},
): Promise<ReconcileReport[]> {
  const { db, storage, audit } = deps;
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? RECONCILE_GRACE_MS;
  const remove = options.remove ?? true;
  const settled = new Date(now.getTime() - graceMs);
  const living = new Set(
    (await db.select({ id: organisations.id }).from(organisations)).map((o) => o.id),
  );

  /** Record a sighting; true when the finding is new. */
  const sight = async (
    kind: Kind,
    backend: string,
    key: string,
    owner: string | null,
    blobId: string | null,
  ) => {
    const [existing] = await db
      .select({ id: storageFindings.id })
      .from(storageFindings)
      .where(
        and(
          eq(storageFindings.kind, kind),
          eq(storageFindings.backend, backend),
          eq(storageFindings.key, key),
          isNull(storageFindings.resolvedAt),
        ),
      );
    if (existing) {
      await db
        .update(storageFindings)
        .set({ lastSeenAt: now })
        .where(eq(storageFindings.id, existing.id));
      return false;
    }
    await db.insert(storageFindings).values({
      kind,
      backend,
      key,
      ownerOrganisationId: owner,
      blobId,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return true;
  };

  const scope = options.organisations ? new Set(options.organisations) : null;
  // A targeted run settles only its own organisations' findings.
  const inScope = scope ? inArray(storageFindings.ownerOrganisationId, [...scope]) : undefined;

  const reports: ReconcileReport[] = [];
  for (const name of storage.backends.names()) {
    const backend = storage.backends.get(name);
    const report: ReconcileReport = {
      backend: name,
      orphanObjects: 0,
      unreferencedBlobs: 0,
      missingObjects: 0,
      removed: 0,
    };

    // What the backend holds, grouped by the organisation in each key.
    const stored = new Map<string, string[]>();
    for await (const object of backend.list("org/")) {
      const owner = ownerOf(object.key);
      if (!owner) continue;
      stored.set(owner, [...(stored.get(owner) ?? []), object.key]);
    }

    for (const owner of new Set([...stored.keys(), ...living])) {
      if (scope && !scope.has(owner)) continue;
      // Rows written after this run began may not be listed yet; leave them for next time.
      const recorded = living.has(owner)
        ? await db
            .select({ id: blobs.id, key: blobs.key })
            .from(blobs)
            .where(inOrg(blobs, owner, eq(blobs.backend, name), lt(blobs.createdAt, now)))
        : [];
      const { orphans, missing } = diffKeys(
        stored.get(owner) ?? [],
        recorded.map((r) => r.key),
      );
      for (const key of orphans) {
        report.orphanObjects += 1;
        await sight("orphan_object", name, key, owner, null);
      }
      for (const key of missing) {
        report.missingObjects += 1;
        const blob = recorded.find((r) => r.key === key);
        if (await sight("missing_object", name, key, owner, blob?.id ?? null)) {
          console.error(`Storage: blob ${blob?.id} in ${name} has no bytes at ${key}`);
          await audit.record(owner, systemActor, {
            action: "storage.missing",
            details: { backend: name, key, blobId: blob?.id },
          });
        }
      }
      if (!living.has(owner)) continue;

      // Blobs nothing uses: no file, rendition, segment or peak level points at them.
      const unused = await db
        .select({ id: blobs.id, key: blobs.key })
        .from(blobs)
        .where(
          inOrg(
            blobs,
            owner,
            eq(blobs.backend, name),
            lt(blobs.createdAt, settled),
            notExists(db.select({ x: sql`1` }).from(files).where(eq(files.blobId, blobs.id))),
            notExists(
              db.select({ x: sql`1` }).from(renditions).where(eq(renditions.initBlobId, blobs.id)),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(renditionSegments)
                .where(eq(renditionSegments.blobId, blobs.id)),
            ),
            notExists(
              db.select({ x: sql`1` }).from(peakLevels).where(eq(peakLevels.blobId, blobs.id)),
            ),
          ),
        );
      // A blob whose bytes are missing is reported above; it is never removed as unused.
      for (const blob of unused.filter((b) => !missing.includes(b.key))) {
        report.unreferencedBlobs += 1;
        await sight("unreferenced_blob", name, blob.key, owner, blob.id);
      }
    }

    // Findings this run no longer sees have gone away by themselves.
    await db
      .update(storageFindings)
      .set({ resolvedAt: now, resolution: "gone" })
      .where(
        and(
          eq(storageFindings.backend, name),
          isNull(storageFindings.resolvedAt),
          lt(storageFindings.lastSeenAt, now),
          inScope,
        ),
      );

    if (remove) {
      const due = await db
        .select()
        .from(storageFindings)
        .where(
          and(
            eq(storageFindings.backend, name),
            isNull(storageFindings.resolvedAt),
            inArray(storageFindings.kind, ["orphan_object", "unreferenced_blob"]),
            inScope,
            lt(storageFindings.firstSeenAt, new Date(settled.getTime() + 1)),
          ),
        );
      for (const finding of due) {
        try {
          if (finding.kind === "orphan_object") await backend.delete(finding.key);
          else await storage.remove(finding.ownerOrganisationId ?? "", finding.blobId ?? "");
        } catch (error) {
          // Storage down, or a blob taken into use since it was found (the database refuses
          // that removal): leave the finding open. The next run retries it, or sees it gone.
          console.warn(`Storage: could not remove ${finding.key} from ${name}: ${String(error)}`);
          continue;
        }
        report.removed += 1;
        if (finding.ownerOrganisationId && living.has(finding.ownerOrganisationId)) {
          await audit.record(finding.ownerOrganisationId, systemActor, {
            action: "storage.remove",
            details: {
              backend: name,
              key: finding.key,
              kind: finding.kind,
              blobId: finding.blobId,
            },
          });
        }
        await db
          .update(storageFindings)
          .set({ resolvedAt: now, resolution: "removed" })
          .where(eq(storageFindings.id, finding.id));
      }
    }
    reports.push(report);
  }
  return reports;
}
