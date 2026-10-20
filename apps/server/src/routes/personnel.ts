import { type Database, inOrg, schema } from "@hekate/db";
import {
  type LinkablePerson,
  type Personnel,
  type PersonnelLink,
  personnelInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  groupMembers,
  groups,
  guests,
  personnel,
  personnelSections,
  projectMembers,
  reviewReviewers,
  reviews,
  sectionMembers,
  users,
} = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select" | "selectDistinct">;

/** A project's personnel in order, each with its sections, players and who it is in Hekate. */
export async function personnelOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<Personnel[]> {
  const entries = await db
    .select({
      id: personnel.id,
      name: personnel.name,
      kind: personnel.kind,
      role: personnel.role,
      agreement: personnel.agreement,
      headphones: personnel.headphones,
      seating: personnel.seating,
      userId: personnel.userId,
      userName: users.name,
      guestId: personnel.guestId,
      guestName: guests.name,
    })
    .from(personnel)
    .leftJoin(users, eq(users.id, personnel.userId))
    // A guest of this workspace only.
    .leftJoin(
      guests,
      and(eq(guests.id, personnel.guestId), eq(guests.organisationId, organisationId)),
    )
    .where(inOrg(personnel, organisationId, eq(personnel.projectId, projectId)))
    .orderBy(asc(personnel.position), asc(personnel.createdAt));
  if (entries.length === 0) return [];
  const sections = await db
    .select({
      id: personnelSections.id,
      personnelId: personnelSections.personnelId,
      name: personnelSections.name,
      count: personnelSections.count,
      divisi: personnelSections.divisi,
    })
    .from(personnelSections)
    .where(
      inOrg(
        personnelSections,
        organisationId,
        inArray(
          personnelSections.personnelId,
          entries.map((e) => e.id),
        ),
      ),
    )
    .orderBy(asc(personnelSections.position));
  const players =
    sections.length === 0
      ? []
      : await db
          .select({
            id: sectionMembers.id,
            sectionId: sectionMembers.sectionId,
            name: sectionMembers.name,
            agreement: sectionMembers.agreement,
            headphones: sectionMembers.headphones,
          })
          .from(sectionMembers)
          .where(
            inOrg(
              sectionMembers,
              organisationId,
              inArray(
                sectionMembers.sectionId,
                sections.map((s) => s.id),
              ),
            ),
          )
          .orderBy(asc(sectionMembers.position));
  // A link counts while its person is still one the project knows: someone who has left it is
  // shown unlinked while they are away, and saving the entry then clears the link.
  const linkable = new Set(
    (await linkableOf(db, organisationId, projectId)).map((p) => `${p.kind}:${p.id}`),
  );
  return entries.map(({ userId, userName, guestId, guestName, ...e }) => ({
    ...e,
    link:
      userId && userName && linkable.has(`member:${userId}`)
        ? { kind: "member" as const, userId, name: userName }
        : guestId && guestName && linkable.has(`guest:${guestId}`)
          ? { kind: "guest" as const, guestId, name: guestName }
          : null,
    sections: sections
      .filter((s) => s.personnelId === e.id)
      .map(({ personnelId: _p, ...s }) => ({
        ...s,
        members: players.filter((m) => m.sectionId === s.id).map(({ sectionId: _s, ...m }) => m),
      })),
  }));
}

/**
 * Who an entry may be linked to: the project's members, and the guests its reviews and groups
 * ask. Names only: a guest's address is not the production's business.
 */
export async function linkableOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<LinkablePerson[]> {
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)))
    .orderBy(asc(users.name));
  const asked = await db
    .selectDistinct({ id: guests.id, name: guests.name })
    .from(reviewReviewers)
    .innerJoin(reviews, eq(reviews.id, reviewReviewers.reviewId))
    .innerJoin(guests, eq(guests.id, reviewReviewers.guestId))
    .where(
      and(
        inOrg(reviewReviewers, organisationId),
        inOrg(reviews, organisationId, eq(reviews.projectId, projectId)),
        inOrg(guests, organisationId),
      ),
    );
  const grouped = await db
    .selectDistinct({ id: guests.id, name: guests.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(guests, eq(guests.id, groupMembers.guestId))
    .where(
      and(
        inOrg(groupMembers, organisationId),
        inOrg(groups, organisationId, eq(groups.projectId, projectId)),
        inOrg(guests, organisationId),
      ),
    );
  const known = [...new Map([...asked, ...grouped].map((g) => [g.id, g])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return [
    ...people.map((p) => ({ kind: "member" as const, ...p })),
    ...known.map((g) => ({ kind: "guest" as const, ...g })),
  ];
}

/** The member or guest an entry is linked to, if they may be: one the project knows. */
async function checkedLink(
  tx: Tx,
  organisationId: string,
  projectId: string,
  link: PersonnelLink | null,
) {
  if (!link) return { userId: null, guestId: null };
  const known = await linkableOf(tx, organisationId, projectId);
  const id = link.kind === "member" ? link.userId : link.guestId;
  if (!known.some((p) => p.kind === link.kind && p.id === id))
    throw new HTTPException(400, {
      message: "Link someone who is a member or a guest of this project",
    });
  return link.kind === "member"
    ? { userId: link.userId, guestId: null }
    : { userId: null, guestId: link.guestId };
}

/** An ensemble's sections and players as given, in place of those it had. */
async function writeSections(
  tx: Tx,
  organisationId: string,
  personnelId: string,
  sections: z.infer<typeof personnelInput>["sections"],
) {
  await tx
    .delete(personnelSections)
    .where(
      inOrg(personnelSections, organisationId, eq(personnelSections.personnelId, personnelId)),
    );
  for (const [position, { members, ...section }] of sections.entries()) {
    const [made] = await tx
      .insert(personnelSections)
      .values({ organisationId, personnelId, position, ...section })
      .returning({ id: personnelSections.id });
    if (made && members.length > 0)
      await tx
        .insert(sectionMembers)
        .values(members.map((m, i) => ({ organisationId, sectionId: made.id, position: i, ...m })));
  }
}

/**
 * `/api/projects/:id/personnel` (#49): everyone on the production and who they may be linked
 * to, for those who see the production tools; adding someone, for those who use them.
 */
export const projectPersonnelRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/personnel", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({
        personnel: await personnelOf(db, organisationId, projectId),
        people: await linkableOf(db, organisationId, projectId),
      });
    })
    .post("/:id/personnel", idParam, zValidator("json", personnelInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      const { link, sections, ...entry } = c.req.valid("json");
      const id = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        const linked = await checkedLink(tx, organisationId, projectId, link);
        const [last] = await tx
          .select({ position: max(personnel.position) })
          .from(personnel)
          .where(inOrg(personnel, organisationId, eq(personnel.projectId, projectId)));
        const [made] = await tx
          .insert(personnel)
          .values({
            organisationId,
            projectId,
            ...entry,
            ...linked,
            position: (last?.position ?? -1) + 1,
          })
          .returning({ id: personnel.id });
        if (!made) throw new Error("The entry was not written");
        await writeSections(tx, organisationId, made.id, sections);
        return made.id;
      });
      const [listed] = (await personnelOf(db, organisationId, projectId)).filter(
        (p) => p.id === id,
      );
      return c.json({ entry: listed }, 201);
    });

/** The entry, and its project, for someone who may change the production's personnel. */
async function entryFor(db: Database, vars: TenantVariables, id: string) {
  const [entry] = await db
    .select({ id: personnel.id, projectId: personnel.projectId })
    .from(personnel)
    .where(inOrg(personnel, vars.organisationId, eq(personnel.id, id)));
  if (!entry) throw new NotFound("Entry");
  await can(db, actorOf(vars), "edit_production", entry.projectId);
  return entry;
}

/** `/api/personnel/:id`: changing an entry (its sections and players with it), or removing it. */
export const personnelRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .put("/:id", idParam, zValidator("json", personnelInput), async (c) => {
      const organisationId = c.var.organisationId;
      const entry = await entryFor(db, c.var, c.req.valid("param").id);
      const { link, sections, ...fields } = c.req.valid("json");
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, entry.projectId);
        const linked = await checkedLink(tx, organisationId, entry.projectId, link);
        await tx
          .update(personnel)
          .set({ ...fields, ...linked, updatedAt: new Date() })
          .where(inOrg(personnel, organisationId, eq(personnel.id, entry.id)));
        await writeSections(tx, organisationId, entry.id, sections);
      });
      const [listed] = (await personnelOf(db, organisationId, entry.projectId)).filter(
        (p) => p.id === entry.id,
      );
      return c.json({ entry: listed });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const entry = await entryFor(db, c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, entry.projectId);
        await tx
          .delete(personnel)
          .where(inOrg(personnel, organisationId, eq(personnel.id, entry.id)));
      });
      return c.body(null, 204);
    });
