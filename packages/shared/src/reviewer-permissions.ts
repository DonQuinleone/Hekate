import { z } from "zod";
import { downloadLevels, widestDownload } from "./downloads.ts";

/**
 * What one reviewer may do in one review (docs/domain.md, Reviewer permissions). A guest
 * gets exactly this; a member gets no more than their project role allows as well.
 */

/** Whose comments a reviewer sees: everyone's, their own and the replies to them, or their own. */
export const commentScopes = ["all", "own_and_replies", "own"] as const;
export type CommentScope = (typeof commentScopes)[number];

/**
 * The engineer's tools a review can leave out. Loops are an interface tool, hidden only;
 * QA (findings and measurements), meters (loudness), the spectrogram, the score and compare
 * (the sources to compare with, and where the same music sits in them) are refused by the
 * server too. A grant made before compare existed lacks it, as it had none.
 */
export const reviewerTools = ["spectrogram", "meters", "loops", "compare", "qa", "score"] as const;
export type ReviewerTool = (typeof reviewerTools)[number];

const when = z.iso.datetime({ offset: true }).nullable();

export const reviewerPermissions = z
  .object({
    /** Leave comments. */
    comment: z.boolean(),
    /** Record an approval decision (approvals only). */
    decide: z.boolean(),
    comments: z.enum(commentScopes),
    tools: z.array(z.enum(reviewerTools)).max(reviewerTools.length),
    /** What they may download: nothing unless the review says so. Grants made earlier lack it. */
    download: z.enum(downloadLevels).default("none"),
    /** A track's earlier versions as well as the one under review. */
    history: z.boolean().default(false),
    /** Which of the review's items they see, by item id; null is every item. */
    items: z.array(z.uuid()).max(500).nullable().default(null),
    /** How many times they may start playing each file; null is without limit. */
    maxPlays: z.number().int().min(1).max(1000).nullable().default(null),
    /** The review opens to them from this moment; null is at once. */
    startsAt: when,
    /** And closes to them at this one; null is when the review ends. */
    expiresAt: when,
  })
  .refine((p) => !p.startsAt || !p.expiresAt || Date.parse(p.expiresAt) > Date.parse(p.startsAt), {
    message: "Access must end after it starts",
    path: ["expiresAt"],
  });
export type ReviewerPermissions = z.infer<typeof reviewerPermissions>;

/** What a reviewer gets unless the review says otherwise: everything, for as long as it runs. */
export const defaultReviewerPermissions: ReviewerPermissions = {
  comment: true,
  decide: true,
  comments: "all",
  tools: [...reviewerTools],
  download: "none",
  history: false,
  items: null,
  maxPlays: null,
  startsAt: null,
  expiresAt: null,
};

/** A grant as stored: one made before a field existed lacks it, and reads as its default. */
export type StoredGrant = Omit<ReviewerPermissions, "download" | "history" | "items" | "maxPlays"> &
  Partial<Pick<ReviewerPermissions, "download" | "history" | "items" | "maxPlays">>;

/** A stored grant with every field: what it says, or the default for what it predates. */
export const readGrant = (grant: StoredGrant): ReviewerPermissions => ({
  download: "none",
  history: false,
  items: null,
  maxPlays: null,
  ...grant,
});

/** A change to some of a reviewer's permissions; the rest stay as they are. */
export const reviewerPermissionsChange = z.object({
  comment: z.boolean().optional(),
  decide: z.boolean().optional(),
  comments: z.enum(commentScopes).optional(),
  tools: z.array(z.enum(reviewerTools)).max(reviewerTools.length).optional(),
  download: z.enum(downloadLevels).optional(),
  history: z.boolean().optional(),
  items: z.array(z.uuid()).max(500).nullable().optional(),
  maxPlays: z.number().int().min(1).max(1000).nullable().optional(),
  startsAt: when.optional(),
  expiresAt: when.optional(),
});
export type ReviewerPermissionsChange = z.infer<typeof reviewerPermissionsChange>;

/** A change applied, checked as a whole (an end before the start is refused). */
export function applyPermissions(
  current: ReviewerPermissions,
  change: ReviewerPermissionsChange,
): z.ZodSafeParseResult<ReviewerPermissions> {
  const tools = change.tools ? [...new Set(change.tools)] : current.tools;
  return reviewerPermissions.safeParse({ ...current, ...change, tools });
}

/** Whether the reviewer's access window is open at a moment. */
export function withinWindow(p: Pick<ReviewerPermissions, "startsAt" | "expiresAt">, now: Date) {
  if (p.startsAt && now.getTime() < Date.parse(p.startsAt)) return false;
  if (p.expiresAt && now.getTime() >= Date.parse(p.expiresAt)) return false;
  return true;
}

const scopeWidth: Record<CommentScope, number> = { own: 0, own_and_replies: 1, all: 2 };

/**
 * What someone reaching a file through several reviews may do with it: whatever any of
 * those reviews allows. (Decisions belong to one review, so they are not merged.)
 */
export function mergeGrants(
  stored: StoredGrant[],
): Pick<ReviewerPermissions, "comment" | "comments" | "tools" | "download" | "maxPlays"> | null {
  if (stored.length === 0) return null;
  const grants = stored.map(readGrant);
  return {
    download: widestDownload(grants.map((g) => g.download)),
    comment: grants.some((g) => g.comment),
    comments: grants.reduce<CommentScope>(
      (wide, g) => (scopeWidth[g.comments] > scopeWidth[wide] ? g.comments : wide),
      "own",
    ),
    tools: reviewerTools.filter((t) => grants.some((g) => g.tools.includes(t))),
    // Without limit if any review says so; otherwise the most any allows.
    maxPlays: grants.some((g) => g.maxPlays === null)
      ? null
      : Math.max(...grants.map((g) => g.maxPlays ?? 0)),
  };
}

/**
 * The comments a reviewer may see, by scope. A thread is one level deep: "their own and the
 * replies to them" is what they wrote and every reply in the threads they started.
 */
export function visibleComments<
  C extends { id: string; parentId: string | null; author: string | null },
>(comments: C[], scope: CommentScope, me: string): C[] {
  if (scope === "all") return comments;
  const mine = new Set(comments.filter((c) => !c.parentId && c.author === me).map((c) => c.id));
  return comments.filter(
    (c) =>
      c.author === me ||
      (scope === "own_and_replies" && c.parentId !== null && mine.has(c.parentId)),
  );
}
