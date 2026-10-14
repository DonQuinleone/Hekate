import { z } from "zod";

export const fileKinds = ["audio", "video", "document", "image", "other"] as const;
export type FileKind = (typeof fileKinds)[number];

const byExtension: Record<string, FileKind> = {};
const add = (kind: FileKind, extensions: string) => {
  for (const ext of extensions.split(" ")) byExtension[ext] = kind;
};
add(
  "audio",
  "wav w64 bwf rf64 aif aiff aifc caf flac mp3 m4a aac ogg oga opus wv ape dsf dff ac3 eac3 mka",
);
add("video", "mov mp4 m4v mxf mkv webm avi mts m2ts ts mpg mpeg");
add("image", "jpg jpeg png gif webp tif tiff heic heif avif bmp svg");
add("document", "pdf doc docx odt rtf txt md xml musicxml mxl mei mscz mscx ly sib dorico");

/**
 * What kind of file this is, from its type and name. The kind only decides which
 * tools appear and which jobs run; nothing about delivery depends on it.
 */
export function fileKindOf(name: string, contentType: string): FileKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const fromName = name.includes(".") ? byExtension[ext] : undefined;
  if (fromName) return fromName;
  const [top] = contentType.toLowerCase().split("/");
  if (top === "audio" || top === "video" || top === "image") return top;
  if (contentType === "application/pdf" || top === "text") return "document";
  return "other";
}

/** A content type as clients send it, reduced to a safe `type/subtype`. */
export function cleanContentType(value: string | undefined): string {
  const type = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(type)
    ? type
    : "application/octet-stream";
}

/** Drop C0 control characters and DEL, which have no place in a displayed name. */
const withoutControls = (value: string) =>
  [...value]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join("");

/** A file name for display: no path, no control characters, at most 255 characters. */
export const fileName = z
  .string()
  .transform((v) =>
    withoutControls(v.split(/[\\/]/).pop() ?? "")
      .trim()
      .slice(0, 255),
  )
  .pipe(z.string().min(1, "A file needs a name"));

export const createUploadInput = z.object({
  projectId: z.uuid(),
  folderId: z.uuid().nullable().optional(),
  name: fileName,
  /** Plaintext size in bytes. */
  size: z.number().int().nonnegative(),
  contentType: z.string().max(200).optional(),
});
export type CreateUploadInput = z.input<typeof createUploadInput>;

/** A PDF, by its type or its name: the documents whose pages are drawn, scores among them. */
export const isPdf = (name: string, contentType: string) =>
  contentType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
