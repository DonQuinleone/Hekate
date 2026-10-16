import { z } from "zod";
import { locales } from "./account.ts";
import {
  type EmailSubjects,
  emailSubjects,
  emailSubjectsChange,
  emailTemplateIds,
} from "./email.ts";
import { projectProfile } from "./profile.ts";
import {
  commentScopes,
  defaultReviewerPermissions,
  type ReviewerPermissions,
} from "./reviewer-permissions.ts";

/** Organisation-level roles, highest first. Per-project roles are a separate model. */
export const organisationRoles = ["owner", "admin", "member"] as const;
export const organisationRole = z.enum(organisationRoles);
export type OrganisationRole = z.infer<typeof organisationRole>;

const rank: Record<OrganisationRole, number> = { owner: 3, admin: 2, member: 1 };

/** True when `role` is at least `required`. */
export function atLeast(role: OrganisationRole, required: OrganisationRole): boolean {
  return rank[role] >= rank[required];
}

export const inviteInput = z.object({
  email: z.email().max(254),
  role: organisationRole.default("member"),
});

export const acceptInvitationInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(12).max(256).optional(),
});

/** Choose the storage backend for an organisation's new objects; null uses the instance default. */
export const organisationStorageInput = z.object({
  backend: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/)
    .nullable(),
});

/** Rename a workspace (an organisation in code). */
export const organisationUpdateInput = z.object({
  name: z.string().trim().min(1).max(120),
});
export type OrganisationUpdateInput = z.infer<typeof organisationUpdateInput>;

/** How long a guest's magic link works, in days. */
export const guestLinkDays = [3, 14, 30] as const;
/** How long a review stays open to a reviewer unless the request says otherwise; null is while it runs. */
export const accessWindowDays = [14, 30] as const;

/**
 * A workspace's settings (decision 037 names it a workspace; code keeps organisation). Each takes
 * effect where it applies: guest links when sent, the language for members without their own,
 * reviewer permissions when a review is requested.
 */
export const workspaceSettingsSchema = z.object({
  /** The profile the new-project form starts on. */
  defaultProfile: projectProfile,
  guestLinkDays: z.literal(guestLinkDays),
  /** Dates and numbers for members who have not chosen; null follows each browser. */
  locale: z.enum(locales).nullable(),
  /** Whether a new project shows threads carried to a new version (decision 029). */
  carriedCommentsShown: z.boolean(),
  /** The workspace's own subject lines for its messages. */
  emailSubjects,
  /** What a review grants unless the request says otherwise. */
  reviewer: z.object({
    comment: z.boolean(),
    decide: z.boolean(),
    comments: z.enum(commentScopes),
    windowDays: z.literal(accessWindowDays).nullable(),
  }),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const defaultWorkspaceSettings: WorkspaceSettings = {
  defaultProfile: "music",
  guestLinkDays: 3,
  locale: null,
  carriedCommentsShown: true,
  emailSubjects: {},
  reviewer: { comment: true, decide: true, comments: "all", windowDays: null },
};

/** A change to some settings; the rest stay. */
export const workspaceSettingsInput = z
  .object({
    defaultProfile: workspaceSettingsSchema.shape.defaultProfile.optional(),
    guestLinkDays: workspaceSettingsSchema.shape.guestLinkDays.optional(),
    locale: workspaceSettingsSchema.shape.locale.optional(),
    carriedCommentsShown: workspaceSettingsSchema.shape.carriedCommentsShown.optional(),
    emailSubjects: emailSubjectsChange.optional(),
    reviewer: workspaceSettingsSchema.shape.reviewer.partial().strict().optional(),
  })
  .strict()
  .refine(
    (s) =>
      Object.keys(s).length > 0 &&
      (!s.reviewer || Object.keys(s.reviewer).length > 0) &&
      (!s.emailSubjects || Object.keys(s.emailSubjects).length > 0),
    "Nothing to change",
  );
export type WorkspaceSettingsInput = z.infer<typeof workspaceSettingsInput>;

/** Stored settings read safely: anything missing or no longer valid falls back to the default. */
export function workspaceSettingsOf(stored: unknown): WorkspaceSettings {
  const read = (from: unknown, key: string) =>
    from && typeof from === "object" ? (from as Record<string, unknown>)[key] : undefined;
  const pick = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : fallback;
  };
  const shape = workspaceSettingsSchema.shape;
  const reviewer = shape.reviewer.shape;
  const storedReviewer = read(stored, "reviewer");
  const d = defaultWorkspaceSettings;
  return {
    defaultProfile: pick(shape.defaultProfile, read(stored, "defaultProfile"), d.defaultProfile),
    guestLinkDays: pick(shape.guestLinkDays, read(stored, "guestLinkDays"), d.guestLinkDays),
    locale: pick(shape.locale, read(stored, "locale"), d.locale),
    carriedCommentsShown: pick(
      shape.carriedCommentsShown,
      read(stored, "carriedCommentsShown"),
      d.carriedCommentsShown,
    ),
    emailSubjects: Object.fromEntries(
      emailTemplateIds.flatMap((id) => {
        const subject = read(read(stored, "emailSubjects"), id);
        const parsed = emailSubjects.safeParse({ [id]: subject });
        return parsed.success && parsed.data[id] ? [[id, parsed.data[id]]] : [];
      }),
    ) as EmailSubjects,
    reviewer: {
      comment: pick(reviewer.comment, read(storedReviewer, "comment"), d.reviewer.comment),
      decide: pick(reviewer.decide, read(storedReviewer, "decide"), d.reviewer.decide),
      comments: pick(reviewer.comments, read(storedReviewer, "comments"), d.reviewer.comments),
      windowDays: pick(
        reviewer.windowDays,
        read(storedReviewer, "windowDays"),
        d.reviewer.windowDays,
      ),
    },
  };
}

/** Settings with a change applied. */
export function applyWorkspaceSettings(
  current: WorkspaceSettings,
  change: WorkspaceSettingsInput,
): WorkspaceSettings {
  return {
    defaultProfile: change.defaultProfile ?? current.defaultProfile,
    guestLinkDays: change.guestLinkDays ?? current.guestLinkDays,
    locale: change.locale === undefined ? current.locale : change.locale,
    carriedCommentsShown: change.carriedCommentsShown ?? current.carriedCommentsShown,
    emailSubjects: Object.fromEntries(
      Object.entries({ ...current.emailSubjects, ...change.emailSubjects }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ) as EmailSubjects,
    reviewer: { ...current.reviewer, ...change.reviewer },
  };
}

/**
 * The permissions a new reviewer starts with in this workspace: the defaults, and an access
 * window counted from `from` (when their access opens).
 */
export function reviewerDefaults(settings: WorkspaceSettings, from: Date): ReviewerPermissions {
  const { windowDays, ...rest } = settings.reviewer;
  return {
    ...defaultReviewerPermissions,
    ...rest,
    expiresAt: windowDays
      ? new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000).toISOString()
      : null,
  };
}
