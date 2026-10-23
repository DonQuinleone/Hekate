import { z } from "zod";
import { parseErrorReference } from "./error-reports.ts";
import type { Entitlements, SupportSeverity } from "./plans.ts";
import { supportSeverities } from "./plans.ts";

/**
 * Support (#181, #182): with `HEKATE_SUPPORT=app`, a workspace asks the people who run the
 * instance in tickets, each a thread with a reference made on sending, a type, and a severity
 * its plan allows. The operators answer from the instance's Support page.
 */

/** How the instance answers: in the app, at a desk of its own, by mail, or not at all. */
export const supportModes = ["off", "app", "link", "mail"] as const;
export type SupportMode = (typeof supportModes)[number];

/** What the help menu and the Support page need to know about the module. */
export interface SupportModule {
  mode: SupportMode;
  /** The desk's address with `link`, the mailbox with `mail` (HEKATE_SUPPORT_ADDRESS). */
  address: string | null;
  /** HEKATE_DOCS_URL. */
  docsUrl: string;
  /**
   * The status page: the desk's own address, else HEKATE_STATUS_URL, else the instance's own
   * page at `/status` (#183), which always shows the incidents posted here.
   */
  statusUrl: string;
}

export const ticketKinds = ["problem", "question", "billing", "idea"] as const;
export type TicketKind = (typeof ticketKinds)[number];

export const ticketKindNames: Record<TicketKind, string> = {
  problem: "Something is broken",
  question: "A question",
  billing: "Billing",
  idea: "An idea",
};

/**
 * Where a ticket stands. Waiting is waiting on support (a new ticket, or the workspace replied);
 * answered is waiting on the workspace; open is being looked into; resolved is done.
 */
export const ticketStates = ["open", "waiting", "answered", "resolved"] as const;
export type TicketState = (typeof ticketStates)[number];

export const ticketStateNames: Record<TicketState, string> = {
  open: "Open",
  waiting: "Waiting on support",
  answered: "Answered",
  resolved: "Resolved",
};

export const severityNames: Record<SupportSeverity, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
  emergency: "Emergency",
};

export const severityHints: Record<SupportSeverity, string> = {
  low: "A question or an idea; no one is blocked",
  normal: "Something is wrong but there is a way round it",
  high: "A delivery or review is blocked",
  urgent: "Nobody in the workspace can work",
  emergency: "Data at risk, or a leak",
};

/** High and above stand out in lists, and Emergency tells whoever is on call at once. */
export const pressing = (severity: SupportSeverity) =>
  supportSeverities.indexOf(severity) >= supportSeverities.indexOf("high");

/** A message's attachments: a few screenshots or logs, not media. */
export const TICKET_ATTACHMENTS_MAX = 5;
export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** A ticket's reference from three random bytes: `T-7F3A-2C`, unlike an error's `HK-`. */
export function formatTicketReference(bytes: Uint8Array): string {
  if (bytes.length < 3) throw new RangeError("A ticket reference takes three bytes");
  const hex = Array.from(bytes.subarray(0, 3), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `T-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** The error references (#159) quoted in some words, normalised, each once, in order. */
export function errorReferencesIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\bHK-?[0-9A-F]{4}-?[0-9A-F]{2}\b/gi)) {
    const reference = parseErrorReference(match[0]);
    if (reference && !found.includes(reference)) found.push(reference);
  }
  return found;
}

/** What happens to a ticket's state when someone acts on it. */
export type TicketEvent = "workspace_reply" | "operator_reply" | "resolve";

/**
 * The state after an event: a reply from the workspace puts it back with support (and opens a
 * resolved one again); an operator's answer waits on the workspace; resolving resolves.
 */
export function nextTicketState(event: TicketEvent): TicketState {
  if (event === "resolve") return "resolved";
  return event === "operator_reply" ? "answered" : "waiting";
}

const errorReference = z
  .string()
  .max(32)
  .transform((value, ctx) => {
    const reference = parseErrorReference(value);
    if (!reference) {
      ctx.addIssue({ code: "custom", message: "Not an error reference" });
      return z.NEVER;
    }
    return reference;
  });

const body = z
  .string()
  .trim()
  .min(1, "Write a message")
  .max(10_000, "A message can be at most 10,000 characters");

/** A new ticket from the workspace's Support page. */
export const ticketInput = z.object({
  subject: z
    .string()
    .trim()
    .min(1, "Say what is wrong, in a line")
    .max(140, "A subject can be at most 140 characters"),
  kind: z.enum(ticketKinds),
  severity: z.enum(supportSeverities),
  message: body,
  /** The failure they saw, attached for the operators (#159). */
  errorReference: errorReference.nullable().default(null),
  /** The file or review they asked from. */
  item: z
    .object({ kind: z.enum(["file", "review"]), id: z.uuid() })
    .nullable()
    .default(null),
  /** Whether the operators may open that item to look. */
  operatorAccess: z.boolean().default(false),
});
export type TicketInput = z.input<typeof ticketInput>;

/** A reply in a ticket's thread; an operator may set its state as they send. */
export const ticketReplyInput = z.object({
  body,
  state: z.enum(ticketStates).optional(),
});

/** An operator sets where a ticket stands, or the workspace marks it resolved. */
export const ticketStateInput = z.object({ state: z.enum(ticketStates) });

/** Which tickets the desk lists: open (anything not resolved), those waiting on support, or all. */
export const ticketFilters = ["open", "waiting", "all"] as const;
export const ticketsQuery = z.object({
  state: z.enum(ticketFilters).default("open"),
  severity: z.enum(supportSeverities).optional(),
  workspace: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});

/** A canned reply: an answer the desk gives often, kept to start a reply from. */
export const cannedReplyInput = z.object({
  title: z.string().trim().min(1, "Name the reply").max(60),
  body: z.string().trim().min(1, "Write the reply").max(5000),
});
export type CannedReplyInput = z.infer<typeof cannedReplyInput>;

/** The desk's own settings: its status page, and the operator on call. */
export const supportDeskInput = z.object({
  statusUrl: z.url({ error: "A web address" }).max(500).nullable(),
  onCall: z.string().min(1).max(64).nullable(),
});
export type SupportDeskInput = z.infer<typeof supportDeskInput>;

/** A plan as the Support page needs it, to say which plan unlocks a severity. */
interface PlanOffer {
  name: string;
  severities: SupportSeverity[];
  hidden: boolean;
  retiredAt: string | null;
  price: { amount: number } | null;
}

/** Each severity, whether the workspace's plan allows it, and the plan to move to if not. */
export function severityChoices(
  plan: Pick<Entitlements, "severities">,
  plans: PlanOffer[],
): { severity: SupportSeverity; allowed: boolean; plan: string | null }[] {
  const offered = plans
    .filter((p) => !p.hidden && !p.retiredAt)
    .sort((a, b) => (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity));
  return supportSeverities.map((severity) => {
    const allowed = plan.severities.includes(severity);
    return {
      severity,
      allowed,
      plan: allowed ? null : (offered.find((p) => p.severities.includes(severity))?.name ?? null),
    };
  });
}

/** The middle of some durations, or null for none. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Who wrote a message: someone in the workspace, an operator, or Hekate itself. */
export type TicketAuthor = "member" | "operator" | "system";

export interface TicketAttachment {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
}

export interface TicketMessage {
  id: string;
  author: TicketAuthor;
  /** The name shown: the person's, or "Hekate". */
  name: string;
  /** Stable for the avatar's colour; null for Hekate. */
  authorId: string | null;
  body: string;
  createdAt: string;
  attachments: TicketAttachment[];
}

/** A ticket as a list shows it. */
export interface TicketRow {
  id: string;
  reference: string;
  subject: string;
  kind: TicketKind;
  severity: SupportSeverity;
  state: TicketState;
  createdAt: string;
  updatedAt: string;
  messages: number;
  requester: { id: string | null; name: string };
  /** The operators' list names the workspace. */
  workspace?: { id: string; name: string };
}

export interface TicketDetail extends TicketRow {
  errorReference: string | null;
  item: { kind: "file" | "review"; id: string; name: string | null } | null;
  operatorAccess: boolean;
  thread: TicketMessage[];
}

/** What the operators see beside the thread (#182). */
export interface OperatorTicketDetail extends TicketDetail {
  who: {
    id: string | null;
    name: string;
    email: string | null;
    role: "owner" | "admin" | "member" | null;
    lastSeenAt: string | null;
  };
  place: {
    id: string;
    name: string;
    address: string;
    plan: string | null;
    openReviews: number;
  };
}

/** The workspace's Support page. */
export interface WorkspaceSupport {
  tickets: TicketRow[];
  severities: { severity: SupportSeverity; allowed: boolean; plan: string | null }[];
  /** The last failure this person saw here in the past day, offered to attach. */
  recentError: { reference: string; occurredAt: string } | null;
}

/** The desk's figures, as its tiles show them. */
export interface SupportFigures {
  open: number;
  waiting: number;
  /** The median time to an operator's first reply this month, in hours. */
  firstReplyHours: number | null;
  resolved: number;
}

export interface CannedReply {
  id: string;
  title: string;
  body: string;
}

/** The desk's settings, with who may be put on call. */
export interface SupportDesk {
  statusUrl: string | null;
  /** HEKATE_STATUS_URL, the address used when the desk sets none. */
  environmentStatusUrl: string | null;
  /** The instance's own page (#183), linked when neither sets one. */
  ownStatusUrl: string;
  onCall: string | null;
  operators: { id: string; name: string }[];
  /** Which severities each plan allows; empty with billing off, when every one is allowed. */
  plans: { id: string; name: string; severities: SupportSeverity[] }[];
  billing: boolean;
}
