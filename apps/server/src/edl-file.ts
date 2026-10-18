import { type Database, inOrg, schema } from "@hekate/db";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Storage } from "./storage.ts";

const { files } = schema;

/** A list longer than this is no edit decision list. */
const MAX_LIST_BYTES = 1024 * 1024;

/**
 * An edit decision list's text, read from storage (#56), with its name; null where the file is
 * gone or holds nothing yet. The list is text about an edit, not media, so it is read on the
 * server and never sent as a file.
 */
export async function readEdlFile(
  db: Database,
  storage: Storage,
  organisationId: string,
  fileId: string,
): Promise<{ name: string; text: string } | null> {
  const [list] = await db
    .select({ name: files.name, blobId: files.blobId, byteSize: files.byteSize })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!list?.blobId) return null;
  if (list.byteSize > MAX_LIST_BYTES)
    throw new HTTPException(422, { message: "This edit decision list is too long to read" });
  const { stream } = await storage.open(organisationId, list.blobId);
  return { name: list.name, text: Buffer.concat(await stream.toArray()).toString("utf8") };
}
