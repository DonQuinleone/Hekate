import { type Database, inOrg, schema } from "@hekate/db";
import {
  limitRefusal,
  monthOf,
  WARN_AT,
  type WorkspaceLimits,
  type WorkspaceUsage,
} from "@hekate/shared";
import { count, eq, gt, gte, inArray, isNull, lt, sql, sum } from "drizzle-orm";
import { CodedException } from "./errors.ts";

const { organisations, blobs, uploads, members, invitations, guests, projects } = schema;
const { workspaceUsage: usageRows, accessEvents } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

/**
 * Usage metering and quotas (#175). The limits are read and enforced as things happen: an
 * upload or a new member is refused at the limit, under a lock on the workspace's row, so two
 * at once cannot both slip under it. The month's figures are counted by an hourly job, for the
 * record and for billing (#177).
 */

/** A workspace's limits; none for a workspace that is not there. */
export async function limitsOf(db: Reader, organisationId: string): Promise<WorkspaceLimits> {
  const [row] = await db
    .select({
      storageQuota: organisations.storageQuota,
      memberLimit: organisations.memberLimit,
      projectLimit: organisations.projectLimit,
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  return row ?? { storageQuota: null, memberLimit: null, projectLimit: null };
}

/**
 * The bytes a workspace stores, before encryption, and the uploads still arriving: those take
 * their room from the start, so a quota cannot be overrun by many large uploads begun at once.
 */
export async function storageInUse(db: Reader, organisationId: string): Promise<number> {
  const [[stored], [arriving]] = await Promise.all([
    db
      .select({ bytes: sum(blobs.byteSize) })
      .from(blobs)
      .where(inOrg(blobs, organisationId)),
    db
      .select({ bytes: sum(uploads.byteSize) })
      .from(uploads)
      .where(
        inOrg(
          uploads,
          organisationId,
          inArray(uploads.status, ["open", "completing"]),
          gt(uploads.expiresAt, new Date()),
        ),
      ),
  ]);
  return Number(stored?.bytes ?? 0) + Number(arriving?.bytes ?? 0);
}

/** Its members, and the invitations still waiting, each of which would make one. */
export async function membersInUse(db: Reader, organisationId: string) {
  const [[joined], [waiting]] = await Promise.all([
    db.select({ n: count() }).from(members).where(inOrg(members, organisationId)),
    db
      .select({ n: count() })
      .from(invitations)
      .where(
        inOrg(
          invitations,
          organisationId,
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
        ),
      ),
  ]);
  return { members: joined?.n ?? 0, invited: waiting?.n ?? 0 };
}

/** Hold the workspace's row until the transaction ends: one check-then-add at a time. */
async function locked(tx: Tx, organisationId: string): Promise<WorkspaceLimits> {
  const [row] = await tx
    .select({
      storageQuota: organisations.storageQuota,
      memberLimit: organisations.memberLimit,
      projectLimit: organisations.projectLimit,
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for("update");
  return row ?? { storageQuota: null, memberLimit: null, projectLimit: null };
}

/**
 * Refuse `adding` bytes the quota has no room for, in the transaction that records them. The
 * uploads already arriving count, so the one being recorded must not be written yet.
 */
export async function assertStorageRoom(tx: Tx, organisationId: string, adding: number) {
  const { storageQuota } = await locked(tx, organisationId);
  if (storageQuota === null) return;
  const used = await storageInUse(tx, organisationId);
  if (used + adding > storageQuota)
    throw new CodedException(
      409,
      "storage_quota",
      limitRefusal("storage", Math.min(used, storageQuota), storageQuota),
    );
}

/** How someone would take a place: invited, accepting their invitation, or signing in. */
export type Joining = "invitation" | "accepting" | "provisioning";

/**
 * Whether the member limit has room for one more, in the transaction that adds them: the
 * refusal if not. Every invitation waiting takes a place, so each way in counts members and
 * invitations alike; accepting an invitation discounts only its own, whose place it takes.
 */
export async function memberRoom(
  tx: Tx,
  organisationId: string,
  by: Joining,
): Promise<string | null> {
  const { memberLimit } = await locked(tx, organisationId);
  if (memberLimit === null) return null;
  const { members: joined, invited } = await membersInUse(tx, organisationId);
  const taken = joined + invited - (by === "accepting" ? 1 : 0);
  return taken >= memberLimit
    ? limitRefusal("members", Math.min(taken, memberLimit), memberLimit)
    : null;
}

/** Refuse a new member the limit has no room for (see memberRoom). */
export async function assertMemberRoom(tx: Tx, organisationId: string, by: Joining) {
  const refusal = await memberRoom(tx, organisationId, by);
  if (refusal) throw new CodedException(409, "member_limit", refusal);
}

/** Refuse a new project the workspace's project limit (#177) has no room for, as it is made. */
export async function assertProjectRoom(tx: Tx, organisationId: string) {
  const { projectLimit } = await locked(tx, organisationId);
  if (projectLimit === null || projectLimit === undefined) return;
  const [held] = await tx
    .select({ n: count() })
    .from(projects)
    .where(inOrg(projects, organisationId));
  const n = held?.n ?? 0;
  if (n >= projectLimit)
    throw new CodedException(409, "project_limit", limitRefusal("projects", n, projectLimit));
}

/** What a workspace uses now, against its limits, with the month so far as last counted. */
export async function workspaceUsageOf(
  db: Reader,
  organisationId: string,
  now = new Date(),
): Promise<WorkspaceUsage> {
  const [limits, storageBytes, people, [guestCount], [projectCount], [month]] = await Promise.all([
    limitsOf(db, organisationId),
    storageInUse(db, organisationId),
    membersInUse(db, organisationId),
    db.select({ n: count() }).from(guests).where(inOrg(guests, organisationId)),
    db.select({ n: count() }).from(projects).where(inOrg(projects, organisationId)),
    db
      .select()
      .from(usageRows)
      .where(inOrg(usageRows, organisationId, eq(usageRows.month, monthOf(now)))),
  ]);
  return {
    limits,
    storageBytes,
    members: people.members,
    invited: people.invited,
    guests: guestCount?.n ?? 0,
    projects: projectCount?.n ?? 0,
    month: month
      ? {
          month: month.month,
          storagePeak: Math.max(month.storagePeak, storageBytes),
          plays: month.plays,
          downloads: month.downloads,
          measuredAt: month.measuredAt.toISOString(),
        }
      : null,
  };
}

/** The first UUIDv7 a moment can have: access events from then on sort at or after it. */
export function firstIdAt(at: Date): string {
  const hex = at.getTime().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}

/**
 * How far behind now plays and downloads are counted. An access event's id is made before its
 * transaction commits, so one may become visible after a later one: counting only to a moment
 * this far back leaves time for it to land before the count passes it.
 */
export const COUNT_LAG_MS = 15 * 60_000;

const monthStartOf = (month: string) => new Date(`${month}T00:00:00Z`);
const nextMonthOf = (month: string) => {
  const at = monthStartOf(month);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
};

/** The plays and downloads with ids from `from` (inclusive) to `to` (exclusive). */
async function countBetween(db: Database, organisationId: string, from: string, to: string) {
  if (to <= from) return { plays: 0, downloads: 0 };
  const [counted] = await db
    .select({
      plays: sql<number>`count(*) filter (where ${accessEvents.action} = 'stream.session')::int`,
      downloads: sql<number>`count(*) filter (where ${accessEvents.action} = 'download')::int`,
    })
    .from(accessEvents)
    .where(
      inOrg(
        accessEvents,
        organisationId,
        inArray(accessEvents.action, ["stream.session", "download"]),
        gte(accessEvents.id, from),
        lt(accessEvents.id, to),
      ),
    );
  return { plays: counted?.plays ?? 0, downloads: counted?.downloads ?? 0 };
}

/** Only over the row as read: a refresh running at once does not count twice. */
const asRead = (row: typeof usageRows.$inferSelect) =>
  inOrg(
    usageRows,
    row.organisationId,
    eq(usageRows.id, row.id),
    row.countedThrough
      ? eq(usageRows.countedThrough, row.countedThrough)
      : isNull(usageRows.countedThrough),
  );

/**
 * Count the month so far for every workspace (hourly): storage now and its peak, people and
 * projects, and the plays (a player starting a session) and downloads the access log holds,
 * counted on from where the last count stopped (`countedThrough`, the first id it did not
 * count) to COUNT_LAG_MS ago. A month just ended is counted to its end first. Returns how many
 * workspaces it counted.
 */
export async function refreshUsage(db: Database, now = new Date()): Promise<number> {
  const month = monthOf(now);
  const monthStart = monthStartOf(month);
  const settled = new Date(now.getTime() - COUNT_LAG_MS);
  const previous = monthOf(new Date(monthStart.getTime() - 1));
  const workspaces = await db.select({ id: organisations.id }).from(organisations);
  for (const { id } of workspaces) {
    // The month before, to its end, where its last count stopped short of it.
    const [before] = await db
      .select()
      .from(usageRows)
      .where(inOrg(usageRows, id, eq(usageRows.month, previous)));
    const end = firstIdAt(monthStart);
    if (before && (before.countedThrough ?? "") < end) {
      const to = firstIdAt(new Date(Math.min(settled.getTime(), monthStart.getTime())));
      const from = before.countedThrough ?? firstIdAt(monthStartOf(previous));
      const counted = await countBetween(db, id, from, to);
      if (to > from)
        await db
          .update(usageRows)
          .set({
            plays: before.plays + counted.plays,
            downloads: before.downloads + counted.downloads,
            countedThrough: to,
          })
          .where(asRead(before));
    }

    const usage = await workspaceUsageOf(db, id, now);
    const [row] = await db
      .select()
      .from(usageRows)
      .where(inOrg(usageRows, id, eq(usageRows.month, month)));
    const from = row?.countedThrough ?? firstIdAt(monthStart);
    const to = firstIdAt(new Date(Math.min(settled.getTime(), nextMonthOf(month).getTime())));
    const counted = await countBetween(db, id, from, to);
    const values = {
      storageBytes: usage.storageBytes,
      storagePeak: Math.max(row?.storagePeak ?? 0, usage.storageBytes),
      members: usage.members,
      guests: usage.guests,
      projects: usage.projects,
      plays: (row?.plays ?? 0) + counted.plays,
      downloads: (row?.downloads ?? 0) + counted.downloads,
      countedThrough: to > from ? to : (row?.countedThrough ?? null),
      measuredAt: now,
    };
    if (row) await db.update(usageRows).set(values).where(asRead(row));
    else
      await db
        .insert(usageRows)
        .values({ organisationId: id, month, ...values })
        .onConflictDoNothing({ target: [usageRows.organisationId, usageRows.month] });
  }
  return workspaces.length;
}

/** Workspaces at 90% of their storage quota or more, for the instance's overview. */
export async function nearQuota(db: Database) {
  const limited = await db
    .select({
      id: organisations.id,
      name: organisations.name,
      quota: organisations.storageQuota,
    })
    .from(organisations)
    .where(sql`${organisations.storageQuota} is not null`);
  const near: { id: string; name: string; used: number; quota: number }[] = [];
  for (const w of limited) {
    if (w.quota === null) continue;
    const used = await storageInUse(db, w.id);
    if (used >= w.quota * WARN_AT) near.push({ id: w.id, name: w.name, used, quota: w.quota });
  }
  return near;
}
