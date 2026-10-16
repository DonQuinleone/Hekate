import { describe, expect, it } from "vitest";
import {
  digestDue,
  digestMail,
  instantMail,
  lineOf,
  type NotificationRow,
} from "./notifications.ts";

const row = (over: Partial<NotificationRow>): NotificationRow => ({
  id: "n",
  organisationId: "o",
  userId: "u",
  kind: "decision",
  actorUserId: null,
  actorGuestId: null,
  actorName: "Mira Solberg",
  projectId: null,
  reviewId: null,
  fileId: null,
  trackId: null,
  commentId: null,
  text: 'approved "Album masters"',
  detail: null,
  link: "/reviews/r",
  mail: null,
  inApp: true,
  mailMode: "instant",
  emailedAt: null,
  readAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

describe("notification mail", () => {
  it("reads as one line, with or without someone to name", () => {
    expect(lineOf(row({}))).toBe('Mira Solberg approved "Album masters"');
    expect(lineOf(row({ actorName: null, text: "mix.wav could not be processed" }))).toBe(
      "Mix.wav could not be processed",
    );
  });

  it("links into the app and to the settings", () => {
    const workspace = { name: "Endless Hall Records", subjects: {} };
    const mail = instantMail(row({ detail: "Lovely." }), "https://hekate.example/", workspace);
    expect(mail.subject).toBe('Mira Solberg approved "Album masters"');
    expect(mail.text).toContain("Lovely.");
    expect(mail.text).toContain("See the review:\nhttps://hekate.example/reviews/r");
    expect(mail.text).toContain("https://hekate.example/account/notifications");
    expect(mail.html).toContain('href="https://hekate.example/reviews/r"');
    const digest = digestMail(
      [row({}), row({ text: "added version 3 of Bethena" })],
      "Endless Hall Records",
      "https://hekate.example",
    );
    expect(digest.subject).toBe("2 updates in Endless Hall Records");
    expect(digest.text).toContain("- Mira Solberg added version 3 of Bethena");
  });

  it("takes the workspace's subject line where its template has one", () => {
    const n = row({
      mail: {
        template: "decision",
        values: { review: "Album masters", decision: "approved", project: "Joplin Rags" },
      },
    });
    const workspace = (subjects = {}) => ({ name: "Endless Hall Records", subjects });
    expect(instantMail(n, "https://hekate.example", workspace()).subject).toBe(
      "Album masters: approved",
    );
    expect(
      instantMail(
        n,
        "https://hekate.example",
        workspace({ decision: "{reviewer} on {review} ({project}): {decision}" }),
      ).subject,
    ).toBe("Mira Solberg on Album masters (Joplin Rags): approved");
  });

  it("keeps the requester the event captured, rather than whoever acted", () => {
    const n = row({
      kind: "review_requested",
      actorName: "Alex Rivera",
      mail: {
        template: "review_requested",
        values: { review: "Album masters", kind: "approval", requester: "Ines Arlow" },
      },
    });
    const workspace = {
      name: "Endless Hall Records",
      subjects: { review_requested: "{requester} asks about {review}" },
    };
    expect(instantMail(n, "https://hekate.example", workspace).subject).toBe(
      "Ines Arlow asks about Album masters",
    );
  });
});

describe("digestDue", () => {
  const at = (iso: string) => new Date(iso);
  it("sends hourly digests every run", () => {
    expect(digestDue("hourly", at("2026-10-15T10:00:00Z"), at("2026-10-15T11:03:00Z"))).toBe(true);
  });

  it("sends daily digests in the morning, once, or when one was missed", () => {
    expect(digestDue("daily", null, at("2026-10-15T08:03:00Z"))).toBe(true);
    expect(digestDue("daily", null, at("2026-10-15T09:03:00Z"))).toBe(false);
    expect(digestDue("daily", at("2026-10-15T08:03:00Z"), at("2026-10-15T08:30:00Z"))).toBe(false);
    expect(digestDue("daily", at("2026-10-13T08:03:00Z"), at("2026-10-15T15:03:00Z"))).toBe(true);
  });
});
