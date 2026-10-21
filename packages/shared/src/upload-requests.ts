import { z } from "zod";
import { fileName } from "./files.ts";

/**
 * Upload requests (#139): a link for someone outside a project, with no account, to upload a
 * few files into one of its folders. The link reads nothing; it only accepts files, up to its
 * limit, until it expires or is closed.
 */

/** The most files one request accepts, and the longest it stays open. */
export const UPLOAD_REQUEST_MAX_FILES = 100;
export const UPLOAD_REQUEST_MAX_DAYS = 90;

export const createUploadRequestInput = z.object({
  name: z.string().trim().min(1, "Give the request a name").max(120),
  /** What is wanted, shown to the visitor. */
  wanted: z.string().trim().max(2000).default(""),
  /** The folder files arrive in; null for the project's top level. */
  folderId: z.uuid().nullable(),
  fileLimit: z.int().min(1).max(UPLOAD_REQUEST_MAX_FILES),
  /** The day it closes, at the end of that day where Hekate runs (UTC). */
  expiresOn: z.iso.date(),
  /** Asked for before anything can be sent; stored only as a hash. */
  password: z.string().min(8, "At least eight characters").max(128).optional(),
  /** Someone to send the link to, with the workspace's upload request mail. */
  email: z.email().max(254).optional(),
});
export type CreateUploadRequestInput = z.input<typeof createUploadRequestInput>;

/** The visitor's password, when the request has one. */
export const unlockUploadRequestInput = z.object({ password: z.string().min(1).max(128) });

/** A file the visitor starts to send. */
export const visitorUploadInput = z.object({
  name: fileName,
  size: z.number().int().positive(),
  contentType: z.string().max(200).optional(),
  /** Who is sending, so the project knows: "Ines Arlow". */
  sender: z.string().trim().min(1, "Say who you are").max(120),
});
export type VisitorUploadInput = z.input<typeof visitorUploadInput>;

/** Where a request stands, for its page and its list. */
export type UploadRequestState = "open" | "full" | "expired" | "closed";

/** Its state at `now`: closed by hand, past its day, full, or open. */
export function uploadRequestState(
  request: { closedAt: Date | string | null; expiresAt: Date | string; fileLimit: number },
  arrived: number,
  now = new Date(),
): UploadRequestState {
  if (request.closedAt) return "closed";
  if (new Date(request.expiresAt).getTime() <= now.getTime()) return "expired";
  if (arrived >= request.fileLimit) return "full";
  return "open";
}

/** The end of the given day (UTC): the moment a request closes. */
export const endOfDay = (day: string) => new Date(`${day}T23:59:59.999Z`);
