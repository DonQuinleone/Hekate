import { z } from "zod";

/**
 * The instance side (#155, decision 062): who may open it and what they see. Operators see
 * everything; a workspace's owner who is not an operator sees their own workspaces only.
 */

export const instanceSectionIds = ["overview", "workspaces", "operators"] as const;
export type InstanceSection = (typeof instanceSectionIds)[number];

export const instanceSections: Record<InstanceSection, { label: string; hint: string }> = {
  overview: { label: "Overview", hint: "What needs an operator, and what moved" },
  workspaces: {
    label: "Workspaces",
    hint: "Every tenant, with its people, projects and storage",
  },
  operators: { label: "Operators", hint: "The accounts that may manage the instance" },
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
    kind: "failed_jobs" | "missing_objects" | "key_missing" | "queue_unreadable";
    title: string;
    detail: string;
  }[];
  recent: { at: string; actor: string | null; action: string; target: string | null }[];
}

export interface InstanceWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  members: number;
  projects: number;
  storageBytes: number;
}

/** An instance event in words, for the Overview's "Recently". */
export const instanceActions: Record<string, string> = {
  "operator.added": "made an operator",
  "operator.removed": "removed as an operator",
  "operator.sessions_revoked": "signed out everywhere by an operator",
};
