import { type Database, inOrg, schema } from "@hekate/db";
import type { CroomConflictChoice, CroomImported } from "@hekate/shared";
import { asc, eq, inArray, max } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Actor, Audit, RequestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import { metrics } from "../metrics/index.ts";
import { follow } from "../notifications.ts";
import type { Storage } from "../storage.ts";
import { assertStorageRoom } from "../usage.ts";
import { type Existing, type ImportPlan, planImport } from "./plan.ts";
import type { CroomSource } from "./reader.ts";
import { replayFile } from "./replay.ts";

const {
  files,
  patchRows,
  personnel,
  personnelSections,
  projects,
  scheduleDays,
  scheduleRows,
  scheduleSlotItems,
  scoreMarkCategories,
  scoreMarks,
  sectionMembers,
  sessions,
  sessionTracks,
  stageBoxes,
  stageItems,
  stagePlans,
  takes,
  tracks,
  venues,
  workTracks,
  works,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

/** What the project already holds that an import may meet, by name (decision 242). */
export async function existingIn(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<Existing> {
  const inProject = <T extends typeof works | typeof venues>(t: T) =>
    inOrg(t, organisationId, eq(t.projectId, projectId));
  const workRows = await db
    .select({ id: works.id, title: works.title })
    .from(works)
    .where(inProject(works));
  const entries = workRows.length
    ? await db
        .select({ workId: workTracks.workId, id: tracks.id, name: tracks.name })
        .from(workTracks)
        .innerJoin(tracks, eq(tracks.id, workTracks.trackId))
        .where(
          inOrg(
            workTracks,
            organisationId,
            eq(tracks.organisationId, organisationId),
            inArray(
              workTracks.workId,
              workRows.map((w) => w.id),
            ),
          ),
        )
    : [];
  const takeRows = entries.length
    ? await db
        .select({ trackId: takes.trackId, number: takes.number })
        .from(takes)
        .where(
          inOrg(
            takes,
            organisationId,
            inArray(
              takes.trackId,
              entries.map((e) => e.id),
            ),
          ),
        )
    : [];
  const boxRows = await db
    .select({ id: stageBoxes.id, name: stageBoxes.name })
    .from(stageBoxes)
    .where(inOrg(stageBoxes, organisationId, eq(stageBoxes.projectId, projectId)));
  const channelRows = boxRows.length
    ? await db
        .select({
          boxId: patchRows.stageBoxId,
          direction: patchRows.direction,
          channel: patchRows.channel,
        })
        .from(patchRows)
        .where(
          inOrg(
            patchRows,
            organisationId,
            inArray(
              patchRows.stageBoxId,
              boxRows.map((b) => b.id),
            ),
          ),
        )
    : [];
  return {
    works: workRows.map((w) => ({
      ...w,
      tracks: entries
        .filter((e) => e.workId === w.id)
        .map((e) => ({
          id: e.id,
          name: e.name,
          takes: takeRows.filter((t) => t.trackId === e.id).map((t) => t.number),
        })),
    })),
    venues: await db
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(inProject(venues)),
    personnel: await db
      .select({ id: personnel.id, name: personnel.name })
      .from(personnel)
      .where(inOrg(personnel, organisationId, eq(personnel.projectId, projectId))),
    stagePlans: await db
      .select({ id: stagePlans.id, name: stagePlans.name })
      .from(stagePlans)
      .where(inOrg(stagePlans, organisationId, eq(stagePlans.projectId, projectId))),
    stageBoxes: boxRows.map((b) => ({
      ...b,
      inputs: channelRows
        .filter((c) => c.boxId === b.id && c.direction === "input")
        .map((c) => c.channel),
      outputs: channelRows
        .filter((c) => c.boxId === b.id && c.direction === "output")
        .map((c) => c.channel),
    })),
    categories: await db
      .select({ id: scoreMarkCategories.id, name: scoreMarkCategories.name })
      .from(scoreMarkCategories)
      .where(
        inOrg(scoreMarkCategories, organisationId, eq(scoreMarkCategories.projectId, projectId)),
      )
      .orderBy(asc(scoreMarkCategories.position)),
  };
}

/** The next position after the last of a project's rows. */
async function nextPosition(
  tx: Tx,
  table:
    | typeof works
    | typeof venues
    | typeof personnel
    | typeof tracks
    | typeof sessions
    | typeof scheduleDays
    | typeof stagePlans
    | typeof stageBoxes
    | typeof scoreMarkCategories,
  organisationId: string,
  projectId: string,
) {
  const [last] = await tx
    .select({ position: max(table.position) })
    .from(table)
    .where(inOrg(table, organisationId, eq(table.projectId, projectId)));
  return (last?.position ?? -1) + 1;
}

export interface CommitDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  jobs: Pick<Jobs, "send">;
}

export interface CommitOptions {
  organisationId: string;
  projectId: string;
  userId: string;
  actor: Actor;
  request?: RequestInfo;
  choice: CroomConflictChoice;
  /** For tests: runs inside the transaction after everything is written, to prove it rolls back. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

/**
 * Writes a replayed `.croom` file into a project in one transaction (#57, decision 242). The
 * embedded scores are stored first, encrypted as any upload is; if anything after fails, the
 * transaction writes nothing and the stored scores are taken back.
 */
export async function commitImport(
  deps: CommitDeps,
  source: CroomSource,
  options: CommitOptions,
): Promise<CroomImported> {
  const { db, storage, audit } = deps;
  const { organisationId, projectId } = options;
  const replayed = replayFile(source.file);
  // A first plan, outside the lock, to know which scores to store before the transaction.
  const first = planImport(
    replayed.model,
    source.file.blobs,
    await existingIn(db, organisationId, projectId),
    options.choice,
    replayed.report,
  );
  const total = first.scores.reduce((n, s) => n + s.byteSize, 0);
  if (total > 0) await db.transaction((tx) => assertStorageRoom(tx, organisationId, total));
  const stored = new Map<string, { blobId: string; byteSize: number }>();
  let committed: {
    plan: ImportPlan;
    fileIds: Map<string, string>;
    report: CroomImported["report"];
  };
  try {
    for (const score of first.scores) {
      const bytes = source.blob(score.blobId);
      if (!bytes) continue;
      const blob = await storage.put(organisationId, bytes, {
        contentType: "application/pdf",
        projectId,
      });
      stored.set(score.key, { blobId: blob.id, byteSize: blob.byteSize });
    }
    const written = await db.transaction(async (tx) => {
      // Imports into one project take turns, so each plans against what the last one wrote;
      // and none goes into a project archived meanwhile.
      const [project] = await tx
        .select({ archivedAt: projects.archivedAt })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
        .for("update");
      if (!project) throw new NotFound("Project");
      if (project.archivedAt) throw new HTTPException(409, { message: "This project is archived" });
      await assertStorageRoom(tx, organisationId, 0);
      // Planned again under the lock, against the project as it now stands: this plan, and its
      // report, are what is written.
      const again = replayFile(source.file);
      const plan = planImport(
        again.model,
        source.file.blobs,
        await existingIn(tx, organisationId, projectId),
        options.choice,
        again.report,
      );
      const fileIds = await writePlan(tx, plan, stored, options);
      // In the access log with what it wrote, or not at all: each score as an upload, and the
      // import itself.
      for (const [key, fileId] of fileIds) {
        const score = plan.scores.find((s) => s.key === key);
        await audit.record(
          organisationId,
          options.actor,
          {
            action: "file.upload",
            projectId,
            fileId,
            details: { name: score?.name, size: score?.byteSize, kind: "document", from: "croom" },
          },
          options.request,
          tx,
        );
      }
      await audit.record(
        organisationId,
        options.actor,
        {
          action: "project.croom_import",
          projectId,
          details: {
            counts: Object.fromEntries(plan.counts.map((c) => [c.kind, c.create + c.merge])),
            conflicts: options.choice,
          },
        },
        options.request,
        tx,
      );
      await options.beforeCommit?.(tx);
      return { plan, fileIds, report: again.report.report() };
    });
    committed = written;
  } catch (error) {
    // Nothing points at the stored scores now: take them back.
    for (const { blobId } of stored.values())
      await storage.remove(organisationId, blobId).catch(() => undefined);
    throw error;
  }
  // The scores are drawn as any document is. The import stands whatever happens here: a score
  // whose drawing could not be queued is said in the server's log.
  for (const [key, fileId] of committed.fileIds) {
    const score = committed.plan.scores.find((s) => s.key === key);
    metrics.uploadsBytes.inc({ workspace: organisationId }, score?.byteSize ?? 0);
    await deps.jobs
      .send("document-render", { organisationId, fileId }, { singletonKey: fileId })
      .catch((error: unknown) =>
        console.warn(`Could not queue drawing the imported score ${fileId}: ${String(error)}`),
      );
  }
  return { counts: committed.plan.counts, report: committed.report };
}

/** Every row of the plan, in an order that lets each find what it refers to. Returns the scores' files. */
async function writePlan(
  tx: Tx,
  plan: ImportPlan,
  stored: Map<string, { blobId: string; byteSize: number }>,
  options: CommitOptions,
): Promise<Map<string, string>> {
  const { organisationId, projectId, userId } = options;
  const base = { organisationId };

  // Scores, as documents of the project, drawn by the media worker like any upload.
  const fileOf = new Map<string, string>();
  for (const score of plan.scores) {
    const blob = stored.get(score.key);
    if (!blob) continue;
    const [row] = await tx
      .insert(files)
      .values({
        ...base,
        projectId,
        name: score.name,
        kind: "document",
        blobId: blob.blobId,
        contentType: "application/pdf",
        byteSize: blob.byteSize,
        streamStatus: "pending",
        uploadedBy: userId,
      })
      .returning({ id: files.id });
    if (row) fileOf.set(score.key, row.id);
  }

  // Venues.
  const venueOf = new Map<string, string>();
  let position = await nextPosition(tx, venues, organisationId, projectId);
  for (const v of plan.venues) {
    if (v.existingId) {
      venueOf.set(v.key, v.existingId);
      continue;
    }
    const [row] = await tx
      .insert(venues)
      .values({
        ...base,
        projectId,
        name: v.name,
        address: v.address,
        notes: v.notes,
        position: position++,
      })
      .returning({ id: venues.id });
    if (row) venueOf.set(v.key, row.id);
  }

  // Personnel, with an ensemble's sections and players.
  const personOf = new Map<string, string>();
  position = await nextPosition(tx, personnel, organisationId, projectId);
  for (const p of plan.personnel) {
    if (p.existingId) {
      personOf.set(p.key, p.existingId);
      continue;
    }
    const [row] = await tx
      .insert(personnel)
      .values({
        ...base,
        projectId,
        name: p.name,
        kind: p.kind,
        role: p.role,
        agreement: p.agreement,
        headphones: p.headphones,
        seating: p.seating,
        position: position++,
      })
      .returning({ id: personnel.id });
    if (!row) continue;
    personOf.set(p.key, row.id);
    for (const [i, s] of p.sections.entries()) {
      const [section] = await tx
        .insert(personnelSections)
        .values({
          ...base,
          personnelId: row.id,
          name: s.name,
          count: s.count,
          divisi: s.divisi,
          position: i,
        })
        .returning({ id: personnelSections.id });
      if (section && s.members.length > 0)
        await tx
          .insert(sectionMembers)
          .values(s.members.map((m, j) => ({ ...base, sectionId: section.id, ...m, position: j })));
    }
  }

  // Works and their tracks; a merged work gains the tracks it lacked, after its own.
  const workOf = new Map<string, string>();
  const trackOf = new Map<string, string>();
  let workPosition = await nextPosition(tx, works, organisationId, projectId);
  let trackPosition = await nextPosition(tx, tracks, organisationId, projectId);
  for (const w of plan.works) {
    const scoreFileId = w.scoreKey ? (fileOf.get(w.scoreKey) ?? null) : null;
    let workId = w.existingId;
    if (!workId) {
      const [row] = await tx
        .insert(works)
        .values({
          ...base,
          projectId,
          title: w.title,
          composer: w.composer,
          forces: w.forces,
          abbreviation: w.abbreviation,
          notes: w.notes,
          scoreFileId,
          pageOffset: w.pageOffset,
          position: workPosition++,
        })
        .returning({ id: works.id });
      workId = row?.id ?? null;
    }
    if (!workId) continue;
    workOf.set(w.key, workId);
    const [lastEntry] = await tx
      .select({ position: max(workTracks.position) })
      .from(workTracks)
      .where(inOrg(workTracks, organisationId, eq(workTracks.workId, workId)));
    let entryPosition = (lastEntry?.position ?? -1) + 1;
    for (const t of w.tracks) {
      if (t.existingId) {
        trackOf.set(t.key, t.existingId);
        continue;
      }
      const [row] = await tx
        .insert(tracks)
        .values({ ...base, projectId, name: t.name, scoreFileId, position: trackPosition++ })
        .returning({ id: tracks.id });
      if (!row) continue;
      trackOf.set(t.key, row.id);
      // Whoever makes a track hears about its new versions, as when one is made by hand.
      await follow(tx, organisationId, userId, { trackId: row.id });
      await tx.insert(workTracks).values({
        ...base,
        workId,
        trackId: row.id,
        number: t.number,
        pageFrom: t.pageFrom,
        pageTo: t.pageTo,
        position: entryPosition++,
      });
    }
  }

  // Sessions, with the tracks their takes are of.
  const sessionOf = new Map<string, string>();
  position = await nextPosition(tx, sessions, organisationId, projectId);
  for (const s of plan.sessions) {
    const [row] = await tx
      .insert(sessions)
      .values({
        ...base,
        projectId,
        name: s.name,
        recordedOn: s.recordedOn,
        venue: s.venue,
        notes: s.notes,
        position: position++,
      })
      .returning({ id: sessions.id });
    if (!row) continue;
    sessionOf.set(s.key, row.id);
    const linked = s.trackKeys.map((k) => trackOf.get(k)).filter((id): id is string => !!id);
    if (linked.length > 0)
      await tx
        .insert(sessionTracks)
        .values(linked.map((trackId) => ({ ...base, sessionId: row.id, trackId })))
        .onConflictDoNothing();
  }

  // Takes.
  const takeRows = plan.takes
    .map((t) => {
      const trackId = trackOf.get(t.trackKey);
      if (!trackId) return null;
      return {
        ...base,
        trackId,
        sessionId: t.sessionKey ? (sessionOf.get(t.sessionKey) ?? null) : null,
        number: t.number,
        notes: t.notes,
        rating: t.rating,
        starred: t.starred,
        lifecycle: t.lifecycle,
        falseStarts: t.falseStarts,
        timecodeIn: t.timecodeIn,
        timecodeOut: t.timecodeOut,
        wallIn: t.wallIn ? new Date(t.wallIn) : null,
        wallOut: t.wallOut ? new Date(t.wallOut) : null,
        page: t.page,
        pageTo: t.pageTo,
        barFrom: t.barFrom,
        barTo: t.barTo,
      };
    })
    .filter((r) => r !== null);
  for (let i = 0; i < takeRows.length; i += 500)
    await tx.insert(takes).values(takeRows.slice(i, i + 500));

  // Categories of issue.
  const categoryOf = new Map<string, string>();
  position = await nextPosition(tx, scoreMarkCategories, organisationId, projectId);
  for (const c of plan.categories) {
    if (c.existingId) {
      categoryOf.set(c.key, c.existingId);
      continue;
    }
    const [row] = await tx
      .insert(scoreMarkCategories)
      .values({
        ...base,
        projectId,
        name: c.name,
        colour: c.colour,
        key: c.shortcut,
        position: position++,
      })
      .returning({ id: scoreMarkCategories.id });
    if (row) categoryOf.set(c.key, row.id);
  }

  // Score marks.
  const markRows = plan.marks
    .map((m) => {
      const trackId = trackOf.get(m.trackKey);
      if (!trackId) return null;
      return {
        ...base,
        trackId,
        kind: m.kind,
        page: m.page,
        x: m.x,
        y: m.y,
        width: m.width,
        height: m.height,
        points: m.points,
        barFrom: m.barFrom,
        barTo: m.barTo,
        text: m.text,
        categoryId: m.categoryKey ? (categoryOf.get(m.categoryKey) ?? null) : null,
        takes: m.takes,
        fixedBy: m.fixedBy,
        resolvedAt: m.resolved ? new Date() : null,
        fromTake: m.from,
        toTake: m.to,
        overdub: m.overdub,
        createdById: userId,
      };
    })
    .filter((r) => r !== null);
  for (let i = 0; i < markRows.length; i += 500)
    await tx.insert(scoreMarks).values(markRows.slice(i, i + 500));

  // The schedule.
  position = await nextPosition(tx, scheduleDays, organisationId, projectId);
  for (const d of plan.days) {
    const [day] = await tx
      .insert(scheduleDays)
      .values({
        ...base,
        projectId,
        label: d.label,
        date: d.date,
        venueId: d.venueKey ? (venueOf.get(d.venueKey) ?? null) : null,
        start: d.start,
        position: position++,
      })
      .returning({ id: scheduleDays.id });
    if (!day) continue;
    for (const [i, r] of d.rows.entries()) {
      const [row] = await tx
        .insert(scheduleRows)
        .values({
          ...base,
          dayId: day.id,
          kind: r.kind,
          start: r.start,
          minutes: r.minutes,
          label: r.label,
          allRepertoire: r.allRepertoire,
          personnel: r.personnel,
          notes: r.notes,
          done: r.done,
          position: i,
        })
        .returning({ id: scheduleRows.id });
      if (!row) continue;
      const items = [
        ...r.workKeys.map((k) => ({ workId: workOf.get(k) ?? null, trackId: null })),
        ...r.trackKeys.map((k) => ({ workId: null, trackId: trackOf.get(k) ?? null })),
      ].filter((item) => item.workId || item.trackId);
      if (items.length > 0)
        await tx
          .insert(scheduleSlotItems)
          .values(items.map((item, j) => ({ ...base, rowId: row.id, ...item, position: j })));
    }
  }

  // Stage boxes and their channels; a merged box gains the channels it lacked.
  const inputOf = new Map<string, string>();
  position = await nextPosition(tx, stageBoxes, organisationId, projectId);
  for (const b of plan.stageBoxes) {
    let boxId = b.existingId;
    if (!boxId) {
      const [row] = await tx
        .insert(stageBoxes)
        .values({ ...base, projectId, name: b.name, position: position++ })
        .returning({ id: stageBoxes.id });
      boxId = row?.id ?? null;
    }
    if (!boxId) continue;
    if (b.existingId) {
      // A merged box's own inputs, so what stands on a new plan still finds its channel.
      const held = await tx
        .select({ id: patchRows.id, channel: patchRows.channel })
        .from(patchRows)
        .where(
          inOrg(
            patchRows,
            organisationId,
            eq(patchRows.stageBoxId, boxId),
            eq(patchRows.direction, "input"),
          ),
        );
      for (const r of held) inputOf.set(`${b.key}:${r.channel}`, r.id);
    }
    for (const [direction, rows] of [
      ["input", b.inputs],
      ["output", b.outputs],
    ] as const) {
      for (const r of rows) {
        const [row] = await tx
          .insert(patchRows)
          .values({ ...base, stageBoxId: boxId, direction, ...r })
          .returning({ id: patchRows.id });
        if (row && direction === "input") inputOf.set(`${b.key}:${r.channel}`, row.id);
      }
    }
  }

  // Stage plans and what stands on them.
  position = await nextPosition(tx, stagePlans, organisationId, projectId);
  for (const p of plan.stagePlans) {
    if (p.existingId) continue;
    const [row] = await tx
      .insert(stagePlans)
      .values({
        ...base,
        projectId,
        name: p.name,
        width: p.width,
        depth: p.depth,
        grid: p.grid,
        position: position++,
      })
      .returning({ id: stagePlans.id });
    if (!row || p.items.length === 0) continue;
    await tx.insert(stageItems).values(
      p.items.map((i) => ({
        ...base,
        stagePlanId: row.id,
        kind: i.kind,
        label: i.label,
        x: i.x,
        y: i.y,
        w: i.w,
        h: i.h,
        rotation: i.rotation,
        personnelId: i.personKey ? (personOf.get(i.personKey) ?? null) : null,
        patchRowId: i.patch ? (inputOf.get(`${i.patch.boxKey}:${i.patch.channel}`) ?? null) : null,
        group: i.group,
      })),
    );
  }
  return fileOf;
}
