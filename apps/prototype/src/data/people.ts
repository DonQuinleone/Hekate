import type { Guest, Member, Person } from "./types.ts";

/** The whole cast is fictional. Names repeat across roles because there are four of them. */
export const people: Person[] = [
  { id: "p-alex", name: "Alex Rivera", email: "alex@endlesshall.example" },
  { id: "p-ines", name: "Ines Arlow", email: "ines@endlesshall.example" },
  { id: "p-tomas", name: "Tomas Varga", email: "tomas@endlesshall.example" },
  { id: "p-mira", name: "Mira Solberg", email: "mira@solberg.example" },
];

export const organisation = {
  id: "org-endless-hall",
  name: "Endless Hall Records",
  createdAt: "2026-08-02T09:00:00Z",
  /** Guests sign in with the link alone, or must enter their email and a code first. */
  guestVerification: "link" as "link" | "code",
  defaultReviewerPermissions: {
    comment: true,
    decide: true,
    comments: "all" as const,
    tools: ["loops", "compare", "score"] as const,
    history: true,
    download: "none" as const,
    startsAt: null,
    expiresAt: null,
    viewLimit: null,
  },
};

export const members: Member[] = [
  { personId: "p-alex", role: "owner", joinedAt: "2026-08-02T09:00:00Z" },
  { personId: "p-ines", role: "admin", joinedAt: "2026-08-03T10:20:00Z" },
  { personId: "p-tomas", role: "member", joinedAt: "2026-08-10T14:05:00Z" },
  { personId: "p-mira", role: "member", joinedAt: "2026-09-01T08:40:00Z" },
];

export const guests: Guest[] = [
  { personId: "p-mira", label: "Conductor", linkSentAt: "2026-10-14T09:15:00Z" },
];

export const invitations = [
  {
    email: "producer@endlesshall.example",
    role: "member" as const,
    sentAt: "2026-10-12T16:00:00Z",
    expiresAt: "2026-10-19T16:00:00Z",
  },
];

export const personById = (id: string): Person =>
  people.find((p) => p.id === id) ?? { id, name: "Someone", email: "" };

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
