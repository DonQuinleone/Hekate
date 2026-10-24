import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { type Audit, systemActor } from "./audit.ts";
import type { Storage } from "./storage.ts";

const {
  captionTracks,
  commentAttachments,
  blobs,
  files,
  renditions,
  renditionSegments,
  peakLevels,
  loudness,
  spectrograms,
  spectrogramVariants,
  filePages,
  organisations,
  storageFindings,
  ticketAttachments,
  uploads,
  workspaceExports,
} = schema;

/** Uploads that may still finish: their keys and blobs belong to them, not to the sweep. */
const activeUpload = inArray(uploads.status, ["open", "completing"]);

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

  /**
   * Record a sighting, and return the finding. Atomic, so two runs at once (the nightly one and
   * one an admin asked for) never both try to create the same open finding.
   */
  const sight = async (
    kind: Kind,
    backend: string,
    key: string,
    owner: string | null,
    blobId: string | null,
  ) => {
    const [created] = await db
      .insert(storageFindings)
      .values({
        kind,
        backend,
        key,
        ownerOrganisationId: owner,
        blobId,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoNothing({
        target: [storageFindings.kind, storageFindings.backend, storageFindings.key],
        where: isNull(storageFindings.resolvedAt),
      })
      .returning();
    if (created) return created;
    const [existing] = await db
      .update(storageFindings)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(storageFindings.kind, kind),
          eq(storageFindings.backend, backend),
          eq(storageFindings.key, key),
          isNull(storageFindings.resolvedAt),
        ),
      )
      .returning();
    if (!existing) throw new Error("Finding was neither created nor found");
    return existing;
  };

  /** Keys an organisation's unfinished uploads will write to, in one backend. */
  const uploadKeys = async (owner: string, backend: string) =>
    new Set(
      (
        await db
          .select({ key: uploads.key })
          .from(uploads)
          .where(inOrg(uploads, owner, eq(uploads.backend, backend), activeUpload))
      ).map((u) => u.key),
    );

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

    // What the backend holds, grouped by the organisation in each key. A targeted run lists
    // only its own organisations' keys, never the whole backend.
    const stored = new Map<string, string[]>();
    for (const prefix of scope ? [...scope].map((o) => `org/${o}/`) : ["org/"]) {
      for await (const object of backend.list(prefix)) {
        const owner = ownerOf(object.key);
        if (!owner) continue;
        stored.set(owner, [...(stored.get(owner) ?? []), object.key]);
      }
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
      const diff = diffKeys(
        stored.get(owner) ?? [],
        recorded.map((r) => r.key),
      );
      // An upload stuck mid-completion stays recoverable for days; its object is not an orphan.
      const pending = living.has(owner) ? await uploadKeys(owner, name) : new Set<string>();
      const orphans = diff.orphans.filter((key) => !pending.has(key));
      const missing = diff.missing;
      for (const key of orphans) {
        report.orphanObjects += 1;
        await sight("orphan_object", name, key, owner, null);
      }
      for (const key of missing) {
        report.missingObjects += 1;
        const blob = recorded.find((r) => r.key === key);
        const finding = await sight("missing_object", name, key, owner, blob?.id ?? null);
        // Reported once, and retried by later runs until the access log has it.
        if (!finding.reportedAt) {
          console.error(`Storage: blob ${blob?.id} in ${name} has no bytes at ${key}`);
          await audit.record(owner, systemActor, {
            action: "storage.missing",
            details: { backend: name, key, blobId: blob?.id },
          });
          await db
            .update(storageFindings)
            .set({ reportedAt: now })
            .where(eq(storageFindings.id, finding.id));
        }
      }
      if (!living.has(owner)) continue;

      // Blobs nothing uses: no file, rendition, segment, peak level, loudness series,
      // spectrogram, page, comment attachment or live upload points at them.
      const unused = await db
        .select({ id: blobs.id, key: blobs.key })
        .from(blobs)
        .where(
          inOrg(
            blobs,
            owner,
            eq(blobs.backend, name),
            lt(blobs.createdAt, settled),
            notExists(
              db
                .select({ x: sql`1` })
                .from(files)
                .where(
                  inOrg(
                    files,
                    owner,
                    or(eq(files.blobId, blobs.id), eq(files.filmstripBlobId, blobs.id)),
                  ),
                ),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(renditions)
                .where(inOrg(renditions, owner, eq(renditions.initBlobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(renditionSegments)
                .where(inOrg(renditionSegments, owner, eq(renditionSegments.blobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(peakLevels)
                .where(inOrg(peakLevels, owner, eq(peakLevels.blobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(loudness)
                .where(inOrg(loudness, owner, eq(loudness.blobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(spectrograms)
                .where(inOrg(spectrograms, owner, eq(spectrograms.blobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(spectrogramVariants)
                .where(inOrg(spectrogramVariants, owner, eq(spectrogramVariants.blobId, blobs.id))),
            ),
            notExists(
              db
                .select({ x: sql`1` })
                .from(filePages)
                .where(
                  inOrg(
                    filePages,
                    owner,
                    or(eq(filePages.blobId, blobs.id), eq(filePages.thumbBlobId, blobs.id)),
                  ),
                ),
            ),
            // Nor a comment's attachment (#133).
            notExists(
              db
                .select({ x: sql`1` })
                .from(commentAttachments)
                .where(inOrg(commentAttachments, owner, eq(commentAttachments.blobId, blobs.id))),
            ),
            // Nor a ticket's attachment (#181).
            notExists(
              db
                .select({ x: sql`1` })
                .from(ticketAttachments)
                .where(inOrg(ticketAttachments, owner, eq(ticketAttachments.blobId, blobs.id))),
            ),
            // Nor a video's caption file (#146).
            notExists(
              db
                .select({ x: sql`1` })
                .from(captionTracks)
                .where(inOrg(captionTracks, owner, eq(captionTracks.blobId, blobs.id))),
            ),
            // Nor a part of a workspace's export (#186), which goes when its week is over.
            notExists(
              db
                .select({ x: sql`1` })
                .from(workspaceExports)
                .where(
                  inOrg(
                    workspaceExports,
                    owner,
                    sql`${blobs.id} = any(${workspaceExports.blobIds})`,
                  ),
                ),
            ),
            // Nor the workspace's logo (#185), named in its branding.
            notExists(
              db
                .select({ x: sql`1` })
                .from(organisations)
                .where(
                  and(
                    eq(organisations.id, owner),
                    sql`${organisations.branding} -> 'logo' ->> 'blobId' = ${blobs.id}::text`,
                  ),
                ),
            ),
            // Nor an upload that may still finish and make a file of it.
            notExists(
              db
                .select({ x: sql`1` })
                .from(uploads)
                .where(inOrg(uploads, owner, eq(uploads.blobId, blobs.id), activeUpload)),
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
        const owner = finding.ownerOrganisationId;
        const alive = owner !== null && living.has(owner);
        if (finding.kind === "orphan_object" && alive) {
          // Look again just before deleting: a blob or a resumed upload may have claimed it.
          const [claimed] = await db
            .select({ id: blobs.id })
            .from(blobs)
            .where(inOrg(blobs, owner, eq(blobs.backend, name), eq(blobs.key, finding.key)));
          if (claimed || (await uploadKeys(owner, name)).has(finding.key)) {
            await db
              .update(storageFindings)
              .set({ resolvedAt: now, resolution: "claimed" })
              .where(eq(storageFindings.id, finding.id));
            continue;
          }
        }
        // Written before the removal, like every other access log entry: a removal that
        // could not be logged does not happen.
        if (alive) {
          await audit.record(owner, systemActor, {
            action: "storage.remove",
            details: {
              backend: name,
              key: finding.key,
              kind: finding.kind,
              blobId: finding.blobId,
            },
          });
        }
        try {
          if (finding.kind === "orphan_object") await backend.delete(finding.key);
          else await storage.remove(owner ?? "", finding.blobId ?? "");
        } catch (error) {
          // Storage down, or a blob taken into use since it was found (the database refuses
          // that removal): leave the finding open. The next run retries it, or sees it gone.
          console.warn(`Storage: could not remove ${finding.key} from ${name}: ${String(error)}`);
          continue;
        }
        report.removed += 1;
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
