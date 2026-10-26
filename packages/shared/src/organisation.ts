import { z } from "zod";
import { locales } from "./account.ts";
import { downloadLevels } from "./downloads.ts";
import {
  type EmailSubjects,
  emailSubjects,
  emailSubjectsChange,
  emailTemplateIds,
} from "./email.ts";
import { projectProfile } from "./profile.ts";
import { profileRef } from "./qa.ts";
import {
  commentScopes,
  defaultReviewerPermissions,
  type ReviewerPermissions,
} from "./reviewer-permissions.ts";
import { defaultProjectRoles, type PlayerTool, playerTool, playerTools } from "./roles.ts";

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

/** How a guest's link opens: by itself, or with a code sent to the guest's address as well. */
export const guestVerifications = ["link", "code"] as const;
export type GuestVerification = (typeof guestVerifications)[number];

/** Who in a workspace must sign in with a second factor. */
export const secondFactorPolicies = ["off", "admins", "everyone"] as const;
export const secondFactorPolicy = z.enum(secondFactorPolicies);
export type SecondFactorPolicy = z.infer<typeof secondFactorPolicy>;

/**
 * Whether someone must have a second factor before they act in a workspace: when the instance
 * asks it of every account, or the workspace of everyone, or of owners and admins and they are one.
 */
export function secondFactorRequired(o: {
  instance: boolean;
  policy: SecondFactorPolicy;
  role: OrganisationRole;
}): boolean {
  if (o.instance || o.policy === "everyone") return true;
  return o.policy === "admins" && atLeast(o.role, "admin");
}

/** How a session was signed in: a password alone, a password and a second factor, a passkey. */
export const sessionFactors = ["password", "second_factor", "passkey"] as const;
export type SessionFactor = (typeof sessionFactors)[number];

/** What a workspace (or the instance) asks of someone's sign-in. */
export interface FactorDemand {
  /** A second factor: a code app or a passkey. */
  secondFactor: boolean;
  /** A passkey or hardware security key, specifically. */
  securityKey: boolean;
}

/**
 * What is asked of this person: the second factor as `secondFactorRequired` says, and a
 * hardware security key when the workspace asks one of owners and admins and they are one.
 */
export function factorDemand(o: {
  instance: boolean;
  policy: SecondFactorPolicy;
  securityKeyForAdmins: boolean;
  role: OrganisationRole;
}): FactorDemand {
  const securityKey = o.securityKeyForAdmins && atLeast(o.role, "admin");
  return { secondFactor: securityKey || secondFactorRequired(o), securityKey };
}

/** Whether a session signed in this way meets what is asked. */
export function sessionMeets(factor: SessionFactor, demand: FactorDemand): boolean {
  if (demand.securityKey) return factor === "passkey";
  if (demand.secondFactor) return factor !== "password";
  return true;
}

/**
 * The ways a member signs in (decision 248): a password, a passkey or hardware security key on
 * its own, the workspace's single sign-on, or its directory (LDAP). A workspace allows some.
 */
export const signInMethods = ["password", "passkey", "sso", "directory"] as const;
export const signInMethod = z.enum(signInMethods);
export type SignInMethod = z.infer<typeof signInMethod>;

export const signInMethodLabels: Record<SignInMethod, string> = {
  password: "Password",
  passkey: "Passkey",
  sso: "Single sign-on",
  directory: "Directory (LDAP)",
};

/** Each method as a sentence names it: "does not take signing in with a password". */
export const signInMethodWords: Record<SignInMethod, string> = {
  password: "a password",
  passkey: "a passkey",
  sso: "single sign-on",
  directory: "its directory",
};

/** Words joined as a sentence lists them: "a, b or c". */
export const orList = (words: readonly string[]) =>
  words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;

/**
 * How a session was signed in, as its methods are counted: what it recorded, or for a session
 * from before it recorded one, single sign-on where a provider made it and otherwise its factor
 * (a passkey, or a password with or without a code).
 */
export function sessionMethod(session: {
  method?: SignInMethod | null;
  factor: SessionFactor;
  ssoProviderId?: string | null;
}): SignInMethod {
  if (session.method) return session.method;
  if (session.ssoProviderId) return "sso";
  return session.factor === "passkey" ? "passkey" : "password";
}

/**
 * The methods that let this member into a workspace: the ones it allows. An owner also keeps a
 * password and a passkey where it allows only ways that lean on another system (single sign-on,
 * a directory), so that system failing never locks the workspace out, as with enforced single
 * sign-on (#37).
 */
export function methodsFor(
  allowed: readonly SignInMethod[],
  role: OrganisationRole,
): SignInMethod[] {
  const ownWay = allowed.includes("password") || allowed.includes("passkey");
  const methods = role === "owner" && !ownWay ? [...allowed, "password", "passkey"] : allowed;
  return signInMethods.filter((m) => methods.includes(m));
}

/** How long a session lasts in a workspace, in days from signing in; null is the instance's own. */
export const sessionDayChoices = [1, 7, 14, 30] as const;

/**
 * When a session stops working in a workspace (decision 248): at the instance's expiry (sliding,
 * as it is used), or `days` after it was signed in, whichever comes first.
 */
export function sessionEndsAt(
  session: { createdAt: Date; expiresAt: Date },
  days: number | null,
): Date {
  if (days === null) return session.expiresAt;
  const limit = new Date(session.createdAt.getTime() + days * 24 * 60 * 60 * 1000);
  return limit < session.expiresAt ? limit : session.expiresAt;
}

/** The roles every project starts with, whose tools the workspace chooses (#55). */
export const defaultRoleNames = ["Producer", "Engineer", "Editor", "Reviewer", "Viewer"] as const;
export type DefaultRoleName = (typeof defaultRoleNames)[number];

/** The tools each default role starts with unless the workspace says otherwise. */
const startingRoleTools = Object.fromEntries(
  defaultRoleNames.map((name) => [
    name,
    defaultProjectRoles.find((r) => r.name === name)?.tools ?? [...playerTools],
  ]),
) as Record<DefaultRoleName, PlayerTool[]>;

/**
 * A workspace's settings (decision 037 names it a workspace; code keeps organisation). Each takes
 * effect where it applies: guest links when sent, the language for members without their own,
 * reviewer permissions when a review is requested.
 */
export const workspaceSettingsSchema = z.object({
  /** The profile the new-project form starts on. */
  defaultProfile: projectProfile,
  guestLinkDays: z.literal(guestLinkDays),
  /** Whether opening a guest link also asks for a code sent to the guest's address. */
  guestVerification: z.enum(guestVerifications),
  /** Dates and numbers for members who have not chosen; null follows each browser. */
  locale: z.enum(locales).nullable(),
  /** Whether a new project shows threads carried to a new version (decision 029). */
  carriedCommentsShown: z.boolean(),
  /** What recordings are measured against where nothing nearer chooses (#144). */
  deliveryProfile: profileRef.nullable(),
  /** The workspace's own subject lines for its messages. */
  emailSubjects,
  /** Who must sign in with a second factor. */
  secondFactor: secondFactorPolicy,
  /** Whether owners and admins must sign in with a passkey or hardware security key. */
  securityKeyForAdmins: z.boolean(),
  /** The ways members may sign in (decision 248); guests always use their link. */
  signInMethods: z
    .array(signInMethod)
    .min(1, "Allow at least one way to sign in")
    .max(signInMethods.length)
    .refine((m) => new Set(m).size === m.length, "Name each way once"),
  /** Days from signing in after which a session ends here; null is the instance's own length. */
  sessionDays: z.literal(sessionDayChoices).nullable(),
  /**
   * Whether recordings' downloads carry an inaudible mark for their recipient (#32). Owners
   * change it, through its own route, never with the other settings.
   */
  forensicAudio: z.boolean(),
  /** The player tools each default role starts with in a new project (#55); projects override. */
  roleTools: z.object(
    Object.fromEntries(
      defaultRoleNames.map((name) => [name, z.array(playerTool).max(playerTools.length)]),
    ) as Record<DefaultRoleName, z.ZodArray<typeof playerTool>>,
  ),
  /** What a review grants unless the request says otherwise. */
  reviewer: z.object({
    comment: z.boolean(),
    decide: z.boolean(),
    comments: z.enum(commentScopes),
    /** A track's earlier versions as well as the one under review. */
    history: z.boolean(),
    /** What they may download; a member's role is the ceiling. */
    download: z.enum(downloadLevels),
    windowDays: z.literal(accessWindowDays).nullable(),
  }),
});
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const defaultWorkspaceSettings: WorkspaceSettings = {
  defaultProfile: "music",
  guestLinkDays: 3,
  guestVerification: "link",
  locale: null,
  carriedCommentsShown: true,
  deliveryProfile: null,
  emailSubjects: {},
  secondFactor: "off",
  securityKeyForAdmins: false,
  signInMethods: [...signInMethods],
  sessionDays: null,
  forensicAudio: false,
  roleTools: startingRoleTools,
  reviewer: {
    comment: true,
    decide: true,
    comments: "all",
    history: false,
    download: "none",
    windowDays: null,
  },
};

/** A change to some settings; the rest stay. */
export const workspaceSettingsInput = z
  .object({
    defaultProfile: workspaceSettingsSchema.shape.defaultProfile.optional(),
    guestLinkDays: workspaceSettingsSchema.shape.guestLinkDays.optional(),
    guestVerification: workspaceSettingsSchema.shape.guestVerification.optional(),
    locale: workspaceSettingsSchema.shape.locale.optional(),
    carriedCommentsShown: workspaceSettingsSchema.shape.carriedCommentsShown.optional(),
    deliveryProfile: workspaceSettingsSchema.shape.deliveryProfile.optional(),
    emailSubjects: emailSubjectsChange.optional(),
    secondFactor: workspaceSettingsSchema.shape.secondFactor.optional(),
    securityKeyForAdmins: workspaceSettingsSchema.shape.securityKeyForAdmins.optional(),
    signInMethods: workspaceSettingsSchema.shape.signInMethods.optional(),
    sessionDays: workspaceSettingsSchema.shape.sessionDays.optional(),
    roleTools: workspaceSettingsSchema.shape.roleTools.partial().strict().optional(),
    reviewer: workspaceSettingsSchema.shape.reviewer.partial().strict().optional(),
  })
  .strict()
  .refine(
    (s) =>
      Object.keys(s).length > 0 &&
      (!s.reviewer || Object.keys(s.reviewer).length > 0) &&
      (!s.roleTools || Object.keys(s.roleTools).length > 0) &&
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
    guestVerification: pick(
      shape.guestVerification,
      read(stored, "guestVerification"),
      d.guestVerification,
    ),
    locale: pick(shape.locale, read(stored, "locale"), d.locale),
    carriedCommentsShown: pick(
      shape.carriedCommentsShown,
      read(stored, "carriedCommentsShown"),
      d.carriedCommentsShown,
    ),
    deliveryProfile: pick(
      shape.deliveryProfile,
      read(stored, "deliveryProfile"),
      d.deliveryProfile,
    ),
    emailSubjects: Object.fromEntries(
      emailTemplateIds.flatMap((id) => {
        const subject = read(read(stored, "emailSubjects"), id);
        const parsed = emailSubjects.safeParse({ [id]: subject });
        return parsed.success && parsed.data[id] ? [[id, parsed.data[id]]] : [];
      }),
    ) as EmailSubjects,
    secondFactor: pick(shape.secondFactor, read(stored, "secondFactor"), d.secondFactor),
    securityKeyForAdmins: pick(
      shape.securityKeyForAdmins,
      read(stored, "securityKeyForAdmins"),
      d.securityKeyForAdmins,
    ),
    signInMethods: pick(shape.signInMethods, read(stored, "signInMethods"), d.signInMethods),
    sessionDays: pick(shape.sessionDays, read(stored, "sessionDays"), d.sessionDays),
    forensicAudio: pick(shape.forensicAudio, read(stored, "forensicAudio"), d.forensicAudio),
    roleTools: Object.fromEntries(
      defaultRoleNames.map((name) => [
        name,
        pick(shape.roleTools.shape[name], read(read(stored, "roleTools"), name), d.roleTools[name]),
      ]),
    ) as Record<DefaultRoleName, PlayerTool[]>,
    reviewer: {
      comment: pick(reviewer.comment, read(storedReviewer, "comment"), d.reviewer.comment),
      decide: pick(reviewer.decide, read(storedReviewer, "decide"), d.reviewer.decide),
      comments: pick(reviewer.comments, read(storedReviewer, "comments"), d.reviewer.comments),
      history: pick(reviewer.history, read(storedReviewer, "history"), d.reviewer.history),
      download: pick(reviewer.download, read(storedReviewer, "download"), d.reviewer.download),
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
    guestVerification: change.guestVerification ?? current.guestVerification,
    locale: change.locale === undefined ? current.locale : change.locale,
    carriedCommentsShown: change.carriedCommentsShown ?? current.carriedCommentsShown,
    deliveryProfile:
      change.deliveryProfile === undefined ? current.deliveryProfile : change.deliveryProfile,
    emailSubjects: Object.fromEntries(
      Object.entries({ ...current.emailSubjects, ...change.emailSubjects }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ) as EmailSubjects,
    secondFactor: change.secondFactor ?? current.secondFactor,
    securityKeyForAdmins: change.securityKeyForAdmins ?? current.securityKeyForAdmins,
    signInMethods: change.signInMethods ?? current.signInMethods,
    sessionDays: change.sessionDays === undefined ? current.sessionDays : change.sessionDays,
    forensicAudio: current.forensicAudio,
    roleTools: { ...current.roleTools, ...change.roleTools },
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
