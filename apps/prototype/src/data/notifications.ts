export type NotificationKind =
  | "version"
  | "reply"
  | "decision"
  | "assignment"
  | "stage"
  | "mention"
  | "processing";

export interface AppNotification {
  id: string;
  at: string;
  personId: string;
  text: string;
  kind: NotificationKind;
  href: string;
  read: boolean;
}

/** What happened lately, newest first. The bell and the notifications page read the same list. */
export const notifications: AppNotification[] = [
  {
    id: "n-1",
    at: "2026-10-14T20:41:00Z",
    personId: "p-tomas",
    text: "uploaded Maple Leaf Rag V3",
    kind: "version",
    href: "/tracks/t-maple",
    read: false,
  },
  {
    id: "n-2",
    at: "2026-10-14T19:25:00Z",
    personId: "p-alex",
    text: "replied to your comment on Maple Leaf Rag V2",
    kind: "reply",
    href: "/files/file-maple-v2-dry?comment=c-2",
    read: false,
  },
  {
    id: "n-3",
    at: "2026-10-14T14:20:00Z",
    personId: "p-tomas",
    text: "requested changes on Album masters",
    kind: "decision",
    href: "/reviews/rev-masters",
    read: false,
  },
  {
    id: "n-4",
    at: "2026-10-14T12:35:00Z",
    personId: "p-tomas",
    text: "submitted feedback on Mix notes, round two",
    kind: "decision",
    href: "/reviews/rev-mixnotes",
    read: true,
  },
  {
    id: "n-5",
    at: "2026-10-14T10:02:00Z",
    personId: "p-mira",
    text: "approved Album masters",
    kind: "decision",
    href: "/reviews/rev-masters",
    read: true,
  },
  {
    id: "n-6",
    at: "2026-10-13T20:00:00Z",
    personId: "p-mira",
    text: "assigned you: move the title away from the sleeve edge",
    kind: "assignment",
    href: "/projects/proj-joplin/tasks",
    read: true,
  },
  {
    id: "n-7",
    at: "2026-10-13T19:05:00Z",
    personId: "p-tomas",
    text: "moved Opening titles to With director",
    kind: "stage",
    href: "/tracks/t-titles",
    read: true,
  },
];
