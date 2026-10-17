import { type Database, inOrg, schema } from "@hekate/db";
import { watermarkText } from "@hekate/shared";
import { eq } from "drizzle-orm";
import type { Actor } from "./access.ts";

const { guests, organisations, users } = schema;

/**
 * The visible mark's words for whoever is looking (#31): their name and email, the workspace,
 * and today. A member's come from their account, a guest's from the review that invited them.
 * Null when the person is not found, which the caller treats as nothing to show.
 */
export async function viewerMark(
  db: Pick<Database, "select">,
  actor: Actor,
  now = new Date(),
): Promise<string | null> {
  const [organisation] = await db
    .select({ name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, actor.organisationId));
  if (!organisation) return null;
  if (actor.kind === "guest") {
    const [guest] = await db
      .select({ name: guests.name, email: guests.email })
      .from(guests)
      .where(inOrg(guests, actor.organisationId, eq(guests.id, actor.guestId)));
    return guest ? watermarkText(guest, organisation.name, now) : null;
  }
  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, actor.userId));
  return user ? watermarkText(user, organisation.name, now) : null;
}
