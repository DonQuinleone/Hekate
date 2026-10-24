import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  type DownloadKind,
  entitled,
  type ForensicStatus,
  type TraceResult,
  workspaceSettingsOf,
} from "@hekate/shared";
import { count, eq } from "drizzle-orm";
import type { Keyring } from "./keyring.ts";
import { forensicKey } from "./media/forensic.ts";
import type { MarkGroup } from "./media/forensic-audio.ts";
import { workspacePlanOf } from "./plans.ts";

const { forensicMarks, organisations, reviews } = schema;

type Reader = Pick<Database, "select">;

/**
 * Forensic marks (#32, decision 239), as the workspace keeps them: whether its recordings'
 * downloads are marked, a mark made for each, and the marks a suspected leak is compared with.
 */

/** Forensic marking as the workspace has it: its plan's, its owners' choice, its marks. */
export async function forensicStatus(
  db: Reader,
  organisationId: string,
  billing: boolean,
): Promise<ForensicStatus> {
  const [{ entitlements }, [row], [made]] = await Promise.all([
    workspacePlanOf(db, organisationId, billing),
    db
      .select({ settings: organisations.settings })
      .from(organisations)
      .where(eq(organisations.id, organisationId)),
    db.select({ n: count() }).from(forensicMarks).where(inOrg(forensicMarks, organisationId)),
  ]);
  return {
    included: entitled(entitlements, "forensicMarking"),
    audio: workspaceSettingsOf(row?.settings).forensicAudio,
    marks: made?.n ?? 0,
  };
}

/** Whether a recording downloaded from this workspace now is marked. */
export async function marksAudio(db: Reader, organisationId: string, billing: boolean) {
  const status = await forensicStatus(db, organisationId, billing);
  return status.included && status.audio;
}

/** The forensic key of a version of the workspace's key. */
const keyOf = async (keyring: Keyring, organisationId: string, version: number) =>
  forensicKey(await keyring.version(organisationId, version));

/**
 * A mark for one download, written down before it is made: whose it is, what of, through
 * which review and the access log's entry for it. Returns its id and the key it is made with.
 */
export async function issueMark(
  db: Database,
  keyring: Keyring,
  mark: {
    organisationId: string;
    accessEventId: string;
    file: { id: string; name: string; projectId: string };
    kind: DownloadKind;
    recipient: { userId?: string; guestId?: string; label: string };
    reviewId?: string | null;
  },
): Promise<{ id: string; key: Buffer }> {
  const { version, key } = await keyring.current(mark.organisationId);
  const id = uuidv7();
  await db.insert(forensicMarks).values({
    id,
    organisationId: mark.organisationId,
    accessEventId: mark.accessEventId,
    fileId: mark.file.id,
    fileName: mark.file.name,
    projectId: mark.file.projectId,
    kind: mark.kind,
    userId: mark.recipient.userId ?? null,
    guestId: mark.recipient.guestId ?? null,
    recipientLabel: mark.recipient.label,
    reviewId: mark.reviewId ?? null,
    keyVersion: version,
  });
  return { id, key: forensicKey(key) };
}

/** Every mark the workspace has made, by the version of its key that made them. */
export async function markGroups(
  db: Reader,
  keyring: Keyring,
  organisationId: string,
): Promise<MarkGroup[]> {
  const rows = await db
    .select({ id: forensicMarks.id, keyVersion: forensicMarks.keyVersion })
    .from(forensicMarks)
    .where(inOrg(forensicMarks, organisationId));
  const byVersion = new Map<number, string[]>();
  for (const row of rows)
    byVersion.set(row.keyVersion, [...(byVersion.get(row.keyVersion) ?? []), row.id]);
  const groups: MarkGroup[] = [];
  for (const [version, ids] of byVersion)
    groups.push({ key: await keyOf(keyring, organisationId, version), ids });
  return groups;
}

/** What a trace found, named: the mark's download, as it was written down. */
export async function tracedResult(
  db: Reader,
  organisationId: string,
  found: {
    seconds: number;
    match: { id: string; chance: number } | null;
    sync: { chance: number };
  },
  compared: number,
): Promise<TraceResult> {
  const base = { seconds: found.seconds, compared };
  if (!found.match) return { ...base, match: null, patternFound: found.sync.chance < 1e-3 };
  const [row] = await db
    .select({ mark: forensicMarks, reviewName: reviews.title })
    .from(forensicMarks)
    .leftJoin(reviews, inOrg(reviews, organisationId, eq(reviews.id, forensicMarks.reviewId)))
    .where(inOrg(forensicMarks, organisationId, eq(forensicMarks.id, found.match.id)));
  if (!row) return { ...base, match: null, patternFound: true };
  const { mark } = row;
  return {
    ...base,
    patternFound: true,
    match: {
      id: mark.id,
      recipient: mark.recipientLabel,
      userId: mark.userId,
      guestId: mark.guestId,
      fileId: mark.fileId,
      fileName: mark.fileName,
      projectId: mark.projectId,
      kind: mark.kind,
      reviewId: mark.reviewId,
      reviewName: row.reviewName ?? null,
      accessEventId: mark.accessEventId,
      at: mark.createdAt.toISOString(),
      chance: found.match.chance,
    },
  };
}
