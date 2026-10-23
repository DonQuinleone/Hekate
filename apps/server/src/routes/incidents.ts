import { type Database, schema } from "@hekate/db";
import { incidentInput, incidentMomentProblem, incidentUpdateInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import { type Status, withUpdates } from "../status.ts";

const { incidents, incidentUpdates } = schema;

interface IncidentVariables {
  userId: string;
}

export interface IncidentDeps {
  db: Database;
  status: Status;
  trustProxy: boolean;
  now?: () => Date;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** How many incidents the desk lists: the open ones and the latest resolved. */
const DESK_LIMIT = 50;

/**
 * `/api/instance/incidents` (#183): the operators post incidents for the status page from the
 * support desk, with updates through to a resolution. Behind `operatorsOnly`; each change is an
 * instance event, and the page is read afresh after it.
 */
export const incidentRoutes = (deps: IncidentDeps) => {
  const { db } = deps;
  const clock = deps.now ?? (() => new Date());
  const ipOf = (c: Context) => requestInfo(c, deps.trustProxy).ipAddress ?? null;
  const moment = (at: string | undefined, field: string, now: Date) => {
    if (!at) return;
    const problem = incidentMomentProblem(at, now);
    if (problem) throw new CodedException(422, "incident_moment", `${field}: ${problem}`);
  };
  const desk = async () => ({
    incidents: await withUpdates(
      db,
      await db
        .select()
        .from(incidents)
        .orderBy(desc(incidents.startedAt), desc(incidents.id))
        .limit(DESK_LIMIT),
      true,
    ),
    now: await deps.status.now(),
  });
  return (
    new Hono<{ Variables: IncidentVariables }>()
      .get("/", async (c) => c.json(await desk()))
      // A new incident and its first update; one posted after the fact says when it began.
      .post("/", zValidator("json", incidentInput), async (c) => {
        const input = c.req.valid("json");
        const now = clock();
        moment(input.startedAt, "Began", now);
        moment(input.resolvedAt, "Ended", now);
        const startedAt = input.startedAt ? new Date(input.startedAt) : now;
        const resolvedAt =
          input.state === "resolved" ? (input.resolvedAt ? new Date(input.resolvedAt) : now) : null;
        if (resolvedAt && resolvedAt < startedAt)
          throw new CodedException(422, "incident_moment", "Ended: It cannot end before it began");
        const id = await db.transaction(async (tx) => {
          const [made] = await tx
            .insert(incidents)
            .values({
              title: input.title,
              impact: input.impact,
              services: input.services,
              state: input.state,
              startedAt,
              resolvedAt,
              createdBy: c.var.userId,
            })
            .returning({ id: incidents.id });
          if (!made) throw new Error("The incident was not made");
          await tx.insert(incidentUpdates).values({
            incidentId: made.id,
            state: input.state,
            body: input.body,
            createdBy: c.var.userId,
            createdAt: now,
          });
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "incident.posted",
            target: input.title,
            details: {
              incidentId: made.id,
              impact: input.impact,
              services: input.services,
              state: input.state,
            },
            ipAddress: ipOf(c),
          });
          return made.id;
        });
        deps.status.forget();
        return c.json({ id, ...(await desk()) }, 201);
      })
      // An update: where it stands now, and what it touches if that changed. Resolving ends it;
      // an update to a resolved incident opens it again.
      .post("/:id/updates", idParam, zValidator("json", incidentUpdateInput), async (c) => {
        const { id } = c.req.valid("param");
        const input = c.req.valid("json");
        const now = clock();
        await db.transaction(async (tx) => {
          // Two operators updating at once take turns, so its state is the last one written.
          const [incident] = await tx
            .select()
            .from(incidents)
            .where(eq(incidents.id, id))
            .for("update");
          if (!incident) throw new NotFound("Incident");
          const resolving = input.state === "resolved";
          await tx
            .update(incidents)
            .set({
              state: input.state,
              ...(input.impact ? { impact: input.impact } : {}),
              ...(input.services ? { services: input.services } : {}),
              resolvedAt: resolving ? (incident.resolvedAt ?? now) : null,
              updatedAt: now,
            })
            .where(eq(incidents.id, id));
          await tx.insert(incidentUpdates).values({
            incidentId: id,
            state: input.state,
            body: input.body,
            createdBy: c.var.userId,
            createdAt: now,
          });
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: resolving && !incident.resolvedAt ? "incident.resolved" : "incident.updated",
            target: incident.title,
            details: {
              incidentId: id,
              state: input.state,
              ...(input.impact ? { impact: input.impact } : {}),
              ...(input.services ? { services: input.services } : {}),
            },
            ipAddress: ipOf(c),
          });
        });
        deps.status.forget();
        return c.json(await desk(), 201);
      })
      // One posted by mistake comes off the page, with its updates.
      .delete("/:id", idParam, async (c) => {
        const { id } = c.req.valid("param");
        await db.transaction(async (tx) => {
          const [gone] = await tx
            .delete(incidents)
            .where(eq(incidents.id, id))
            .returning({ title: incidents.title });
          if (!gone) throw new NotFound("Incident");
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "incident.removed",
            target: gone.title,
            details: { incidentId: id },
            ipAddress: ipOf(c),
          });
        });
        deps.status.forget();
        return c.json(await desk());
      })
  );
};
