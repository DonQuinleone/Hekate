import { formatBytes } from "./format.ts";
import type { EmbeddedMetadata } from "./media.ts";

/** A frame rate as iXML writes it ("25/1", "30000/1001"), as whole frames a second. */
function framesPerSecond(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d = "1"] = rate.split("/");
  const fps = Number(n) / Number(d);
  return Number.isFinite(fps) && fps > 0 && fps <= 1000 ? Math.round(fps) : null;
}

type Adm = NonNullable<EmbeddedMetadata["adm"]>;

/** "7.1.2 bed + 12 objects": an ADM master's bed and objects, in a phrase. */
export function admShape(adm: Adm): string {
  const bed =
    adm.bed === 0 ? "no bed" : adm.layout ? `${adm.layout} bed` : `${adm.bed}-channel bed`;
  if (adm.objects === 0) return bed;
  const objects = `${adm.objects} ${adm.objects === 1 ? "object" : "objects"}`;
  return adm.bed === 0 ? objects : `${bed} + ${objects}`;
}

/**
 * An ADM master's description in a line (#74), as the QA view and its report show it:
 * "7.1.4 bed + 2 objects · programme “Maple Leaf Rag” · Dolby metadata present".
 */
export function admLine(adm: Adm): string {
  return [
    admShape(adm),
    adm.programme ? `programme “${adm.programme}”` : null,
    adm.dolby ? "Dolby metadata present" : "no Dolby metadata",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the line is headed: Dolby's own metadata marks an Atmos master. */
export const admHeading = (adm: Adm) => (adm.dolby ? "ADM · Dolby Atmos" : "ADM");

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A bext time reference as timecode: samples since midnight at the given rate, with frames
 * where iXML gives the frame rate (`10:00:00:00`), else to the second (`10:00:00`).
 */
export function timecodeOf(samples: number, sampleRate: number, rate?: string): string {
  const seconds = samples / sampleRate;
  const whole = Math.floor(seconds);
  const clock = `${two(Math.floor(whole / 3600) % 24)}:${two(Math.floor(whole / 60) % 60)}:${two(whole % 60)}`;
  const fps = framesPerSecond(rate);
  return fps === null
    ? clock
    : `${clock}:${two(Math.min(fps - 1, Math.floor((seconds - whole) * fps)))}`;
}

/**
 * What a recording says about itself (#41), as the QA view and its report show it: the bext
 * fields, iXML's, then the tags. ISRC and artwork are always listed, as deliveries ask for
 * them; anything else only where the file has it.
 */
export function metadataRows(
  metadata: EmbeddedMetadata,
  sampleRate: number | undefined,
): [string, string][] {
  const rows: [string, string][] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) rows.push([label, value]);
  };
  const { bext, ixml, tags, artwork } = metadata;
  if (bext) {
    add("Description", bext.description);
    add("Originator", bext.originator);
    add("Originator reference", bext.originatorReference);
    add(
      "Origination",
      [bext.originationDate, bext.originationTime?.replaceAll("-", ":").slice(0, 5)]
        .filter(Boolean)
        .join(" "),
    );
    if (bext.timeReference !== undefined && sampleRate)
      add("Time reference", timecodeOf(bext.timeReference, sampleRate, ixml?.timecodeRate));
    // One line a step of its history, as written.
    add(
      "Coding history",
      bext.codingHistory
        ?.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" · "),
    );
  }
  if (ixml) {
    add("iXML", `${formatBytes(ixml.bytes)} embedded`);
    add("Project", ixml.project);
    add("Scene", ixml.scene);
    add("Take", ixml.take);
    add("Tape", ixml.tape);
    add("Note", ixml.note);
  }
  add("Title", tags.title);
  add("Artist", tags.artist);
  add("Album", tags.album);
  add("Album artist", tags.albumArtist);
  add("Composer", tags.composer);
  add("Genre", tags.genre);
  add("Date", tags.date);
  rows.push(["ISRC", tags.isrc ?? "none"]);
  add("Copyright", tags.copyright);
  rows.push([
    "Artwork",
    artwork
      ? `${artwork.codec === "mjpeg" ? "JPEG" : artwork.codec.toUpperCase()} ${artwork.width} × ${artwork.height}`
      : "none",
  ]);
  return rows;
}
