import { z } from "zod";

/**
 * What the access log records (docs/security.md). Every key issued, playback
 * session, rendered page and download, plus the changes that matter to an
 * investigation: uploads, deletions and exports of the log itself.
 */
export const auditActions = [
  /** A content key was issued to a player. */
  "stream.key",
  /** A player started a session of signed segment URLs. */
  "stream.session",
  /** One encrypted segment of a stream was served. */
  "stream.segment",
  /** A document or image page was rendered as tiles for a viewer. */
  "page.render",
  /** A file left Hekate as a download. */
  "download",
  "file.upload",
  "file.delete",
  /** Someone exported this log. */
  "audit.export",
  /** Storage reconciliation removed bytes or a blob that nothing used. */
  "storage.remove",
  /** Storage reconciliation found a blob whose bytes are missing. */
  "storage.missing",
  /** A review was requested, or cancelled. */
  "review.create",
  "review.cancel",
  /** A reviewer recorded an approval decision, or submitted feedback. */
  "review.decision",
  "review.submit",
  /** Someone reminded the reviewers a review waits on, or one of them. */
  "review.remind",
  /** Someone changed a review's due date. */
  "review.due",
  /** Someone added a reviewer to a review, or removed one. */
  "review.reviewer_add",
  "review.reviewer_remove",
  /** A guest was sent a magic link, used one, or had their links and sessions revoked. */
  "guest.link",
  "guest.sign_in",
  /** A code was sent to a guest opening their link, where the workspace asks for one. */
  "guest.code_sent",
  /** A guest's code was wrong, had expired, or had been tried too often. */
  "guest.code_failed",
  "guest.revoke",
  /** A guest opened a review, or commented. */
  "guest.view",
  "comment.create",
  /** Someone exported a file's comments as a marker list. */
  "comment.export",
  /** Too many failed sign-ins locked a member's account for a while. */
  "account.lockout",
  /** A member set a new password with a code sent to their address. */
  "account.password_reset",
  /** A member added a second factor to their account, or removed it. */
  "account.second_factor_added",
  "account.second_factor_removed",
  /** A member generated new recovery codes; the old ones stop working. */
  "account.recovery_codes",
  /** A member added a passkey or hardware security key to their account, or removed one. */
  "account.passkey_added",
  "account.passkey_removed",
  /** A member deleted their account; what they did stays, as a former member's. */
  "account.deleted",
  /** A member signed in with the workspace's directory; the first time also makes them one. */
  "account.directory_sign_in",
  /** A member signed in with the workspace's single sign-on; the first time also makes them one. */
  "account.sso_sign_in",
  /** An owner renamed the workspace. */
  "organisation.rename",
  /** An admin changed the workspace's settings. */
  "organisation.settings",
  /** An admin changed the workspace's directory (LDAP) settings. */
  "organisation.directory",
  /** An admin changed the workspace's single sign-on settings. */
  "organisation.sso",
  /** A project was archived (its open reviews closing), or brought back. */
  "project.archive",
  "project.unarchive",
] as const;
export const auditAction = z.enum(auditActions);
export type AuditAction = z.infer<typeof auditAction>;

export const auditActorTypes = ["member", "guest", "system"] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

/** Filters for reading the log. Results run newest first; `before` is the last id of the previous page. */
export const auditQuery = z.object({
  projectId: z.uuid().optional(),
  fileId: z.uuid().optional(),
  reviewId: z.uuid().optional(),
  userId: z.string().min(1).max(64).optional(),
  action: auditAction.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuery>;
