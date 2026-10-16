import { z } from "zod";

/** The columns the file browser's list can show beside each name, in their usual order. */
export const fileColumns = [
  "status",
  "versions",
  "people",
  "updated",
  "size",
  "format",
  "duration",
  "tags",
] as const;
export type FileColumn = (typeof fileColumns)[number];

export const minColumnWidth = 64;
export const maxColumnWidth = 480;

/** What someone shows, in their order, and how wide (in pixels) each column is. */
export const fileColumnLayout = z
  .array(
    z
      .object({
        id: z.enum(fileColumns),
        width: z.number().int().min(minColumnWidth).max(maxColumnWidth),
      })
      .strict(),
  )
  .max(fileColumns.length)
  .refine((cols) => new Set(cols.map((c) => c.id)).size === cols.length, "Each column once");
export type FileColumnLayout = z.infer<typeof fileColumnLayout>;

export const fileColumnsInput = z.object({ columns: fileColumnLayout }).strict();

/** The list as it first comes: where things stand, versions, who, and when. */
export const defaultFileColumns: FileColumnLayout = [
  { id: "status", width: 150 },
  { id: "versions", width: 170 },
  { id: "people", width: 100 },
  { id: "updated", width: 100 },
];

/** How wide a column starts when someone adds it. */
export const columnWidths: Record<FileColumn, number> = {
  status: 150,
  versions: 170,
  people: 100,
  updated: 100,
  size: 90,
  format: 140,
  duration: 90,
  tags: 160,
};
