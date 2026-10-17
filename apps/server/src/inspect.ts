import { type Database, inOrg, schema } from "@hekate/db";
import {
  type AccessTally,
  type ErrorSource,
  type FileInspection,
  type InspectedJob,
  type ReviewInspection,
  readGrant,
  type SessionInspection,
} from "@hekate/shared";
import { and, asc, count, desc, eq, gte, inArray, max, type SQL, sql } from "drizzle-orm";

/**
 * Debug tools' inspectors (#159): what the system holds for a file, a review or a session,
 * for operators. Each first finds which workspace holds the row, the one read across
 * workspaces, as the instance side alone may (decision 066); every read after it is scoped
 * to that workspace with `inOrg`. Null when there is no such row.
 */

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

/** The access log for one workspace, by action, newest first. */
async function accessTally(
  db: Database,
  organisationId: string,
  ...conditions: (SQL | undefined)[]
): Promise<AccessTally[]> {
  const last = max(schema.accessEvents.occurredAt);
  const rows = await db
    .select({ action: schema.accessEvents.action, count: count(), last })
    .from(schema.accessEvents)
    .where(inOrg(schema.accessEvents, organisationId, ...conditions))
    .groupBy(schema.accessEvents.action)
    .orderBy(desc(last));
  return rows.map((r) => ({
    action: r.action,
    count: r.count,
    last: r.last ? iso(r.last) : "",
  }));
}

async function placeOf(db: Database, organisationId: string, projectId: string) {
  const [row] = await db
    .select({ workspace: schema.organisations.name, project: schema.projects.name })
    .from(schema.projects)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.projects.organisationId))
    .where(inOrg(schema.projects, organisationId, eq(schema.projects.id, projectId)));
  return {
    workspace: { id: organisationId, name: row?.workspace ?? "" },
    project: { id: projectId, name: row?.project ?? "" },
  };
}

/**
 * The queue's jobs whose data names this file in its workspace; null when the queue cannot be
 * read. Both ids are matched, so another workspace's job naming the same id is never shown.
 */
async function jobsOf(
  db: Database,
  organisationId: string,
  fileId: string,
): Promise<InspectedJob[] | null> {
  try {
    const rows = await db.execute<{
      id: string;
      name: string;
      state: string;
      retry_count: number;
      created_on: Date | string;
      completed_on: Date | string | null;
    }>(
      sql`select id, name, state, retry_count, created_on, completed_on from pgboss.job
          where data->>'fileId' = ${fileId} and data->>'organisationId' = ${organisationId}
          order by created_on desc limit 50`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      retries: r.retry_count,
      createdAt: new Date(r.created_on).toISOString(),
      completedAt: r.completed_on ? new Date(r.completed_on).toISOString() : null,
    }));
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code;
    // No queue yet (a fresh database, before the worker first started): nothing touched it.
    if (code === "42P01" || code === "3F000") return [];
    console.error("The job queue could not be read:", error);
    return null;
  }
}

export async function inspectFile(db: Database, id: string): Promise<FileInspection | null> {
  const [held] = await db
    .select({ organisationId: schema.files.organisationId })
    .from(schema.files)
    .where(eq(schema.files.id, id));
  if (!held) return null;
  const org = held.organisationId;
  const [file] = await db
    .select({
      file: schema.files,
      uploadedBy: schema.users.name,
    })
    .from(schema.files)
    .leftJoin(schema.users, eq(schema.users.id, schema.files.uploadedBy))
    .where(inOrg(schema.files, org, eq(schema.files.id, id)));
  if (!file) return null;
  const f = file.file;
  const [blob] = await db
    .select()
    .from(schema.blobs)
    .where(inOrg(schema.blobs, org, eq(schema.blobs.id, f.blobId)));
  const renditions = await db
    .select()
    .from(schema.renditions)
    .where(inOrg(schema.renditions, org, eq(schema.renditions.fileId, id)))
    .orderBy(asc(schema.renditions.bandwidth));
  const segments =
    renditions.length === 0
      ? []
      : await db
          .select({ renditionId: schema.renditionSegments.renditionId, n: count() })
          .from(schema.renditionSegments)
          .where(
            inOrg(
              schema.renditionSegments,
              org,
              inArray(
                schema.renditionSegments.renditionId,
                renditions.map((r) => r.id),
              ),
            ),
          )
          .groupBy(schema.renditionSegments.renditionId);
  const [pages] = await db
    .select({ n: count() })
    .from(schema.filePages)
    .where(inOrg(schema.filePages, org, eq(schema.filePages.fileId, id)));
  const errors = await db
    .select({
      reference: schema.errorReports.reference,
      occurredAt: schema.errorReports.occurredAt,
      source: schema.errorReports.source,
      location: schema.errorReports.location,
      message: schema.errorReports.message,
    })
    .from(schema.errorReports)
    .where(
      and(
        eq(schema.errorReports.organisationId, org),
        sql`${schema.errorReports.context}->>'fileId' = ${id}`,
      ),
    )
    .orderBy(desc(schema.errorReports.occurredAt))
    .limit(20);
  return {
    ...(await placeOf(db, org, f.projectId)),
    id,
    name: f.name,
    kind: f.kind,
    contentType: f.contentType,
    byteSize: f.byteSize,
    createdAt: iso(f.createdAt),
    uploadedBy: file.uploadedBy,
    streamStatus: f.streamStatus,
    analysisStatus: f.analysisStatus,
    pageCount: f.pageCount,
    pagesDrawn: pages?.n ?? 0,
    blob: {
      id: f.blobId,
      backend: blob?.backend ?? "",
      key: blob?.key ?? "",
      byteSize: blob?.byteSize ?? 0,
      sha256: blob?.sha256 ?? null,
      keyVersion: blob?.keyVersion ?? 0,
    },
    renditions: renditions.map((r) => ({
      name: r.name,
      codecs: r.codecs,
      bandwidth: r.bandwidth,
      width: r.width,
      height: r.height,
      segments: segments.find((s) => s.renditionId === r.id)?.n ?? 0,
      keyVersion: r.keyVersion,
    })),
    jobs: await jobsOf(db, org, id),
    errors: errors.map((e) => ({
      ...e,
      source: e.source as ErrorSource,
      occurredAt: iso(e.occurredAt),
      workspace: null,
    })),
    access: await accessTally(db, org, eq(schema.accessEvents.fileId, id)),
  };
}

export async function inspectReview(db: Database, id: string): Promise<ReviewInspection | null> {
  const [held] = await db
    .select({ organisationId: schema.reviews.organisationId })
    .from(schema.reviews)
    .where(eq(schema.reviews.id, id));
  if (!held) return null;
  const org = held.organisationId;
  const [row] = await db
    .select({ review: schema.reviews, createdBy: schema.users.name })
    .from(schema.reviews)
    .leftJoin(schema.users, eq(schema.users.id, schema.reviews.createdBy))
    .where(inOrg(schema.reviews, org, eq(schema.reviews.id, id)));
  if (!row) return null;
  const r = row.review;
  const items = await db
    .select({
      id: schema.reviewItems.id,
      file: schema.files.name,
      track: schema.tracks.name,
    })
    .from(schema.reviewItems)
    .leftJoin(schema.files, eq(schema.files.id, schema.reviewItems.fileId))
    .leftJoin(schema.tracks, eq(schema.tracks.id, schema.reviewItems.trackId))
    .where(inOrg(schema.reviewItems, org, eq(schema.reviewItems.reviewId, id)))
    .orderBy(asc(schema.reviewItems.position), asc(schema.reviewItems.id));
  const reviewers = await db
    .select({
      id: schema.reviewReviewers.id,
      guestId: schema.reviewReviewers.guestId,
      userName: schema.users.name,
      userEmail: schema.users.email,
      guestName: schema.guests.name,
      guestEmail: schema.guests.email,
      permissions: schema.reviewReviewers.permissions,
      viewedAt: schema.reviewReviewers.viewedAt,
      submittedAt: schema.reviewReviewers.submittedAt,
    })
    .from(schema.reviewReviewers)
    .leftJoin(schema.users, eq(schema.users.id, schema.reviewReviewers.userId))
    .leftJoin(schema.guests, eq(schema.guests.id, schema.reviewReviewers.guestId))
    .where(inOrg(schema.reviewReviewers, org, eq(schema.reviewReviewers.reviewId, id)))
    .orderBy(asc(schema.reviewReviewers.position), asc(schema.reviewReviewers.id));
  const reviewerIds = reviewers.map((v) => v.id);
  const opens =
    reviewerIds.length === 0
      ? []
      : await db
          .select({ reviewerId: schema.reviewItemOpens.reviewerId, n: count() })
          .from(schema.reviewItemOpens)
          .where(
            inOrg(
              schema.reviewItemOpens,
              org,
              inArray(schema.reviewItemOpens.reviewerId, reviewerIds),
            ),
          )
          .groupBy(schema.reviewItemOpens.reviewerId);
  const guestIds = reviewers.flatMap((v) => (v.guestId ? [v.guestId] : []));
  const sessions =
    guestIds.length === 0
      ? []
      : await db
          .select({
            guestId: schema.guestSessions.guestId,
            n: count(),
            last: max(schema.guestSessions.lastSeenAt),
          })
          .from(schema.guestSessions)
          .where(inOrg(schema.guestSessions, org, inArray(schema.guestSessions.guestId, guestIds)))
          .groupBy(schema.guestSessions.guestId);
  return {
    ...(await placeOf(db, org, r.projectId)),
    id,
    title: r.title,
    kind: r.kind,
    status: r.status,
    outcome: r.outcome ?? null,
    createdAt: iso(r.createdAt),
    createdBy: row.createdBy,
    dueAt: isoOrNull(r.dueAt),
    completedAt: isoOrNull(r.completedAt),
    items: items.map((i) => ({ id: i.id, name: i.file ?? i.track ?? "" })),
    reviewers: reviewers.map((v) => {
      const session = v.guestId ? sessions.find((s) => s.guestId === v.guestId) : undefined;
      return {
        id: v.id,
        name: v.guestName ?? v.userName ?? "",
        email: v.guestEmail ?? v.userEmail ?? "",
        guest: !!v.guestId,
        permissions: readGrant(v.permissions),
        viewedAt: isoOrNull(v.viewedAt),
        submittedAt: isoOrNull(v.submittedAt),
        opened: opens.find((o) => o.reviewerId === v.id)?.n ?? 0,
        sessions: v.guestId
          ? { count: session?.n ?? 0, lastSeenAt: session?.last ? iso(session.last) : null }
          : null,
      };
    }),
    access: await accessTally(db, org, eq(schema.accessEvents.reviewId, id)),
  };
}

const GUEST_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function inspectSession(db: Database, id: string): Promise<SessionInspection | null> {
  if (GUEST_SESSION.test(id)) {
    const [held] = await db
      .select({ organisationId: schema.guestSessions.organisationId })
      .from(schema.guestSessions)
      .where(eq(schema.guestSessions.id, id));
    if (held) return guestSession(db, held.organisationId, id);
  }
  const [row] = await db
    .select({
      session: schema.authSessions,
      name: schema.users.name,
      email: schema.users.email,
      workspace: schema.organisations.name,
    })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .leftJoin(
      schema.organisations,
      eq(schema.organisations.id, schema.authSessions.activeOrganisationId),
    )
    .where(eq(schema.authSessions.id, id));
  if (!row) return null;
  const s = row.session;
  // Before its first request in a workspace, a session works in the earliest of its account's,
  // as `organisationFor` decides.
  const [first] = s.activeOrganisationId
    ? []
    : await db
        .select({ id: schema.organisations.id, name: schema.organisations.name })
        .from(schema.members)
        .innerJoin(schema.organisations, eq(schema.organisations.id, schema.members.organisationId))
        .where(eq(schema.members.userId, s.userId))
        .orderBy(asc(schema.members.createdAt))
        .limit(1);
  const org = s.activeOrganisationId ?? first?.id ?? null;
  return {
    id,
    kind: "member",
    who: { name: row.name, email: row.email },
    workspace: org ? { id: org, name: row.workspace ?? first?.name ?? "" } : null,
    createdAt: iso(s.createdAt),
    expiresAt: iso(s.expiresAt),
    lastUsedAt: iso(s.updatedAt),
    ended: false,
    factor: s.factor,
    ipAddress: s.ipAddress,
    userAgent: s.userAgent,
    access: org
      ? await accessTally(
          db,
          org,
          eq(schema.accessEvents.userId, s.userId),
          gte(schema.accessEvents.occurredAt, s.createdAt),
        )
      : [],
  };
}

async function guestSession(
  db: Database,
  org: string,
  id: string,
): Promise<SessionInspection | null> {
  const [row] = await db
    .select({
      session: schema.guestSessions,
      name: schema.guests.name,
      email: schema.guests.email,
      workspace: schema.organisations.name,
    })
    .from(schema.guestSessions)
    .innerJoin(schema.guests, eq(schema.guests.id, schema.guestSessions.guestId))
    .innerJoin(
      schema.organisations,
      eq(schema.organisations.id, schema.guestSessions.organisationId),
    )
    .where(inOrg(schema.guestSessions, org, eq(schema.guestSessions.id, id)));
  if (!row) return null;
  const s = row.session;
  return {
    id,
    kind: "guest",
    who: { name: row.name, email: row.email },
    workspace: { id: org, name: row.workspace },
    createdAt: iso(s.createdAt),
    expiresAt: iso(s.expiresAt),
    lastUsedAt: isoOrNull(s.lastSeenAt),
    ended: !!s.revokedAt,
    factor: null,
    ipAddress: null,
    userAgent: null,
    access: await accessTally(
      db,
      org,
      eq(schema.accessEvents.guestId, s.guestId),
      gte(schema.accessEvents.occurredAt, s.createdAt),
    ),
  };
}
