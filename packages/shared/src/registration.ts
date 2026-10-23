import { z } from "zod";
import { isReservedSlug, workspaceSlug } from "./instance.ts";

/**
 * Registration (#184): who may make a workspace. Closed, its operators alone (on the instance
 * side); invite-only, someone an operator invites, at the link in the invitation; open, anyone
 * who confirms their email, with a trial when billing is on. Members join a workspace by its
 * own invitations whatever this says.
 */
export const registrationModes = ["closed", "invite", "open"] as const;
export type RegistrationMode = (typeof registrationModes)[number];

/** The choices, as the instance's Settings names them. */
export const registrationNames: Record<RegistrationMode, string> = {
  closed: "Operators only",
  invite: "Anyone invited",
  open: "Anyone",
};

/** Whether a sign-up may finish: open takes any confirmed email, invite-only an operator's invitation. */
export const signUpAllowed = (mode: RegistrationMode, invited: boolean) =>
  mode === "open" || (mode === "invite" && invited);

/** Why a sign-up is refused, in the page's words. */
export const signUpRefusal = (mode: RegistrationMode) =>
  mode === "invite"
    ? "Workspaces here are made by invitation. Ask the instance's operators for one."
    : "Sign-up is closed here: the instance's operators make its workspaces.";

/** How long a link to confirm an email lasts; an operator's invitation lasts a week. */
export const SIGN_UP_LINK_MS = 24 * 60 * 60 * 1000;

/** When a trial of `days` begun at `now` ends; null for none. */
export const trialEnd = (days: number, now: Date): Date | null =>
  days > 0 ? new Date(now.getTime() + days * 86_400_000) : null;

/** A subdomain suggested from a workspace's name: an address's rules, never a kept name. */
export const slugFrom = (name: string) => {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return isReservedSlug(slug) ? "" : slug;
};

/** What the sign-up page reads before anyone signs in. */
export interface SignUpInfo {
  mode: RegistrationMode;
  /** The trial a workspace made here starts with, in days; null without billing or a plan to try. */
  trialDays: number | null;
  /** Where workspaces answer (WORKSPACE_SUBDOMAINS), as `review.example`; null when off. */
  subdomains: string | null;
}

/** Asking for a link to make a workspace, with open sign-up. */
export const signUpStartInput = z.object({
  email: z.email({ error: "An email address" }).max(254),
});

/** An operator invites someone to make a workspace. */
export const signUpInvitationInput = signUpStartInput;

export const signUpTokenParam = z.object({ token: z.string().min(20).max(100) });

/**
 * Making the workspace, at the link: its name and subdomain, and the owner's name and password
 * when the email has no account yet.
 */
export const signUpInput = z.object({
  workspace: z.string().trim().min(1, "Name the workspace").max(120),
  slug: workspaceSlug,
  name: z.string().trim().min(1, "Your name").max(120).optional(),
  password: z.string().min(12, "Twelve characters or more").max(256).optional(),
});
export type SignUpInput = z.infer<typeof signUpInput>;

/** A link to make a workspace, as its page reads it. */
export interface SignUpLink {
  email: string;
  /** An operator's invitation, rather than a link someone asked for themselves. */
  invited: boolean;
  expired: boolean;
  /** The email has an account already: its holder signs in, then names the workspace. */
  hasAccount: boolean;
  /** Whether the instance's registration still lets it be used. */
  allowed: boolean;
  /** Why not, when it does not. */
  refusal: string | null;
  trialDays: number | null;
  subdomains: string | null;
}

/** An operator's invitation to make a workspace, waiting to be used. */
export interface SignUpInvitation {
  id: string;
  email: string;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
}
