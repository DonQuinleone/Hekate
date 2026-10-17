import {
  type EmailSubjects,
  type EmailTemplateId,
  emailTemplates,
  type ReviewDecision,
  type ReviewKind,
  subjectFor,
} from "@hekate/shared";
import type { Email } from "./render.ts";

/** "14 October 2026": a date anyone reads the same way, wherever they are. */
export const longDate = (date: Date) =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** What each workspace message needs, by template. */
export interface TemplateData {
  review_requested: {
    workspace: string;
    requester: string;
    review: string;
    kind: ReviewKind;
    project: string;
    message?: string | null;
    dueAt?: Date | null;
    url: string;
    /** For a guest, how long the link in it works; a member's mail says why they got it instead. */
    guestLinkDays?: number;
    settingsUrl?: string;
    /**
     * An approval's observer (#221): asked to follow it, and to comment where they may, while
     * the decision rests with others.
     */
    follow?: { comment: boolean };
  };
  invitation: { workspace: string; inviter: string; url: string; days: number };
  decision: {
    workspace: string;
    reviewer: string;
    review: string;
    project: string;
    decision: ReviewDecision | "feedback";
    note?: string | null;
    url: string;
    settingsUrl?: string;
  };
  due_soon: {
    workspace: string;
    review: string;
    kind: ReviewKind;
    project: string;
    dueAt: Date;
    /** Other reviews of theirs due as well, which the same link opens. */
    others?: string[];
    url: string;
    guestLinkDays?: number;
    settingsUrl?: string;
  };
  upload_request: {
    workspace: string;
    requester: string;
    file: string;
    url: string;
    days: number;
  };
}

/** A decision as a subject line says it. */
export const decisionWords: Record<TemplateData["decision"]["decision"], string> = {
  approved: "approved",
  changes_requested: "changes requested",
  feedback: "feedback sent",
};

/** The values a template's subject line may use. */
export function subjectValues<T extends EmailTemplateId>(
  id: T,
  data: TemplateData[T],
): Record<string, string> {
  switch (id) {
    case "review_requested": {
      const d = data as TemplateData["review_requested"];
      return {
        review: d.review,
        // An observer's part is to follow and comment: "your feedback is asked", never approval.
        kind: d.follow ? "feedback" : d.kind,
        requester: d.requester,
        project: d.project,
        workspace: d.workspace,
      };
    }
    case "invitation": {
      const d = data as TemplateData["invitation"];
      return { workspace: d.workspace, inviter: d.inviter };
    }
    case "decision": {
      const d = data as TemplateData["decision"];
      return {
        review: d.review,
        decision: decisionWords[d.decision],
        reviewer: d.reviewer,
        project: d.project,
        workspace: d.workspace,
      };
    }
    case "due_soon": {
      const d = data as TemplateData["due_soon"];
      return { review: d.review, project: d.project, workspace: d.workspace };
    }
    default: {
      const d = data as TemplateData["upload_request"];
      return { file: d.file, requester: d.requester, workspace: d.workspace };
    }
  }
}

const quoted = (note: string) => `“${note.trim()}”`;

const guestFoot = (days: number) =>
  `This link is yours alone and signs you in on this device. It works once, for ${days} days.`;

/** A workspace message: its words, with the workspace's subject line. */
export function workspaceEmail<T extends EmailTemplateId>(
  id: T,
  data: TemplateData[T],
  subjects: EmailSubjects,
): Email {
  const subject = subjectFor(id, subjects, subjectValues(id, data));
  switch (id) {
    case "review_requested": {
      const d = data as TemplateData["review_requested"];
      return {
        workspace: d.workspace,
        subject,
        heading: d.follow
          ? `${d.requester} asks you to follow an approval`
          : `${d.requester} asks for your ${d.kind}`,
        body: [
          d.follow
            ? `${d.review}, in ${d.project}, is ready. Open it to follow the approval${d.follow.comment ? " and leave comments where they belong" : ""}; the decision rests with others.`
            : d.kind === "approval"
              ? `${d.review}, in ${d.project}, is ready. Open it, leave comments where they belong, then record Approved or Changes requested.`
              : `${d.review}, in ${d.project}, is ready. Open it and leave comments where they belong, then send your feedback.`,
          ...(d.message?.trim() ? [quoted(d.message)] : []),
          ...(d.dueAt ? [`Due ${longDate(d.dueAt)}.`] : []),
        ],
        action: { label: "Open the review", url: d.url },
        foot:
          d.guestLinkDays !== undefined
            ? guestFoot(d.guestLinkDays)
            : d.follow
              ? "You get this because you were asked to follow a review."
              : "You get this because you were asked to review.",
        ...(d.settingsUrl ? { settingsUrl: d.settingsUrl } : {}),
      };
    }
    case "invitation": {
      const d = data as TemplateData["invitation"];
      return {
        workspace: d.workspace,
        subject,
        heading: `${d.inviter} invited you to ${d.workspace}`,
        body: [
          `Accept to review and approve the workspace's work on Hekate. The invitation is for this address and works once, for ${d.days} days.`,
        ],
        action: { label: "Accept the invitation", url: d.url },
        foot: "If you were not expecting this, ignore it; nothing happens until you accept.",
      };
    }
    case "decision": {
      const d = data as TemplateData["decision"];
      const did =
        d.decision === "approved"
          ? `approved ${d.review}`
          : d.decision === "changes_requested"
            ? `requested changes on ${d.review}`
            : `sent feedback on ${d.review}`;
      return {
        workspace: d.workspace,
        subject,
        heading: `${d.reviewer} ${did}`,
        body: [...(d.note?.trim() ? [quoted(d.note)] : []), `${d.review} is in ${d.project}.`],
        action: { label: "See the review", url: d.url },
        foot: "You get this because you requested the review or follow it.",
        ...(d.settingsUrl ? { settingsUrl: d.settingsUrl } : {}),
      };
    }
    case "due_soon": {
      const d = data as TemplateData["due_soon"];
      return {
        workspace: d.workspace,
        subject,
        heading: `Your ${d.kind === "approval" ? "decision" : "feedback"} on ${d.review} is due tomorrow`,
        body: [
          `${d.review}, in ${d.project}, waits on you. It is due ${longDate(d.dueAt)}.`,
          ...(d.others?.length
            ? ["These are due tomorrow too, and the same link opens them:"]
            : []),
        ],
        ...(d.others?.length ? { list: d.others } : {}),
        action: { label: "Open the review", url: d.url },
        foot:
          d.guestLinkDays !== undefined
            ? `A reminder, sent once, the day before the due date. ${guestFoot(d.guestLinkDays)}`
            : "A reminder, sent once, the day before the due date.",
        ...(d.settingsUrl ? { settingsUrl: d.settingsUrl } : {}),
      };
    }
    default: {
      const d = data as TemplateData["upload_request"];
      return {
        workspace: d.workspace,
        subject,
        heading: `${d.requester} asked you for a file`,
        body: [`Upload ${d.file}. The link closes in ${d.days} days, and no account is needed.`],
        action: { label: "Upload the file", url: d.url },
        foot: "The file is checked as it arrives and goes straight into the project.",
      };
    }
  }
}

/** Each template filled with sample content, for the settings preview and a test send. */
export function sampleData(
  workspace: string,
  base: string,
): { [T in EmailTemplateId]: TemplateData[T] } {
  const settingsUrl = `${base}/account/notifications`;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const s = emailTemplates;
  return {
    review_requested: {
      workspace,
      requester: s.review_requested.sample.requester ?? "",
      review: s.review_requested.sample.review ?? "",
      kind: "approval",
      project: s.review_requested.sample.project ?? "",
      message: "Three tracks are ready. The Maple Leaf Rag trio is the one to listen to closely.",
      dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      url: `${base}/reviews`,
      settingsUrl,
    },
    invitation: {
      workspace,
      inviter: s.invitation.sample.inviter ?? "",
      url: `${base}/sign-in`,
      days: 7,
    },
    decision: {
      workspace,
      reviewer: s.decision.sample.reviewer ?? "",
      review: s.decision.sample.review ?? "",
      project: s.decision.sample.project ?? "",
      decision: "changes_requested",
      note: "Right channel a touch hotter than the left through the trio.",
      url: `${base}/reviews`,
      settingsUrl,
    },
    due_soon: {
      workspace,
      review: s.due_soon.sample.review ?? "",
      kind: "approval",
      project: s.due_soon.sample.project ?? "",
      dueAt: tomorrow,
      url: `${base}/reviews`,
      settingsUrl,
    },
    upload_request: {
      workspace,
      requester: s.upload_request.sample.requester ?? "",
      file: s.upload_request.sample.file ?? "",
      url: `${base}/`,
      days: 5,
    },
  };
}
