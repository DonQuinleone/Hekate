import { type Database, schema } from "@hekate/db";
import {
  type DateFormats,
  effectiveDateFormats,
  instanceSettingsOf,
  workspaceSettingsOf,
} from "@hekate/shared";
import { eq } from "drizzle-orm";

type Reader = Pick<Database, "select">;

/** The instance's own formats (#481), as its settings hold them now. */
export async function instanceDateFormats(db: Reader): Promise<DateFormats> {
  const [row] = await db
    .select({ settings: schema.instanceSettings.settings })
    .from(schema.instanceSettings);
  return instanceSettingsOf(row?.settings).dates;
}

/**
 * How a workspace's dates read in its mail and documents (#481): as it chose, or as the
 * instance chose where it did not. Read from the database each time: mail and reports are few,
 * and a change reaches the next one. `stored` is the workspace's settings column, when the
 * caller has read it already.
 */
export async function workspaceDateFormats(
  db: Reader,
  organisationId: string,
  stored?: unknown,
): Promise<DateFormats> {
  let settings = stored;
  if (settings === undefined) {
    const [row] = await db
      .select({ settings: schema.organisations.settings })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, organisationId));
    settings = row?.settings;
  }
  return effectiveDateFormats(workspaceSettingsOf(settings), await instanceDateFormats(db));
}
