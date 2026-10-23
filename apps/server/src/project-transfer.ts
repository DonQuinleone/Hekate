import { type Database, uuidv7 } from "@hekate/db";
import { type Backends, objectKey, unwrapKey, wrapKey } from "@hekate/storage";
import { type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { NotFound } from "./errors.ts";
import type { Jobs } from "./jobs.ts";
import type { Keyring } from "./keyring.ts";
import { dataKeyContext } from "./storage.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Moving a project to another workspace (#240, decision 135): every row of it, its stored
 * objects and their keys, in one transaction, so it is never half in one workspace and half in
 * the other. Who may ask for a move, and how it is confirmed, is the caller's; this only moves.
 */

/** A move refused before anything changed, with why. */
export class TransferRefused extends HTTPException {
  constructor(message: string) {
    super(409, { message });
  }
}

/**
 * Every tenant table, by what a move does with it. A test checks the lists hold every table
 * with an `organisation_id`, so a table added later must be placed in one before it ships.
 */
export const transferTables = {
  /** The project's own rows, moved with it. */
  moved: [
    "projects",
    "project_roles",
    "project_members",
    "folders",
    "sessions",
    "session_tracks",
    "session_todos",
    "workflows",
    "workflow_runs",
    "workflow_steps",
    "files",
    "tracks",
    "takes",
    "take_changes",
    "versions",
    "variations",
    "comment_categories",
    "score_mark_categories",
    "score_marks",
    "stage_boxes",
    "patch_rows",
    "stage_plans",
    "stage_items",
    "personnel",
    "personnel_sections",
    "section_members",
    "works",
    "work_tracks",
    "venues",
    "schedule_days",
    "schedule_rows",
    "schedule_slot_items",
    "comments",
    "comment_attachments",
    "comment_takes",
    "comment_carries",
    "alignments",
    "qa_findings",
    "renditions",
    "rendition_segments",
    "peak_levels",
    "loudness",
    "spectrograms",
    "spectrogram_variants",
    "spectrogram_variant_failures",
    "file_pages",
    "file_tags",
    "caption_tracks",
    "blobs",
    "groups",
    "group_members",
    "reviews",
    "review_items",
    "review_reviewers",
    "review_item_opens",
    "review_decisions",
    "project_reviewer_grants",
    "tasks",
    "task_events",
    "marks",
    "overview_layouts",
    "follows",
    "notifications",
  ],
  /**
   * Dropped with the move: unfinished uploads, live download tickets, calendar feed links and
   * upload requests (with their record of who sent what), each a way in that was given out
   * under the losing workspace. The files sent through a request move with the project.
   */
  dropped: [
    "uploads",
    "upload_parts",
    "download_tickets",
    "calendar_feeds",
    "upload_requests",
    "upload_request_uploads",
    "upload_request_files",
  ],
  /**
   * The workspace's own, left where they are: people, guests, tags, profiles, settings, keys and
   * the access log (append-only, so the project's history stays in the log it was written to).
   * Guests, tags and delivery profiles the project uses are matched in the gaining workspace,
   * by address, name or label, or copied there.
   */
  workspace: [
    "members",
    "invitations",
    "guests",
    "guest_links",
    "guest_sessions",
    "tags",
    "delivery_profiles",
    "project_templates",
    "notification_preferences",
    "saved_searches",
    "organisation_keys",
    "directories",
    "sso_providers",
    "access_events",
  ],
} as const;

export interface MoveDeps {
  db: Database;
  keyring: Keyring;
  backends: Backends;
  jobs: Pick<Jobs, "send">;
}

export interface MoveResult {
  /** Stored objects moved, with their keys. */
  objects: number;
  /** People of the project who are not in the gaining workspace, and so lost their place. */
  leftBehind: { userId: string; name: string }[];
}

const rows = async <T>(tx: Tx | Database, query: SQL) =>
  (await tx.execute(query)) as unknown as T[];

/**
 * The ids of a table's rows in the losing workspace that match, as a subquery. Every read of
 * the project's rows goes through it, so nothing another workspace holds is ever touched,
 * whatever its references say.
 */
const idsIn = (table: string, from: string, where: SQL) =>
  sql`(select id from ${sql.identifier(table)} where organisation_id = ${from} and (${where}))`;

/** The project's files, in the losing workspace. */
const filesOf = (projectId: string, from: string) =>
  idsIn("files", from, sql`project_id = ${projectId}`);

/** The project's stored objects: its files and everything made from them, and attachments. */
function objectsOf(projectId: string, from: string) {
  const files = filesOf(projectId, from);
  const blobsOf = (table: string, column: string, where: SQL) =>
    sql`select ${sql.identifier(column)} from ${sql.identifier(table)}
      where organisation_id = ${from} and (${where})`;
  const comments = idsIn("comments", from, sql`file_id in ${files}`);
  const renditions = idsIn("renditions", from, sql`file_id in ${files}`);
  return sql`
    select b.id, b.backend, b.key, b.wrapped_key as "wrappedKey", b.key_version as "keyVersion",
      b.sha256 is null as "unhashed"
    from blobs b where b.organisation_id = ${from} and b.id in (
      ${blobsOf("files", "blob_id", sql`project_id = ${projectId}`)}
      union ${blobsOf("files", "filmstrip_blob_id", sql`project_id = ${projectId}`)}
      union ${blobsOf("comment_attachments", "blob_id", sql`comment_id in ${comments}`)}
      union ${blobsOf("renditions", "init_blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("rendition_segments", "blob_id", sql`rendition_id in ${renditions}`)}
      union ${blobsOf("peak_levels", "blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("loudness", "blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("spectrograms", "blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("spectrogram_variants", "blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("file_pages", "blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("file_pages", "thumb_blob_id", sql`file_id in ${files}`)}
      union ${blobsOf("caption_tracks", "blob_id", sql`file_id in ${files}`)}
    )`;
}

type StoredObject = {
  id: string;
  backend: string;
  key: string;
  wrappedKey: string;
  keyVersion: number;
  /** Uploaded in parts, its checksum not yet computed. */
  unhashed: boolean;
};

/** Copy an object's ciphertext to where the gaining workspace keeps it. Bound to its id, not to a workspace, it needs no re-encrypting. */
async function copyObject(backends: Backends, object: StoredObject, to: string) {
  const backend = backends.get(object.backend);
  const key = objectKey(to, object.id);
  if (key === object.key) return key;
  await backend.put(key, await backend.get(object.key));
  return key;
}

/** Refused while the project still has work under way that names its workspace. */
async function assertMovable(tx: Tx | Database, projectId: string, from: string) {
  const [busy] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from files where organisation_id = ${from}
      and project_id = ${projectId}
      and (stream_status = 'pending' or analysis_status = 'pending')`,
  );
  if ((busy?.n ?? 0) > 0)
    throw new TransferRefused(
      "Some of its files are still being prepared; try again once they are",
    );
}

/**
 * Refused while the project is being deleted, or the gaining workspace may not take it. Inside
 * the move's transaction both are locked, so a deletion or suspension waits for the move, or
 * the move for it, and neither is missed.
 */
async function assertEligible(
  tx: Tx | Database,
  input: { projectId: string; from: string; to: string },
  lock: boolean,
) {
  const [project] = await rows<{ deleteAfter: string | null; deletionAsked: boolean }>(
    tx,
    sql`select delete_after as "deleteAfter",
        deletion_requested_at is not null as "deletionAsked" from projects
      where id = ${input.projectId} and organisation_id = ${input.from}
      ${lock ? sql`for update` : sql``}`,
  );
  if (!project) throw new NotFound("Project");
  if (project.deleteAfter) throw new TransferRefused("The project is being deleted");
  // A deletion asked for under the losing workspace's roles must not travel with it.
  if (project.deletionAsked)
    throw new TransferRefused("The project's deletion is asked for; withdraw it first");
  const [gaining] = await rows<{ closed: boolean }>(
    tx,
    sql`select suspended_at is not null or delete_after is not null as closed
      from organisations where id = ${input.to} ${lock ? sql`for share` : sql``}`,
  );
  if (!gaining) throw new NotFound("Workspace");
  if (gaining.closed) throw new TransferRefused("That workspace cannot take projects now");
}

/**
 * Move a project from one workspace to another. Its objects are copied first, outside the
 * transaction (a copy that is never used is removed again); then, in one transaction, the
 * project and the gaining workspace are locked and checked again, anything uploaded meanwhile
 * copied too, every key rewrapped with the gaining workspace's key, every row moved, and what
 * cannot follow it mapped or left behind:
 * - people who are not members of the gaining workspace lose their place in the project, and
 *   the tasks and threads given to them are given to nobody;
 * - guests are matched in the gaining workspace by address, or added to it;
 * - tags and custom delivery profiles are matched by name, or copied;
 * - unfinished uploads, download tickets, calendar links and upload requests are dropped, and old
 *   notifications of those left behind removed.
 * Once it commits, the old objects are deleted, and a checksum still to compute is asked for
 * again in the gaining workspace (the job already queued names the losing one).
 */
export async function moveProject(
  deps: MoveDeps,
  input: { projectId: string; from: string; to: string },
): Promise<MoveResult> {
  const { db, keyring, backends } = deps;
  const { projectId, from, to } = input;
  if (from === to) throw new TransferRefused("The project is already in that workspace");
  await assertEligible(db, input, false);
  await assertMovable(db, projectId, from);

  const copied = new Map<string, string>();
  const made: { backend: string; key: string }[] = [];
  const copyAll = async (objects: StoredObject[]) => {
    for (const object of objects) {
      if (copied.has(object.id)) continue;
      const key = await copyObject(backends, object, to);
      copied.set(object.id, key);
      if (key !== object.key) made.push({ backend: object.backend, key });
    }
  };

  let moved: {
    result: MoveResult;
    old: StoredObject[];
    uploads: OpenUpload[];
    unhashed: string[];
  };
  try {
    // Copied ahead, so the transaction holds its locks only for the rows.
    await copyAll(await rows<StoredObject>(db, objectsOf(projectId, from)));
    const target = await keyring.current(to);
    moved = await db.transaction(async (tx) => {
      // Review decisions refuse every change but this one (migration 0087).
      await tx.execute(sql`set local hekate.project_transfer = 'on'`);
      await assertEligible(tx, input, true);
      await assertMovable(tx, projectId, from);
      const uploads = await dropUploads(tx, projectId, from);
      const objects = await rows<StoredObject>(tx, objectsOf(projectId, from));
      await copyAll(objects);
      for (const object of objects) {
        const older = await keyring.version(from, object.keyVersion);
        const plain = unwrapKey(older, object.wrappedKey, dataKeyContext(object.id));
        await tx.execute(sql`update blobs set organisation_id = ${to},
          key = ${copied.get(object.id) ?? object.key},
          wrapped_key = ${wrapKey(target.key, plain, dataKeyContext(object.id))},
          key_version = ${target.version}, updated_at = now()
          where id = ${object.id} and organisation_id = ${from}`);
      }
      const renditions = await rows<{ id: string; wrappedKey: string; keyVersion: number }>(
        tx,
        sql`select id, wrapped_key as "wrappedKey", key_version as "keyVersion" from renditions
          where organisation_id = ${from} and file_id in ${filesOf(projectId, from)}`,
      );
      for (const r of renditions) {
        const context = `rendition:${r.id}`;
        const plain = unwrapKey(await keyring.version(from, r.keyVersion), r.wrappedKey, context);
        await tx.execute(sql`update renditions
          set wrapped_key = ${wrapKey(target.key, plain, context)}, key_version = ${target.version}
          where id = ${r.id} and organisation_id = ${from}`);
      }
      const leftBehind = await leavePeople(tx, projectId, from, to);
      await mapGuests(tx, projectId, from, to);
      await mapTags(tx, projectId, from, to);
      await mapProfiles(tx, projectId, from, to);
      await moveRows(tx, projectId, from, to);
      return {
        result: { objects: objects.length, leftBehind },
        old: objects.filter((o) => copied.get(o.id) !== o.key),
        uploads,
        unhashed: objects.filter((o) => o.unhashed).map((o) => o.id),
      };
    });
  } catch (failure) {
    // Nothing moved: the copies made for it are removed again.
    for (const copy of made)
      await backends
        .get(copy.backend)
        .delete(copy.key)
        .catch(() => undefined);
    throw failure;
  }
  // The old objects belong to nobody now; a delete that fails leaves them to reconciliation.
  for (const object of moved.old)
    await backends
      .get(object.backend)
      .delete(object.key)
      .catch((error: unknown) =>
        console.warn(`Could not delete ${object.key} after a move: ${String(error)}`),
      );
  for (const upload of moved.uploads)
    await backends
      .get(upload.backend)
      .abortMultipart(upload.key, upload.backendUploadId)
      .catch(() => undefined);
  for (const blobId of moved.unhashed)
    await deps.jobs
      .send("blob-checksum", { organisationId: to, blobId }, { singletonKey: `${to}:${blobId}` })
      .catch((error: unknown) =>
        console.warn(`Could not ask for ${blobId}'s checksum after a move: ${String(error)}`),
      );
  return moved.result;
}

type OpenUpload = { backend: string; key: string; backendUploadId: string };

/** Unfinished uploads into the project end with the move; their parts are discarded after. */
async function dropUploads(tx: Tx, projectId: string, from: string) {
  return rows<OpenUpload>(
    tx,
    sql`delete from uploads where organisation_id = ${from} and project_id = ${projectId}
      returning backend, key, backend_upload_id as "backendUploadId"`,
  );
}

/**
 * People of the project who are not members of the gaining workspace lose their place in it:
 * their role, their groups, their own views of it, and the tasks and threads given to them.
 * What they wrote, decided and did stays theirs.
 */
async function leavePeople(tx: Tx, projectId: string, from: string, to: string) {
  const kept = sql`(select user_id from members where organisation_id = ${to})`;
  const leaving = await rows<{ userId: string; name: string }>(
    tx,
    sql`select pm.user_id as "userId", u.name from project_members pm
      join users u on u.id = pm.user_id
      where pm.organisation_id = ${from} and pm.project_id = ${projectId}
        and pm.user_id not in ${kept}`,
  );
  const files = filesOf(projectId, from);
  const tracks = idsIn("tracks", from, sql`project_id = ${projectId}`);
  const reviews = idsIn("reviews", from, sql`project_id = ${projectId}`);
  const groups = idsIn("groups", from, sql`project_id = ${projectId}`);
  await tx.execute(sql`delete from project_members where organisation_id = ${from}
    and project_id = ${projectId} and user_id not in ${kept}`);
  await tx.execute(sql`delete from group_members where organisation_id = ${from}
    and user_id is not null and user_id not in ${kept} and group_id in ${groups}`);
  for (const table of ["marks", "overview_layouts", "notifications", "project_reviewer_grants"])
    await tx.execute(sql`delete from ${sql.identifier(table)} where organisation_id = ${from}
      and project_id = ${projectId} and user_id not in ${kept}`);
  await tx.execute(sql`delete from follows where organisation_id = ${from}
    and user_id not in ${kept} and (track_id in ${tracks} or review_id in ${reviews})`);
  await tx.execute(sql`update tasks set assignee_id = null where organisation_id = ${from}
    and project_id = ${projectId} and assignee_id not in ${kept}`);
  await tx.execute(sql`update comments set assignee_id = null where organisation_id = ${from}
    and file_id in ${files} and assignee_id not in ${kept}`);
  await tx.execute(sql`delete from download_tickets where organisation_id = ${from}
    and (file_id in ${files} or project_id = ${projectId})`);
  await tx.execute(sql`delete from calendar_feeds where organisation_id = ${from}
    and project_id = ${projectId}`);
  // Its uploads and files rows go with it.
  await tx.execute(sql`delete from upload_requests where organisation_id = ${from}
    and project_id = ${projectId}`);
  return leaving;
}

/** Guests the project names, as guests of the gaining workspace: matched by address, or added. */
async function mapGuests(tx: Tx, projectId: string, from: string, to: string) {
  const files = filesOf(projectId, from);
  const reviews = idsIn("reviews", from, sql`project_id = ${projectId}`);
  const groups = idsIn("groups", from, sql`project_id = ${projectId}`);
  const named = await rows<{ id: string; name: string; email: string; label: string | null }>(
    tx,
    sql`select id, name, email, label from guests where organisation_id = ${from} and id in (
      select guest_author_id from comments where organisation_id = ${from} and file_id in ${files}
      union select guest_id from review_reviewers
        where organisation_id = ${from} and review_id in ${reviews}
      union select guest_id from group_members
        where organisation_id = ${from} and group_id in ${groups}
      union select actor_guest_id from notifications
        where organisation_id = ${from} and project_id = ${projectId}
      union select guest_id from project_reviewer_grants
        where organisation_id = ${from} and project_id = ${projectId}
    )`,
  );
  for (const guest of named) {
    await tx.execute(sql`insert into guests (id, organisation_id, name, email, label)
      values (${uuidv7()}, ${to}, ${guest.name}, ${guest.email}, ${guest.label})
      on conflict (organisation_id, email) do nothing`);
    const [there] = await rows<{ id: string }>(
      tx,
      sql`select id from guests where organisation_id = ${to} and email = ${guest.email}`,
    );
    if (!there) continue;
    await tx.execute(sql`update comments set guest_author_id = ${there.id}
      where organisation_id = ${from} and guest_author_id = ${guest.id} and file_id in ${files}`);
    await tx.execute(sql`update review_reviewers set guest_id = ${there.id}
      where organisation_id = ${from} and guest_id = ${guest.id} and review_id in ${reviews}`);
    await tx.execute(sql`update group_members set guest_id = ${there.id}
      where organisation_id = ${from} and guest_id = ${guest.id} and group_id in ${groups}`);
    await tx.execute(sql`update notifications set actor_guest_id = ${there.id}
      where organisation_id = ${from} and actor_guest_id = ${guest.id}
        and project_id = ${projectId}`);
    await tx.execute(sql`update project_reviewer_grants set guest_id = ${there.id}
      where organisation_id = ${from} and guest_id = ${guest.id}
        and project_id = ${projectId}`);
  }
}

/** The project's files' tags, as the gaining workspace's tags of the same name. */
async function mapTags(tx: Tx, projectId: string, from: string, to: string) {
  const files = filesOf(projectId, from);
  const used = await rows<{ id: string; name: string }>(
    tx,
    sql`select distinct t.id, t.name from file_tags ft join tags t on t.id = ft.tag_id
      where ft.organisation_id = ${from} and t.organisation_id = ${from}
        and ft.file_id in ${files}`,
  );
  for (const tag of used) {
    await tx.execute(sql`insert into tags (id, organisation_id, name)
      values (${uuidv7()}, ${to}, ${tag.name})
      on conflict (organisation_id, lower(name)) do nothing`);
    await tx.execute(sql`update file_tags set tag_id = (
        select id from tags where organisation_id = ${to} and lower(name) = lower(${tag.name}))
      where organisation_id = ${from} and tag_id = ${tag.id} and file_id in ${files}`);
  }
}

/** Custom delivery profiles the project uses, as the gaining workspace's: by label, or copied. */
async function mapProfiles(tx: Tx, projectId: string, from: string, to: string) {
  const scopes = {
    projects: sql`organisation_id = ${from} and id = ${projectId}`,
    tracks: sql`organisation_id = ${from} and project_id = ${projectId}`,
    files: sql`organisation_id = ${from} and project_id = ${projectId}`,
  };
  const refs = await rows<{ ref: string }>(
    tx,
    sql`select delivery_profile as ref from projects where ${scopes.projects}
      union select delivery_profile from tracks where ${scopes.tracks}
      union select delivery_profile from files where ${scopes.files}`,
  );
  for (const { ref } of refs) {
    if (!ref?.startsWith("custom:")) continue;
    const [profile] = await rows<{ label: string; spec: unknown }>(
      tx,
      sql`select label, spec from delivery_profiles
        where organisation_id = ${from} and id::text = ${ref.slice("custom:".length)}`,
    );
    let mapped: string | null = null;
    if (profile) {
      await tx.execute(sql`insert into delivery_profiles (id, organisation_id, label, spec)
        values (${uuidv7()}, ${to}, ${profile.label}, ${JSON.stringify(profile.spec)}::jsonb)
        on conflict (organisation_id, lower(label)) do nothing`);
      const [there] = await rows<{ id: string }>(
        tx,
        sql`select id from delivery_profiles
          where organisation_id = ${to} and lower(label) = lower(${profile.label})`,
      );
      mapped = there ? `custom:${there.id}` : null;
    }
    for (const [table, scope] of Object.entries(scopes))
      await tx.execute(sql`update ${sql.identifier(table)} set delivery_profile = ${mapped}
        where ${scope} and delivery_profile = ${ref}`);
  }
}

/**
 * Every row of the project, into the gaining workspace. Each table's rows are found through
 * their parents still in the losing workspace, so children move before their parents, and the
 * project last.
 */
async function moveRows(tx: Tx, projectId: string, from: string, to: string) {
  const P = projectId;
  const of = (table: string, where: SQL) => idsIn(table, from, where);
  const files = of("files", sql`project_id = ${P}`);
  const tracks = of("tracks", sql`project_id = ${P}`);
  const reviews = of("reviews", sql`project_id = ${P}`);
  const comments = of("comments", sql`file_id in ${files}`);
  const renditions = of("renditions", sql`file_id in ${files}`);
  const versions = of("versions", sql`track_id in ${tracks}`);
  const byProject = sql`project_id = ${P}`;
  // Children before parents: each scope reads parents not yet moved.
  const scopes: [string, SQL][] = [
    ["rendition_segments", sql`rendition_id in ${renditions}`],
    [
      "review_item_opens",
      sql`reviewer_id in ${of("review_reviewers", sql`review_id in ${reviews}`)}`,
    ],
    ["comment_attachments", sql`comment_id in ${comments}`],
    ["comment_takes", sql`comment_id in ${comments}`],
    ["comment_carries", sql`comment_id in ${comments}`],
    ["variations", sql`version_id in ${versions}`],
    ["workflow_steps", sql`run_id in ${of("workflow_runs", byProject)}`],
    ["session_tracks", sql`session_id in ${of("sessions", byProject)}`],
    ["session_todos", sql`session_id in ${of("sessions", byProject)}`],
    ["patch_rows", sql`stage_box_id in ${of("stage_boxes", byProject)}`],
    ["stage_items", sql`stage_plan_id in ${of("stage_plans", byProject)}`],
    [
      "section_members",
      sql`section_id in ${of("personnel_sections", sql`personnel_id in ${of("personnel", byProject)}`)}`,
    ],
    ["personnel_sections", sql`personnel_id in ${of("personnel", byProject)}`],
    ["work_tracks", sql`work_id in ${of("works", byProject)}`],
    [
      "schedule_slot_items",
      sql`row_id in ${of("schedule_rows", sql`day_id in ${of("schedule_days", byProject)}`)}`,
    ],
    ["schedule_rows", sql`day_id in ${of("schedule_days", byProject)}`],
    ["group_members", sql`group_id in ${of("groups", byProject)}`],
    ["task_events", sql`task_id in ${of("tasks", byProject)}`],
    ["review_items", sql`review_id in ${reviews}`],
    ["review_reviewers", sql`review_id in ${reviews}`],
    ["review_decisions", sql`review_id in ${reviews}`],
    ["follows", sql`track_id in ${tracks} or review_id in ${reviews}`],
    ["takes", sql`track_id in ${tracks}`],
    ["take_changes", sql`take_id in ${of("takes", sql`track_id in ${tracks}`)}`],
    ["score_marks", sql`track_id in ${tracks}`],
    ["versions", sql`track_id in ${tracks}`],
    ...[
      "comments",
      "qa_findings",
      "renditions",
      "peak_levels",
      "loudness",
      "spectrograms",
      "spectrogram_variants",
      "spectrogram_variant_failures",
      "file_pages",
      "file_tags",
      "caption_tracks",
    ].map((t): [string, SQL] => [t, sql`file_id in ${files}`]),
    ["alignments", sql`from_file_id in ${files}`],
    ...[
      "project_roles",
      "project_members",
      "folders",
      "sessions",
      "workflows",
      "workflow_runs",
      "files",
      "tracks",
      "comment_categories",
      "score_mark_categories",
      "stage_boxes",
      "stage_plans",
      "personnel",
      "works",
      "schedule_days",
      "venues",
      "groups",
      "reviews",
      "tasks",
      "marks",
      "overview_layouts",
      "notifications",
      "project_reviewer_grants",
    ].map((t): [string, SQL] => [t, byProject]),
    ["projects", sql`id = ${P}`],
  ];
  for (const [table, scope] of scopes)
    await tx.execute(sql`update ${sql.identifier(table)} set organisation_id = ${to}
      where organisation_id = ${from} and (${scope})`);
  // Who it lists stays listed, but not as a member or guest of the workspace it left.
  await tx.execute(sql`update personnel set user_id = null, guest_id = null
    where organisation_id = ${to} and project_id = ${P}`);
  // A template made from it in the losing workspace no longer points at it.
  await tx.execute(sql`update project_templates set from_project_id = null
    where organisation_id = ${from} and from_project_id = ${P}`);
}
