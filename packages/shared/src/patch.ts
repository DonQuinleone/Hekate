import { z } from "zod";

/**
 * The patch list (#54, docs/domain.md): a project's stage boxes, each with numbered input and
 * output channels, and what each carries.
 */
export const patchDirections = ["input", "output"] as const;
export type PatchDirection = (typeof patchDirections)[number];

export const stageBoxInput = z.object({
  name: z.string().trim().min(1, "Name the stage box").max(60),
});

const field = (max: number) => z.string().trim().max(max);

export const patchRowInput = z.object({
  direction: z.enum(patchDirections),
  /** Its channel on the box; the next free one when not given. */
  channel: z.number().int().min(1).max(999).optional(),
  source: field(80).default(""),
  device: field(80).default(""),
  cable: field(40).default(""),
  notes: field(200).default(""),
});
export type PatchRowInput = z.input<typeof patchRowInput>;

/** What changes on a channel; its box and direction stay. */
export const patchRowChangeInput = z
  .object({
    channel: z.number().int().min(1).max(999),
    source: field(80),
    device: field(80),
    cable: field(40),
    notes: field(200),
  })
  .partial()
  .refine((c) => Object.keys(c).length > 0, { message: "Nothing to change" });
export type PatchRowChange = z.infer<typeof patchRowChangeInput>;

export interface PatchRow {
  id: string;
  channel: number;
  source: string;
  device: string;
  cable: string;
  notes: string;
}

export interface StageBox {
  id: string;
  name: string;
  inputs: PatchRow[];
  outputs: PatchRow[];
}

/** The next channel to give on a box's inputs or outputs: one past the highest. */
export function nextChannel(rows: Pick<PatchRow, "channel">[]): number {
  return rows.reduce((top, r) => Math.max(top, r.channel), 0) + 1;
}
