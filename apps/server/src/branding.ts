import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, schema } from "@hekate/db";
import {
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  type PublicBranding,
  publicBranding,
  storedBrandingOf,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import type { EmailBrand } from "./email/render.ts";
import type { Mailer } from "./mail.ts";
import { run } from "./media/ffmpeg.ts";

/**
 * Workspace branding (#185, decision 226): its logo, made safe to show to anyone, and its
 * logo and accent read for the pages and mail that show them.
 */

/** A logo that cannot be used, in words for the admin who chose it. */
export class LogoRefused extends Error {
  override name = "LogoRefused";
}

/** ffmpeg's demuxer for each kind of image a logo may be made from. */
type ImageDemuxer = "png_pipe" | "jpeg_pipe" | "webp_pipe";

/** What an image is, by its first bytes rather than by what the request said it was. */
export function sniffImage(bytes: Uint8Array): ImageDemuxer | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png_pipe";
  if (starts([0xff, 0xd8, 0xff])) return "jpeg_pipe";
  // RIFF, a size, then WEBP.
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp_pipe";
  return null;
}

/** The width and height a PNG's header gives. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (sniffImage(png) !== "png_pipe" || png.length < 24) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Wider or taller than this, an image is refused before it is decoded. */
const LARGEST_SOURCE_SIDE = 8192;

/**
 * Makes an uploaded image into a logo anyone may be shown: decoded and drawn again as a fresh
 * PNG, at most 512 pixels a side, with nothing of the original kept but its pixels (no
 * metadata, no other chunks, nothing appended). Only PNG, JPEG and WebP are taken, each opened
 * with its own demuxer alone and only from a file; SVG never, as it can carry script.
 */
export async function sanitiseLogo(
  bytes: Uint8Array,
  workDir = tmpdir(),
): Promise<{ png: Buffer; width: number; height: number }> {
  if (bytes.length === 0) throw new LogoRefused("The file is empty.");
  if (bytes.length > LOGO_MAX_BYTES) throw new LogoRefused("A logo can be at most 2 MB.");
  const demuxer = sniffImage(bytes);
  if (!demuxer) throw new LogoRefused("A logo is a PNG, JPEG or WebP image.");
  const dir = await mkdtemp(join(workDir, "logo-"));
  const input = join(dir, "source");
  const output = join(dir, "logo.png");
  const opened = ["-protocol_whitelist", "file", "-format_whitelist", demuxer, "-f", demuxer];
  try {
    await writeFile(input, bytes);
    const probed = await run(
      "ffprobe",
      [
        "-hide_banner",
        ...["-v", "error", ...opened],
        ...["-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json"],
        `file:${input}`,
      ],
      { timeoutMs: 15_000, maxOutput: 64 * 1024 },
    ).catch(() => {
      throw new LogoRefused("That image could not be read.");
    });
    const stream = (
      JSON.parse(probed.stdout) as { streams?: { width?: number; height?: number }[] }
    ).streams?.[0];
    if (!stream?.width || !stream.height) throw new LogoRefused("That image could not be read.");
    if (stream.width > LARGEST_SOURCE_SIDE || stream.height > LARGEST_SOURCE_SIDE)
      throw new LogoRefused("That image is too large: keep it within 8192 pixels a side.");
    const fit = `min(${LOGO_MAX_SIDE},iw)`;
    const fitH = `min(${LOGO_MAX_SIDE},ih)`;
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        ...["-v", "error", "-nostdin", ...opened],
        ...["-i", `file:${input}`],
        ...["-frames:v", "1", "-map_metadata", "-1"],
        ...["-vf", `scale=w='${fit}':h='${fitH}':force_original_aspect_ratio=decrease,format=rgba`],
        ...["-c:v", "png", "-f", "image2", "-update", "1", "-y", `file:${output}`],
      ],
      { timeoutMs: 30_000 },
    ).catch(() => {
      throw new LogoRefused("That image could not be read.");
    });
    const png = await readFile(output);
    const size = pngSize(png);
    if (!size || size.width > LOGO_MAX_SIDE || size.height > LOGO_MAX_SIDE)
      throw new LogoRefused("That image could not be read.");
    return { png, ...size };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A workspace's branding as its public pages show it; null when it has none. */
export async function brandingOf(
  db: Database,
  organisationId: string,
  base = "",
): Promise<PublicBranding | null> {
  const [row] = await db
    .select({ branding: schema.organisations.branding })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  if (!row) return null;
  return publicBranding(organisationId, storedBrandingOf(row.branding), base);
}

/** A workspace's branding as its mail carries it: the logo at the instance's address. */
export function emailBrandOf(branding: PublicBranding | null): EmailBrand | undefined {
  if (!branding) return undefined;
  return {
    ...(branding.logo ? { logo: branding.logo } : {}),
    ...(branding.accent ? { accent: branding.accent.dark } : {}),
  };
}

/**
 * The mailer, able to say each workspace's branding, so every message sent for a workspace
 * carries its logo and accent wherever it is sent from.
 */
export function brandedMailer<M extends Mailer>(mailer: M, db: Database, publicUrl: string): M {
  const base = publicUrl.replace(/\/$/, "");
  return {
    ...mailer,
    // Bound to the mailer it came from: a spread keeps the method, not its `this`.
    send: (message) => mailer.send(message),
    ...(mailer.verify ? { verify: () => mailer.verify?.() } : {}),
    brand: async (organisationId: string) =>
      emailBrandOf(await brandingOf(db, organisationId, base)),
  };
}
