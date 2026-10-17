import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { type Audit, systemActor } from "./audit.ts";
import type { Storage } from "./storage.ts";
import { sessionOf } from "./uploads.ts";

const { files, projects, uploads, variations } = schema;

/**
 * Deletes the projects whose deletion was confirmed (#240) once their seven days are over:
 * every row they hold, at once, in one transaction; their stored bytes go at the next storage
 * reconciliation, as a deleted file's do. Unfinished uploads are discarded within the same
 * transaction, once the project is claimed; if one cannot be, that project waits for the next run.
 * Deliberately instance-wide (no organisation condition) to find what is due: it runs as a
 * scheduled job, never for a request, and each project is then handled within its own
 * organisation. Returns how many projects went.
 */
export async function purgeDueProjects(
  db: Database,
  storage: Storage,
  audit: Audit,
  now = new Date(),
): Promise<number> {
  const due = await db
    .select({ id: projects.id, organisationId: projects.organisationId })
    .from(projects)
    .where(and(isNotNull(projects.deleteAfter), lte(projects.deleteAfter, now)));
  let purged = 0;
  for (const project of due) {
    if (await purgeProject(db, storage, audit, project, now)) purged += 1;
  }
  return purged;
}

async function purgeProject(
  db: Database,
  storage: Storage,
  audit: Audit,
  project: { id: string; organisationId: string },
  now: Date,
): Promise<boolean> {
  const { id, organisationId } = project;
  try {
    return await db.transaction(async (tx) => {
      // Claimed first: keeping the project takes the same lock, so it waits for this to finish,
      // and nothing below runs for a project someone has just kept.
      const [current] = await tx
        .select({ name: projects.name, deleteAfter: projects.deleteAfter })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, id)))
        .for("update");
      if (!current?.deleteAfter || current.deleteAfter > now) return false;
      // Uploads still under way keep their parts where no listing finds them: discard them
      // while their rows say where. One that cannot be stops this run, and nothing is deleted.
      const unfinished = await tx
        .select()
        .from(uploads)
        .where(
          inOrg(
            uploads,
            organisationId,
            eq(uploads.projectId, id),
            inArray(uploads.status, ["open", "completing"]),
          ),
        );
      for (const upload of unfinished) await storage.abortUpload(sessionOf(upload));
      // A variation holds on to its file, so variations go before the cascade reaches files.
      const ofProject = tx
        .select({ id: files.id })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.projectId, id)));
      await tx
        .delete(variations)
        .where(inOrg(variations, organisationId, inArray(variations.fileId, ofProject)));
      await tx.delete(projects).where(inOrg(projects, organisationId, eq(projects.id, id)));
      // The log keeps the project's id and name: the event outlives what it describes.
      await audit.record(
        organisationId,
        systemActor,
        { action: "project.delete", projectId: id, details: { name: current.name } },
        undefined,
        tx,
      );
      return true;
    });
  } catch (error) {
    console.error(`Could not delete project ${id}; will retry`, error);
    return false;
  }
}
