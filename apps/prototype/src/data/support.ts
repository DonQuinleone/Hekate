export type TicketSeverity = "low" | "normal" | "high" | "urgent" | "emergency";

export const severities: { id: TicketSeverity; label: string; hint: string; from: string }[] = [
  { id: "low", label: "Low", hint: "A question or an idea; no one is blocked", from: "Solo" },
  {
    id: "normal",
    label: "Normal",
    hint: "Something is wrong but there is a way round it",
    from: "Solo",
  },
  { id: "high", label: "High", hint: "A delivery or review is blocked", from: "Studio" },
  { id: "urgent", label: "Urgent", hint: "Nobody in the workspace can work", from: "Label" },
  { id: "emergency", label: "Emergency", hint: "Data at risk, or a leak", from: "Label" },
];

export type TicketKind = "problem" | "question" | "billing" | "idea";

export interface TicketMessage {
  id: string;
  from: "requester" | "operator" | "system";
  name: string;
  at: string;
  text: string;
  attachments?: string[];
}

export interface Ticket {
  id: string;
  reference: string;
  subject: string;
  kind: TicketKind;
  severity: TicketSeverity;
  state: "open" | "waiting" | "answered" | "resolved";
  opened: string;
  updated: string;
  workspace: string;
  workspaceHost: string;
  plan: string;
  requester: { name: string; email: string; role: string; seen: string; personId?: string };
  errorRef?: string;
  messages: TicketMessage[];
}

export const tickets: Ticket[] = [
  {
    id: "t-218",
    reference: "T-218",
    subject: "Slack messages stopped arriving",
    kind: "problem",
    severity: "high",
    state: "waiting",
    opened: "2 h ago",
    updated: "2 h ago",
    workspace: "North Choir Collective",
    workspaceHost: "northchoir",
    plan: "Label",
    requester: {
      name: "Priya Haldar",
      email: "priya@northchoir.example",
      role: "Owner",
      seen: "4 h ago",
    },
    errorRef: "HK-2B91-E0",
    messages: [
      {
        id: "m1",
        from: "requester",
        name: "Priya Haldar",
        at: "2 h ago",
        text: "Our #masters channel has had nothing since this morning. The webhook page shows 429s. Is it us or Slack?",
        attachments: ["webhooks.png"],
      },
      {
        id: "m2",
        from: "system",
        name: "Hekate",
        at: "2 h ago",
        text: "Error HK-2B91-E0 attached: Slack #masters answered 429 three times; the channel paused itself for five minutes and will retry.",
      },
    ],
  },
  {
    id: "t-217",
    reference: "T-217",
    subject: "Raise our quota before Friday's delivery",
    kind: "billing",
    severity: "normal",
    state: "waiting",
    opened: "5 h ago",
    updated: "5 h ago",
    workspace: "Saltmarsh Films",
    workspaceHost: "saltmarsh",
    plan: "Label",
    requester: {
      name: "Rowan Pike",
      email: "rowan@saltmarsh.example",
      role: "Admin",
      seen: "1 h ago",
    },
    messages: [
      {
        id: "m1",
        from: "requester",
        name: "Rowan Pike",
        at: "5 h ago",
        text: "We are at 1.9 TB of 2 TB with the feature delivery due Friday. Can the quota go to 5 TB this week? Happy to move to the next tier.",
      },
    ],
  },
  {
    id: "t-216",
    reference: "T-216",
    subject: "Score page 7 will not render",
    kind: "problem",
    severity: "normal",
    state: "answered",
    opened: "yesterday",
    updated: "1 d ago",
    workspace: "Endless Hall Records",
    workspaceHost: "endlesshall",
    plan: "Studio",
    requester: {
      name: "Tomas Varga",
      email: "tomas@endlesshall.example",
      role: "Member",
      seen: "yesterday",
      personId: "p-tomas",
    },
    errorRef: "HK-7F3A-2C",
    messages: [
      {
        id: "m1",
        from: "requester",
        name: "Tomas Varga",
        at: "yesterday",
        text: "Solace - Score.pdf shows pages 1 to 6 and then a blank. The file opens fine in Preview.",
      },
      {
        id: "m2",
        from: "operator",
        name: "Ops on call",
        at: "1 d ago",
        text: "The PDF has a damaged cross-reference table at page 7; pdf.js refuses it where Preview repairs it. Release 0.2.1 repairs it too and goes out tonight. Re-exporting the PDF from the engraver fixes it now.",
      },
    ],
  },
  {
    id: "t-214",
    reference: "T-214",
    subject: "Can guests see the take manager?",
    kind: "question",
    severity: "low",
    state: "resolved",
    opened: "3 d ago",
    updated: "3 d ago",
    workspace: "Hollow Reed Audio",
    workspaceHost: "hollowreed",
    plan: "Studio",
    requester: {
      name: "Lena Marsh",
      email: "lena@hollowreed.example",
      role: "Owner",
      seen: "2 d ago",
    },
    messages: [
      {
        id: "m1",
        from: "requester",
        name: "Lena Marsh",
        at: "3 d ago",
        text: "Our conductor wants to compare takes at bar 40. Can a guest open the take manager?",
      },
      {
        id: "m2",
        from: "operator",
        name: "Ops on call",
        at: "3 d ago",
        text: "Not the manager itself, but a comment can carry attached takes and a guest can compare those in the modal. Attach them from the comment's menu.",
      },
      {
        id: "m3",
        from: "requester",
        name: "Lena Marsh",
        at: "3 d ago",
        text: "That does it, thank you.",
      },
    ],
  },
  {
    id: "t-203",
    reference: "T-203",
    subject: "Can we have a second delivery profile?",
    kind: "idea",
    severity: "low",
    state: "resolved",
    opened: "9 d ago",
    updated: "9 d ago",
    workspace: "Endless Hall Records",
    workspaceHost: "endlesshall",
    plan: "Studio",
    requester: {
      name: "Ines Arlow",
      email: "ines@endlesshall.example",
      role: "Admin",
      seen: "1 h ago",
      personId: "p-ines",
    },
    messages: [
      {
        id: "m1",
        from: "requester",
        name: "Ines Arlow",
        at: "9 d ago",
        text: "Streaming and vinyl need different loudness targets; one profile per project is not enough.",
      },
      {
        id: "m2",
        from: "operator",
        name: "Alex Rivera",
        at: "9 d ago",
        text: "Delivery profiles are per project with per-track overrides since 0.2.0: set the vinyl profile on the tracks that need it.",
      },
    ],
  },
];

/** The reference a person sees when something fails, and the one a ticket gets: random, short, unambiguous. */
export const newReference = (prefix: "T" | "HK") =>
  `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 4).toUpperCase()}`;
