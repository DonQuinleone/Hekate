import { type Database, uuidv7 } from "@hekate/db";
import { type Backends, objectKey, unwrapKey, wrapKey } from "@hekate/storage";
import { type SQL, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { NotFound } from "./errors.ts";
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
    "workflows",
    "workflow_runs",
    "workflow_steps",
    "files",
    "tracks",
    "takes",
    "versions",
    "variations",
    "comment_categories",
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
    "file_pages",
    "file_tags",
    "blobs",
    "groups",
    "group_members",
    "reviews",
    "review_items",
    "review_reviewers",
    "review_item_opens",
    "review_decisions",
    "tasks",
    "task_events",
    "marks",
    "overview_layouts",
    "follows",
    "notifications",
  ],
  /**
   * Dropped with the move: unfinished uploads, live download tickets and calendar feed links,
   * each a way in that was given out under the losing workspace.
   */
  dropped: ["uploads", "upload_parts", "download_tickets", "calendar_feeds"],
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
}

export interface MoveResult {
  /** Stored objects moved, with their keys. */
  objects: number;
  /** People of the project who are not in the gaining workspace, and so lost their place. */
  leftBehind: { userId: string; name: string }[];
}

const rows = async <T>(tx: Tx | Database, query: SQL) =>
  (await tx.execute(query)) as unknown as T[];

/** The project's stored objects: its files and everything made from them, and attachments. */
function objectsOf(projectId: string) {
  const files = sql`(select id from files where project_id = ${projectId})`;
  return sql`
    select b.id, b.backend, b.key, b.wrapped_key as "wrappedKey", b.key_version as "keyVersion"
    from blobs b where b.id in (
      select blob_id from files where project_id = ${projectId}
      union select blob_id from comment_attachments
        where comment_id in (select id from comments where file_id in ${files})
      union select init_blob_id from renditions where file_id in ${files}
      union select s.blob_id from rendition_segments s
        join renditions r on r.id = s.rendition_id where r.file_id in ${files}
      union select blob_id from peak_levels where file_id in ${files}
      union select blob_id from loudness where file_id in ${files}
      union select blob_id from spectrograms where file_id in ${files}
      union select blob_id from file_pages where file_id in ${files}
      union select thumb_blob_id from file_pages where file_id in ${files}
    )`;
}

type StoredObject = {
  id: string;
  backend: string;
  key: string;
  wrappedKey: string;
  keyVersion: number;
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
async function assertMovable(tx: Tx | Database, projectId: string) {
  const [busy] = await rows<{ n: number }>(
    tx,
    sql`select count(*)::int as n from files where project_id = ${projectId}
      and (stream_status = 'pending' or analysis_status = 'pending')`,
  );
  if ((busy?.n ?? 0) > 0)
    throw new TransferRefused(
      "Some of its files are still being prepared; try again once they are",
    );
}

/**
 * Move a project from one workspace to another. Its objects are copied first, outside the
 * transaction (a copy that is never used is removed again); then, in one transaction, the
 * project is locked, anything uploaded meanwhile copied too, every key rewrapped with the
 * gaining workspace's key, every row moved, and what cannot follow it mapped or left behind:
 * - people who are not members of the gaining workspace lose their place in the project, and
 *   the tasks and threads given to them are given to nobody;
 * - guests are matched in the gaining workspace by address, or added to it;
 * - tags and custom delivery profiles are matched by name, or copied;
 * - unfinished uploads and download tickets are dropped, and old notifications of those left
 *   behind removed.
 * Once it commits, the old objects are deleted.
 */
export async function moveProject(
  deps: MoveDeps,
  input: { projectId: string; from: string; to: string },
): Promise<MoveResult> {
  const { db, keyring, backends } = deps;
  const { projectId, from, to } = input;
  if (from === to) throw new TransferRefused("The project is already in that workspace");
  const [project] = await rows<{ id: string; deleteAfter: string | null }>(
    db,
    sql`select id, delete_after as "deleteAfter" from projects
      where id = ${projectId} and organisation_id = ${from}`,
  );
  if (!project) throw new NotFound("Project");
  if (project.deleteAfter) throw new TransferRefused("The project is being deleted");
  const [gaining] = await rows<{ id: string; suspended: boolean }>(
    db,
    sql`select id, suspended_at is not null or delete_after is not null as suspended
      from organisations where id = ${to}`,
  );
  if (!gaining) throw new NotFound("Workspace");
  if (gaining.suspended) throw new TransferRefused("That workspace cannot take projects now");
  await assertMovable(db, projectId);

  // Copied ahead, so the transaction holds its locks only for the rows.
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
  await copyAll(await rows<StoredObject>(db, objectsOf(projectId)));
  const target = await keyring.current(to);

  let moved: { result: MoveResult; old: StoredObject[]; uploads: OpenUpload[] };
  try {
    moved = await db.transaction(async (tx) => {
      // Review decisions refuse every change but this one (migration 0087).
      await tx.execute(sql`set local hekate.project_transfer = 'on'`);
      const [locked] = await rows<{ id: string }>(
        tx,
        sql`select id from projects where id = ${projectId} and organisation_id = ${from}
          for update`,
      );
      if (!locked) throw new NotFound("Project");
      await assertMovable(tx, projectId);
      const uploads = await dropUploads(tx, projectId);
      const objects = await rows<StoredObject>(tx, objectsOf(projectId));
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
          where file_id in (select id from files where project_id = ${projectId})`,
      );
      for (const r of renditions) {
        const context = `rendition:${r.id}`;
        const plain = unwrapKey(await keyring.version(from, r.keyVersion), r.wrappedKey, context);
        await tx.execute(sql`update renditions
          set wrapped_key = ${wrapKey(target.key, plain, context)}, key_version = ${target.version}
          where id = ${r.id}`);
      }
      const leftBehind = await leavePeople(tx, projectId, to);
      await mapGuests(tx, projectId, from, to);
      await mapTags(tx, projectId, to);
      await mapProfiles(tx, projectId, from, to);
      await moveRows(tx, projectId, from, to);
      return {
        result: { objects: objects.length, leftBehind },
        old: objects.filter((o) => copied.get(o.id) !== o.key),
        uploads,
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
  return moved.result;
}

type OpenUpload = { backend: string; key: string; backendUploadId: string };

/** Unfinished uploads into the project end with the move; their parts are discarded after. */
async function dropUploads(tx: Tx, projectId: string) {
  return rows<OpenUpload>(
    tx,
    sql`delete from uploads where project_id = ${projectId}
      returning backend, key, backend_upload_id as "backendUploadId"`,
  );
}

/**
 * People of the project who are not members of the gaining workspace lose their place in it:
 * their role, their groups, their own views of it, and the tasks and threads given to them.
 * What they wrote, decided and did stays theirs.
 */
async function leavePeople(tx: Tx, projectId: string, to: string) {
  const kept = sql`(select user_id from members where organisation_id = ${to})`;
  const leaving = await rows<{ userId: string; name: string }>(
    tx,
    sql`select pm.user_id as "userId", u.name from project_members pm
      join users u on u.id = pm.user_id
      where pm.project_id = ${projectId} and pm.user_id not in ${kept}`,
  );
  const files = sql`(select id from files where project_id = ${projectId})`;
  const tracks = sql`(select id from tracks where project_id = ${projectId})`;
  const reviews = sql`(select id from reviews where project_id = ${projectId})`;
  await tx.execute(
    sql`delete from project_members where project_id = ${projectId} and user_id not in ${kept}`,
  );
  await tx.execute(sql`delete from group_members where user_id is not null
    and user_id not in ${kept}
    and group_id in (select id from groups where project_id = ${projectId})`);
  for (const table of ["marks", "overview_layouts"])
    await tx.execute(sql`delete from ${sql.identifier(table)}
      where project_id = ${projectId} and user_id not in ${kept}`);
  await tx.execute(sql`delete from follows where user_id not in ${kept}
    and (track_id in ${tracks} or review_id in ${reviews})`);
  await tx.execute(
    sql`delete from notifications where project_id = ${projectId} and user_id not in ${kept}`,
  );
  await tx.execute(sql`update tasks set assignee_id = null
    where project_id = ${projectId} and assignee_id not in ${kept}`);
  await tx.execute(sql`update comments set assignee_id = null
    where file_id in ${files} and assignee_id not in ${kept}`);
  await tx.execute(sql`delete from download_tickets where file_id in ${files}`);
  await tx.execute(sql`delete from calendar_feeds where project_id = ${projectId}`);
  return leaving;
}

/** Guests the project names, as guests of the gaining workspace: matched by address, or added. */
async function mapGuests(tx: Tx, projectId: string, from: string, to: string) {
  const files = sql`(select id from files where project_id = ${projectId})`;
  const reviews = sql`(select id from reviews where project_id = ${projectId})`;
  const groups = sql`(select id from groups where project_id = ${projectId})`;
  const named = await rows<{ id: string; name: string; email: string; label: string | null }>(
    tx,
    sql`select id, name, email, label from guests where organisation_id = ${from} and id in (
      select guest_author_id from comments where file_id in ${files}
      union select guest_id from review_reviewers where review_id in ${reviews}
      union select guest_id from group_members where group_id in ${groups}
      union select actor_guest_id from notifications where project_id = ${projectId}
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
      where guest_author_id = ${guest.id} and file_id in ${files}`);
    await tx.execute(sql`update review_reviewers set guest_id = ${there.id}
      where guest_id = ${guest.id} and review_id in ${reviews}`);
    await tx.execute(sql`update group_members set guest_id = ${there.id}
      where guest_id = ${guest.id} and group_id in ${groups}`);
    await tx.execute(sql`update notifications set actor_guest_id = ${there.id}
      where actor_guest_id = ${guest.id} and project_id = ${projectId}`);
  }
}

/** The project's files' tags, as the gaining workspace's tags of the same name. */
async function mapTags(tx: Tx, projectId: string, to: string) {
  const used = await rows<{ id: string; name: string }>(
    tx,
    sql`select distinct t.id, t.name from file_tags ft join tags t on t.id = ft.tag_id
      where ft.file_id in (select id from files where project_id = ${projectId})`,
  );
  for (const tag of used) {
    await tx.execute(sql`insert into tags (id, organisation_id, name)
      values (${uuidv7()}, ${to}, ${tag.name})
      on conflict (organisation_id, lower(name)) do nothing`);
    await tx.execute(sql`update file_tags set tag_id = (
        select id from tags where organisation_id = ${to} and lower(name) = lower(${tag.name}))
      where tag_id = ${tag.id}
        and file_id in (select id from files where project_id = ${projectId})`);
  }
}

/** Custom delivery profiles the project uses, as the gaining workspace's: by label, or copied. */
async function mapProfiles(tx: Tx, projectId: string, from: string, to: string) {
  const refs = await rows<{ ref: string }>(
    tx,
    sql`select delivery_profile as ref from projects where id = ${projectId}
      union select delivery_profile from tracks where project_id = ${projectId}
      union select delivery_profile from files where project_id = ${projectId}`,
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
    for (const table of ["projects", "tracks", "files"]) {
      const scope = table === "projects" ? sql`id = ${projectId}` : sql`project_id = ${projectId}`;
      await tx.execute(sql`update ${sql.identifier(table)} set delivery_profile = ${mapped}
        where ${scope} and delivery_profile = ${ref}`);
    }
  }
}

/** Every row of the project, into the gaining workspace. */
async function moveRows(tx: Tx, projectId: string, from: string, to: string) {
  const P = projectId;
  const files = sql`(select id from files where project_id = ${P})`;
  const tracks = sql`(select id from tracks where project_id = ${P})`;
  const reviews = sql`(select id from reviews where project_id = ${P})`;
  const comments = sql`(select id from comments where file_id in ${files})`;
  const scopes: [string, SQL][] = [
    ["projects", sql`id = ${P}`],
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
      "groups",
      "reviews",
      "tasks",
      "marks",
      "overview_layouts",
      "notifications",
    ].map((t): [string, SQL] => [t, sql`project_id = ${P}`]),
    ["session_tracks", sql`session_id in (select id from sessions where project_id = ${P})`],
    ["workflow_steps", sql`run_id in (select id from workflow_runs where project_id = ${P})`],
    ["takes", sql`track_id in ${tracks}`],
    ["versions", sql`track_id in ${tracks}`],
    ["variations", sql`version_id in (select id from versions where track_id in ${tracks})`],
    ...["comments", "qa_findings", "renditions", "peak_levels", "loudness", "spectrograms"].map(
      (t): [string, SQL] => [t, sql`file_id in ${files}`],
    ),
    ["file_pages", sql`file_id in ${files}`],
    ["file_tags", sql`file_id in ${files}`],
    ["alignments", sql`from_file_id in ${files}`],
    ["comment_attachments", sql`comment_id in ${comments}`],
    ["comment_takes", sql`comment_id in ${comments}`],
    ["comment_carries", sql`comment_id in ${comments}`],
    [
      "rendition_segments",
      sql`rendition_id in (select id from renditions where file_id in ${files})`,
    ],
    ["group_members", sql`group_id in (select id from groups where project_id = ${P})`],
    ["review_items", sql`review_id in ${reviews}`],
    ["review_reviewers", sql`review_id in ${reviews}`],
    ["review_decisions", sql`review_id in ${reviews}`],
    [
      "review_item_opens",
      sql`reviewer_id in (select id from review_reviewers where review_id in ${reviews})`,
    ],
    ["task_events", sql`task_id in (select id from tasks where project_id = ${P})`],
    ["follows", sql`track_id in ${tracks} or review_id in ${reviews}`],
  ];
  for (const [table, scope] of scopes)
    await tx.execute(sql`update ${sql.identifier(table)} set organisation_id = ${to}
      where organisation_id = ${from} and (${scope})`);
  // A template made from it in the losing workspace no longer points at it.
  await tx.execute(sql`update project_templates set from_project_id = null
    where organisation_id = ${from} and from_project_id = ${P}`);
}
