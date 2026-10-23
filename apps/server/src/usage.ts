import { type Database, inOrg, schema } from "@hekate/db";
import {
  limitRefusal,
  monthOf,
  WARN_AT,
  type WorkspaceLimits,
  type WorkspaceUsage,
} from "@hekate/shared";
import { count, eq, gt, gte, inArray, isNull, sql, sum } from "drizzle-orm";
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
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  return row ?? { storageQuota: null, memberLimit: null };
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
    })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for("update");
  return row ?? { storageQuota: null, memberLimit: null };
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

/**
 * Whether the member limit has room for one more, in the transaction that adds them: the
 * refusal if not. Inviting counts the invitations waiting, which take a place each; accepting
 * one, or a first sign-in through the workspace's directory or provider, counts members only.
 */
export async function memberRoom(
  tx: Tx,
  organisationId: string,
  by: "invitation" | "joining",
): Promise<string | null> {
  const { memberLimit } = await locked(tx, organisationId);
  if (memberLimit === null) return null;
  const { members: joined, invited } = await membersInUse(tx, organisationId);
  const taken = by === "invitation" ? joined + invited : joined;
  return taken >= memberLimit
    ? limitRefusal("members", Math.min(taken, memberLimit), memberLimit)
    : null;
}

/** Refuse a new member the limit has no room for (see memberRoom). */
export async function assertMemberRoom(
  tx: Tx,
  organisationId: string,
  by: "invitation" | "joining",
) {
  const refusal = await memberRoom(tx, organisationId, by);
  if (refusal) throw new CodedException(409, "member_limit", refusal);
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
 * Count the month so far for every workspace (hourly): storage now and its peak, people and
 * projects, and the plays (a player starting a session) and downloads the access log holds,
 * counted on from the last event already counted. Returns how many workspaces it counted.
 */
export async function refreshUsage(db: Database, now = new Date()): Promise<number> {
  const month = monthOf(now);
  const monthStart = new Date(`${month}T00:00:00Z`);
  const workspaces = await db.select({ id: organisations.id }).from(organisations);
  for (const { id } of workspaces) {
    const usage = await workspaceUsageOf(db, id, now);
    const [row] = await db
      .select()
      .from(usageRows)
      .where(inOrg(usageRows, id, eq(usageRows.month, month)));
    const [counted] = await db
      .select({
        plays: sql<number>`count(*) filter (where ${accessEvents.action} = 'stream.session')::int`,
        downloads: sql<number>`count(*) filter (where ${accessEvents.action} = 'download')::int`,
        // Lower-case hexadecimal sorts as the ids do.
        through: sql<string | null>`max(${accessEvents.id}::text)`,
      })
      .from(accessEvents)
      .where(
        inOrg(
          accessEvents,
          id,
          inArray(accessEvents.action, ["stream.session", "download"]),
          gte(accessEvents.id, firstIdAt(monthStart)),
          row?.countedThrough ? gt(accessEvents.id, row.countedThrough) : undefined,
        ),
      );
    const values = {
      storageBytes: usage.storageBytes,
      storagePeak: Math.max(row?.storagePeak ?? 0, usage.storageBytes),
      members: usage.members,
      guests: usage.guests,
      projects: usage.projects,
      plays: (row?.plays ?? 0) + (counted?.plays ?? 0),
      downloads: (row?.downloads ?? 0) + (counted?.downloads ?? 0),
      countedThrough: counted?.through ?? row?.countedThrough ?? null,
      measuredAt: now,
    };
    if (row)
      await db
        .update(usageRows)
        .set(values)
        // Only over the row as read: a refresh running at once does not count twice.
        .where(
          inOrg(
            usageRows,
            id,
            eq(usageRows.id, row.id),
            row.countedThrough
              ? eq(usageRows.countedThrough, row.countedThrough)
              : isNull(usageRows.countedThrough),
          ),
        );
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
