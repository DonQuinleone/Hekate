import { type Database, schema } from "@hekate/db";
import { and, desc, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { type ReconcileReport, reconcileStorage } from "./reconcile.ts";
import type { Storage } from "./storage.ts";

const { storageFindings, storageReconciliations } = schema;

export interface WorkspaceStorage {
  /** Bytes and stored objects per backend, for this workspace. */
  backends: { name: string; bytes: number; objects: number }[];
  /** Bytes per project: originals and everything made from them. */
  projects: { id: string; name: string; bytes: number }[];
  bytes: number;
  reconciliation: {
    /** What the nightly run does with bytes nothing uses (STORAGE_RECONCILE). */
    removing: boolean;
    lastRun: { startedAt: string; finishedAt: string | null } | null;
    /** Open findings for this workspace. */
    orphans: number;
    unused: number;
    missing: number;
    /** Objects removed in the last 30 days. */
    removed: number;
  };
}

/**
 * What a workspace keeps in storage, and what the reconciliation found in it (#163). Bytes
 * are the plaintext sizes the blobs record. A project's share is every blob its files use:
 * originals, renditions and their segments, pages, peaks, loudness and spectrograms. Every
 * table is read within the workspace.
 */
export async function workspaceStorage(
  db: Database,
  organisationId: string,
  removing: boolean,
): Promise<WorkspaceStorage> {
  const org = organisationId;
  const byBackend = await db.execute<{ name: string; bytes: string; objects: string }>(sql`
    select backend as name, coalesce(sum(byte_size), 0)::text as bytes, count(*)::text as objects
    from blobs where organisation_id = ${org} group by backend order by backend`);
  const byProject = await projectBytes(db, org);

  // Findings and runs are instance-wide records; these read only this workspace's.
  const open = (kind: "orphan_object" | "unreferenced_blob" | "missing_object") =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(storageFindings)
      .where(
        and(
          eq(storageFindings.ownerOrganisationId, org),
          eq(storageFindings.kind, kind),
          isNull(storageFindings.resolvedAt),
        ),
      )
      .then((rows) => rows[0]?.n ?? 0);
  const [removed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(storageFindings)
    .where(
      and(
        eq(storageFindings.ownerOrganisationId, org),
        eq(storageFindings.resolution, "removed"),
        gte(storageFindings.resolvedAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
      ),
    );
  const [lastRun] = await db
    .select({
      startedAt: storageReconciliations.startedAt,
      finishedAt: storageReconciliations.finishedAt,
    })
    .from(storageReconciliations)
    // The last that finished: one still running, or one that failed, says nothing yet.
    .where(
      and(
        isNotNull(storageReconciliations.finishedAt),
        or(
          isNull(storageReconciliations.scopeOrganisationId),
          eq(storageReconciliations.scopeOrganisationId, org),
        ),
      ),
    )
    .orderBy(desc(storageReconciliations.startedAt))
    .limit(1);

  const backends = [...byBackend].map((b) => ({
    name: b.name,
    bytes: Number(b.bytes),
    objects: Number(b.objects),
  }));
  return {
    backends,
    projects: [...byProject].map((p) => ({ id: p.id, name: p.name, bytes: Number(p.bytes) })),
    bytes: backends.reduce((sum, b) => sum + b.bytes, 0),
    reconciliation: {
      removing,
      lastRun: lastRun
        ? {
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          }
        : null,
      orphans: await open("orphan_object"),
      unused: await open("unreferenced_blob"),
      missing: await open("missing_object"),
      removed: removed?.n ?? 0,
    },
  };
}

/** A reconciliation, recorded as a run: the whole instance, or one workspace. */
export async function recordedReconciliation(
  deps: { db: Database; storage: Storage; audit: Audit },
  options: { remove: boolean; organisationId?: string },
): Promise<ReconcileReport[]> {
  const [run] = await deps.db
    .insert(storageReconciliations)
    .values({
      scopeOrganisationId: options.organisationId ?? null,
      startedAt: new Date(),
      removing: options.remove,
    })
    .returning({ id: storageReconciliations.id });
  const reports = await reconcileStorage(deps, {
    remove: options.remove,
    ...(options.organisationId ? { organisations: [options.organisationId] } : {}),
  });
  if (run)
    await deps.db
      .update(storageReconciliations)
      .set({ finishedAt: new Date() })
      .where(eq(storageReconciliations.id, run.id));
  return reports;
}

/**
 * Bytes per project, or for one project: every blob its files use, originals, renditions and
 * their segments, pages, peaks, loudness and spectrograms. Read within the workspace.
 */
export function projectBytes(db: Database, organisationId: string, projectId?: string) {
  const org = organisationId;
  return db.execute<{ id: string; name: string; bytes: string }>(sql`
    with used as (
      select f.project_id, f.blob_id from files f
        where f.organisation_id = ${org} and f.blob_id is not null
      union select f.project_id, r.init_blob_id from renditions r
        join files f on f.id = r.file_id and f.organisation_id = ${org}
        where r.organisation_id = ${org}
      union select f.project_id, s.blob_id from rendition_segments s
        join renditions r on r.id = s.rendition_id and r.organisation_id = ${org}
        join files f on f.id = r.file_id and f.organisation_id = ${org}
        where s.organisation_id = ${org}
      union select f.project_id, p.blob_id from peak_levels p
        join files f on f.id = p.file_id and f.organisation_id = ${org}
        where p.organisation_id = ${org}
      union select f.project_id, p.blob_id from file_pages p
        join files f on f.id = p.file_id and f.organisation_id = ${org}
        where p.organisation_id = ${org}
      union select f.project_id, p.thumb_blob_id from file_pages p
        join files f on f.id = p.file_id and f.organisation_id = ${org}
        where p.organisation_id = ${org} and p.thumb_blob_id is not null
      union select f.project_id, l.blob_id from loudness l
        join files f on f.id = l.file_id and f.organisation_id = ${org}
        where l.organisation_id = ${org} and l.blob_id is not null
      union select f.project_id, s.blob_id from spectrograms s
        join files f on f.id = s.file_id and f.organisation_id = ${org}
        where s.organisation_id = ${org} and s.blob_id is not null
    )
    select p.id, p.name, coalesce(sum(b.byte_size), 0)::text as bytes
    from projects p
    left join used u on u.project_id = p.id
    left join blobs b on b.id = u.blob_id and b.organisation_id = ${org}
    where p.organisation_id = ${org} ${projectId ? sql`and p.id = ${projectId}` : sql``}
    group by p.id, p.name
    order by sum(b.byte_size) desc nulls last, p.name`);
}
