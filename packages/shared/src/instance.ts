import { z } from "zod";

/**
 * The instance side (#155, decision 062): who may open it and what they see. Operators see
 * everything; a workspace's owner who is not an operator sees their own workspaces only.
 */

export const instanceSectionIds = [
  "overview",
  "workspaces",
  "operators",
  "health",
  "logs",
  "debug",
  "system",
  "settings",
] as const;
export type InstanceSection = (typeof instanceSectionIds)[number];

export const instanceSections: Record<InstanceSection, { label: string; hint: string }> = {
  overview: { label: "Overview", hint: "What needs an operator, and what moved" },
  workspaces: {
    label: "Workspaces",
    hint: "Every tenant, with its people, projects and storage",
  },
  operators: { label: "Operators", hint: "The accounts that may manage the instance" },
  logs: {
    label: "Logs",
    hint: "What people and operators did, every sign-in, the mail the instance sent and every webhook",
  },
  health: {
    label: "System health",
    hint: "The machine, measured: load, latency, errors, queues and services",
  },
  system: {
    label: "System information",
    hint: "Version, build, channel, releases and the environment",
  },
  settings: {
    label: "Settings",
    hint: "Modules, security, defaults for new workspaces, address and mail, and maintenance mode",
  },
  debug: {
    label: "Debug tools",
    hint: "Look up an error reference, see what failed, inspect what is not working",
  },
};

/** What a viewer may open on the instance side. */
export function instanceSectionsFor(access: { operator: boolean }): InstanceSection[] {
  return access.operator ? [...instanceSectionIds] : ["workspaces"];
}

/** Who someone is on the instance side, and whether their sign-in lets them act as an operator. */
export interface InstanceAccess {
  operator: boolean;
  /** An operator whose session was not signed in with a passkey or security key. */
  keyNeeded: boolean;
  /** Workspaces they own, which they reach here whether or not they operate the instance. */
  owned: { id: string; name: string }[];
}

/** May they open the instance side at all? */
export const reachesInstance = (access: Pick<InstanceAccess, "operator" | "owned">) =>
  access.operator || access.owned.length > 0;

/** An operator in a path: their account's id, as the auth library makes it. */
export const operatorParam = z.object({ userId: z.string().min(1).max(64) });

/** Making an existing account an operator, by its address. */
export const operatorInput = z.object({ email: z.email({ error: "An email address" }) });

export interface OperatorRow {
  userId: string;
  name: string;
  email: string;
  /** Passkeys and hardware security keys they hold, and whether a code app guards them. */
  keys: number;
  hardwareKeys: number;
  codeApp: boolean;
  lastSignInAt: string | null;
  since: string;
  addedBy: string | null;
}

export interface InstanceOverview {
  workspaces: number;
  people: number;
  storageBytes: number;
  /** Null when the queue could not be read. */
  queue: { waiting: number; active: number; failedToday: number } | null;
  /** What needs an operator, most pressing first. */
  needs: {
    kind:
      | "failed_jobs"
      | "missing_objects"
      | "key_missing"
      | "queue_unreadable"
      | "release_available";
    title: string;
    detail: string;
  }[];
  recent: { at: string; actor: string | null; action: string; target: string | null }[];
}

/** Where a workspace stands. Trials arrive with billing (#180). */
export const workspaceStates = ["active", "suspended"] as const;
export type WorkspaceState = (typeof workspaceStates)[number];

export interface InstanceWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  state: WorkspaceState;
  suspendedAt: string | null;
  suspendedReason: string | null;
  /** When it is purged, with everything in it, unless reinstated first. */
  deleteAfter: string | null;
  members: number;
  projects: number;
  storageBytes: number;
}

/** One page of the workspace list: by name, then id; `after` is the last id of the page before. */
export const instanceWorkspacesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  state: z.enum(workspaceStates).optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface InstanceWorkspacePage {
  workspaces: InstanceWorkspace[];
  /** How many match the search and filter, across every page. */
  total: number;
  /** Pass as `after` for the next page; null on the last. */
  next: string | null;
}

/** A subdomain: lower-case letters, digits and single hyphens, as in an address. */
export const workspaceSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, {
    error: "Letters, digits and hyphens, up to 40, not starting or ending with a hyphen",
  });

/** A new workspace, made by an operator: its first owner is invited by address. */
export const newWorkspaceInput = z.object({
  name: z.string().trim().min(1, "Name the workspace").max(120),
  slug: workspaceSlug,
  ownerEmail: z.email({ error: "An email address" }).max(254),
});
export type NewWorkspaceInput = z.infer<typeof newWorkspaceInput>;

/** Suspending a workspace says why; its members read the reason. */
export const suspendWorkspaceInput = z.object({
  reason: z.string().trim().min(1, "Say why").max(500),
});

/** A workspace in figures, as its Overview tab shows it. */
export interface InstanceWorkspaceDetail extends InstanceWorkspace {
  guests: number;
  activeReviews: number;
  /** How its members sign in: password (and passkeys), or its single sign-on. */
  signIn: { method: "password" | "sso"; provider: string | null; secondFactor: boolean };
  /** Invitations to it still waiting, such as its first owner's. */
  invited: { email: string; role: string; expiresAt: string }[];
  recent: { at: string; actor: string; action: string }[];
}

/** How long a workspace waits, suspended, between an operator deleting it and its purge. */
export const WORKSPACE_DELETE_GRACE_DAYS = 30;

/** Where a workspace's bytes are, as its Storage tab shows them. */
export interface InstanceWorkspaceStorage {
  /** Before encryption: uploaded originals, and what Hekate made from them. */
  originalBytes: number;
  derivedBytes: number;
  /** The backend its new objects go to, and whether that is the instance's default. */
  backend: string;
  backendIsDefault: boolean;
  backends: { name: string; objects: number; bytes: number }[];
  /** What the last reconciliations found and have not yet resolved. */
  findings: { missing: number; orphans: number };
}

/** What the workspace's owner sees in its settings, for an operator to read. */
export interface InstanceWorkspaceSettings {
  guestLinkDays: number;
  guestVerification: string;
  secondFactor: string;
  securityKeyForAdmins: boolean;
  locale: string | null;
  defaultProfile: string;
  sso: { protocol: string; enforced: boolean } | null;
  directory: boolean;
}

/** The workspace's key: each version, and how much is still wrapped by an older one. */
export interface InstanceWorkspaceKeys {
  versions: { version: number; createdAt: string }[];
  current: number | null;
  /** Data keys still wrapped by an earlier version; the rewrap brings them to zero. */
  pending: number;
}

export interface InstanceMemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  lastSeenAt: string | null;
  /** The strongest second factor they hold. */
  factor: "key" | "app" | "none";
}

export interface InstanceProjectRow {
  id: string;
  name: string;
  profile: string;
  archived: boolean;
  files: number;
  storageBytes: number;
  openReviews: number;
}

/** An instance event in words, for the Overview's "Recently". */
export const instanceActions: Record<string, string> = {
  "operator.added": "made an operator",
  "operator.removed": "removed as an operator",
  "operator.sessions_revoked": "signed out everywhere by an operator",
  "workspace.created": "made, its owner invited",
  "workspace.suspended": "suspended",
  "workspace.reinstated": "reinstated",
  "workspace.deletion_scheduled": "set to be deleted",
  "workspace.deletion_cancelled": "kept, its deletion cancelled",
  "workspace.purged": "deleted, with everything in it",
  "workspace.key_rotated": "given a new key",
  "workspace.project_moved": "moved to another workspace by an operator",
  "member.sessions_revoked": "signed out everywhere by an operator",
  "member.password_reset": "sent a password reset by an operator",
  "member.second_factor_reset": "had their second factor reset by an operator",
  "debug.inspected": "inspected in Debug tools",
  "debug.job_retried": "run again from Debug tools",
  "debug.webhook_replayed": "sent again from Debug tools",
  "mail.sends_again": "sent mail again, after a bounce report",
  "flag.on": "turned on",
  "flag.off": "turned off",
  "settings.second_factor_on": "required of every account",
  "settings.second_factor_off": "no longer required of every account",
  "updates.channel": "changed",
  "maintenance.on": "turned on",
  "maintenance.off": "turned off",
  "maintenance.message": "given a new notice",
  "storage.reconcile": "checked against the database by an operator",
  "defaults.guest_link_days": "given a new lifetime",
  "logs.export": "exported",
  "logs.retention": "given a new retention",
  "logs.purged": "trimmed to what the settings keep",
};

/** Where a workspace stands, from its record. */
export const workspaceStateOf = (w: { suspendedAt: Date | string | null }): WorkspaceState =>
  w.suspendedAt ? "suspended" : "active";
