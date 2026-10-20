import { z } from "zod";

/**
 * Personnel (#49, docs/domain.md): everyone on a production. Artists, ensembles, staff and
 * others, each with whether the session agreement is signed and whether they need headphones.
 * An ensemble is set out in sections, each a head-count before names are known, then its named
 * members (who carry the same two flags) and how it divides.
 */
export const personnelKinds = ["artist", "ensemble", "staff", "other"] as const;
export type PersonnelKind = (typeof personnelKinds)[number];

const text = (max: number) => z.string().trim().max(max);

export const sectionMemberInput = z.object({
  name: text(80).min(1, "Name the player"),
  agreement: z.boolean().default(false),
  headphones: z.boolean().default(false),
});
export type SectionMemberInput = z.input<typeof sectionMemberInput>;

export const sectionInput = z.object({
  name: text(60).min(1, "Name the section"),
  /** Players in it, named or not; never fewer than those named. */
  count: z.number().int().min(0).max(500),
  /** How it splits, for example "2 + 2". */
  divisi: text(40).default(""),
  members: z.array(sectionMemberInput).max(500).default([]),
});
export type SectionInput = z.input<typeof sectionInput>;

/** Who someone on the production is in Hekate: a member of the workspace, or a guest. */
export const personnelLinkInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("guest"), guestId: z.uuid() }),
]);
export type PersonnelLink = z.infer<typeof personnelLinkInput>;

export const personnelInput = z
  .object({
    name: text(120).min(1, "Give a name"),
    kind: z.enum(personnelKinds),
    /** What they do here: "Conductor", "Piano", "Engineer", "Strings". */
    role: text(80).default(""),
    agreement: z.boolean().default(false),
    headphones: z.boolean().default(false),
    link: personnelLinkInput.nullable().default(null),
    sections: z.array(sectionInput).max(60).default([]),
    /** Seating and forces: "Antiphonal violins; basses behind the cellos." */
    seating: text(400).default(""),
  })
  .refine((p) => p.kind === "ensemble" || p.sections.length === 0, {
    message: "Only an ensemble has sections",
    path: ["sections"],
  })
  .refine((p) => p.sections.every((s) => s.members.length <= s.count), {
    message: "A section names no more players than it counts",
    path: ["sections"],
  });
export type PersonnelInput = z.input<typeof personnelInput>;

export interface SectionMember {
  id: string;
  name: string;
  agreement: boolean;
  headphones: boolean;
}

export interface Section {
  id: string;
  name: string;
  count: number;
  divisi: string;
  members: SectionMember[];
}

export interface Personnel {
  id: string;
  name: string;
  kind: PersonnelKind;
  role: string;
  agreement: boolean;
  headphones: boolean;
  /** The member or guest this is, with the name Hekate knows them by. */
  link: (PersonnelLink & { name: string }) | null;
  sections: Section[];
  seating: string;
}

/** Someone a personnel entry can be linked to: the project's members and its guests. */
export interface LinkablePerson {
  kind: "member" | "guest";
  id: string;
  name: string;
}

/** How many play in an ensemble, or one for anyone else. */
export function headCount(p: Pick<Personnel, "kind" | "sections">): number {
  if (p.kind !== "ensemble") return 1;
  return p.sections.reduce((n, s) => n + Math.max(s.count, s.members.length), 0);
}

/**
 * Who of an entry still owes a signed agreement or needs headphones: the entry itself, or for an
 * ensemble its named players (those not yet named are counted, as they cannot be ticked off).
 */
export function outstanding(p: Pick<Personnel, "kind" | "agreement" | "headphones" | "sections">) {
  if (p.kind !== "ensemble" || p.sections.every((s) => s.members.length === 0))
    return {
      unsigned: p.agreement ? 0 : headCount(p),
      headphones: p.headphones ? headCount(p) : 0,
    };
  const named = p.sections.flatMap((s) => s.members);
  const unnamed = p.sections.reduce((n, s) => n + Math.max(0, s.count - s.members.length), 0);
  return {
    unsigned: named.filter((m) => !m.agreement).length + unnamed,
    headphones: named.filter((m) => m.headphones).length,
  };
}

/**
 * The block an ensemble takes on a stage plan (#53), in metres: its players in rows a little
 * wider than deep, a metre across and 1.2 m front to back each, as orchestral seating allows.
 */
export function ensembleBlock(players: number): { w: number; h: number } {
  const n = Math.max(1, players);
  const across = Math.min(n, Math.ceil(Math.sqrt(n * 1.5)));
  const rows = Math.ceil(n / across);
  return { w: across, h: Math.round(rows * 1.2 * 100) / 100 };
}
