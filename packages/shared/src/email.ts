import { z } from "zod";

/**
 * The messages Hekate sends on a workspace's behalf. Each is the same shape (who did what,
 * one action, a line about why you got it); a workspace may change each subject line, with
 * the placeholders the template offers.
 */
export const emailTemplateIds = [
  "review_requested",
  "invitation",
  "decision",
  "due_soon",
  "upload_request",
] as const;
export type EmailTemplateId = (typeof emailTemplateIds)[number];
export const emailTemplateId = z.enum(emailTemplateIds);

export interface EmailTemplateSpec {
  name: string;
  /** The subject line unless the workspace sets its own. */
  subject: string;
  /** What a subject may say in braces, such as `{review}`, with sample values for previews. */
  sample: Record<string, string>;
}

export const emailTemplates: Record<EmailTemplateId, EmailTemplateSpec> = {
  review_requested: {
    name: "Review requested",
    subject: "{review}: your {kind} is asked",
    sample: {
      review: "Album masters",
      kind: "approval",
      requester: "Alex Rivera",
      project: "Joplin Rags",
      workspace: "Endless Hall Records",
    },
  },
  invitation: {
    name: "Invitation",
    subject: "Join {workspace} on Hekate",
    sample: { workspace: "Endless Hall Records", inviter: "Ines Arlow" },
  },
  decision: {
    name: "Decision recorded",
    subject: "{review}: {decision}",
    sample: {
      review: "Album masters",
      decision: "changes requested",
      reviewer: "Tomas Varga",
      project: "Joplin Rags",
      workspace: "Endless Hall Records",
    },
  },
  due_soon: {
    name: "Due soon",
    subject: "{review} is due tomorrow",
    sample: {
      review: "Cut 3 picture lock",
      project: "Opening titles",
      workspace: "Endless Hall Records",
    },
  },
  upload_request: {
    name: "Upload request",
    subject: "Please send {file}",
    sample: {
      file: "the Atmos master",
      requester: "Alex Rivera",
      workspace: "Endless Hall Records",
    },
  },
};

const placeholder = /\{([a-z]+)\}/g;

/** The placeholders a subject uses that its template does not offer. */
export function unknownPlaceholders(id: EmailTemplateId, subject: string): string[] {
  const offered = emailTemplates[id].sample;
  return [...subject.matchAll(placeholder)]
    .map((m) => m[1] ?? "")
    .filter((name) => !(name in offered));
}

/** A subject line with its placeholders filled; one left without a value is dropped. */
export function fillSubject(pattern: string, values: Record<string, string>): string {
  return pattern
    .replace(placeholder, (_, name: string) => values[name] ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 200);
}

/** Refuses a subject line using a placeholder its template does not offer. */
function checkPlaceholders(
  subjects: Partial<Record<EmailTemplateId, string | null>>,
  ctx: z.RefinementCtx,
) {
  for (const id of emailTemplateIds) {
    const subject = subjects[id];
    if (!subject) continue;
    const unknown = unknownPlaceholders(id, subject);
    if (unknown.length > 0)
      ctx.addIssue({
        code: "custom",
        path: [id],
        message: `Not a placeholder here: ${unknown.map((u) => `{${u}}`).join(", ")}`,
      });
  }
}

const subjectLine = z.string().trim().min(1, "A subject is needed").max(150);

/** A workspace's own subject lines, by template; a template left out uses the default. */
export const emailSubjects = z
  .partialRecord(emailTemplateId, subjectLine)
  .superRefine(checkPlaceholders);
export type EmailSubjects = z.infer<typeof emailSubjects>;

/** A change to some subject lines; null puts one back to the default. */
export const emailSubjectsChange = z
  .partialRecord(emailTemplateId, subjectLine.nullable())
  .superRefine(checkPlaceholders);

/** The subject a template goes out with in a workspace. */
export function subjectFor(
  id: EmailTemplateId,
  subjects: EmailSubjects,
  values: Record<string, string>,
): string {
  return fillSubject(subjects[id] ?? emailTemplates[id].subject, values);
}

/** Send a template to yourself, with sample content. */
export const emailTestInput = z.object({ template: emailTemplateId }).strict();
