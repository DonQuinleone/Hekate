import { type Database, inOrg, schema } from "@hekate/db";
import {
  type MediaInfo,
  type Normalisation,
  type NormalisationMode,
  normalisedGain,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { profilesForFiles } from "./delivery-profiles.ts";

const { loudness } = schema;

type Reader = Pick<Database, "select">;

/**
 * How a file plays normalised (#240), or null when it does not: the project has it off; it is
 * each person's choice and this one may not make it (a role without the tool, or a guest); the
 * file has no audio, is not yet measured, or its delivery profile names no loudness target.
 * Only the volume reaches the browser, never the measurements behind it.
 */
export async function normalisationOf(
  db: Reader,
  organisationId: string,
  file: { id: string; mediaInfo: MediaInfo | null },
  mode: NormalisationMode,
  mayChoose: boolean,
): Promise<Normalisation | null> {
  if (mode === "off" || (mode === "optional" && !mayChoose)) return null;
  const channels = file.mediaInfo?.audio?.channels;
  if (!channels) return null;
  const [measured] = await db
    .select({ summary: loudness.summary })
    .from(loudness)
    .where(inOrg(loudness, organisationId, eq(loudness.fileId, file.id)));
  const integrated = measured?.summary.integrated;
  if (integrated === null || integrated === undefined) return null;
  const profiles = await profilesForFiles(db, organisationId, [file.id]);
  const target = profiles.of(file.id, channels).profile.loudness?.target;
  if (target === undefined) return null;
  return { mode, target, gain: normalisedGain(integrated, target) };
}
