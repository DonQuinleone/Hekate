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
  /**
   * An owner traced a suspected leak (#32): the file's name and size, and the mark it carried
   * if one was found. The file itself is never kept.
   */
  "forensic.trace",
  "file.upload",
  /** A member asked someone outside for files, with a link (#139). */
  "upload_request.create",
  /** A member closed an upload request before it ran out. */
  "upload_request.close",
  /** A wrong password was given on an upload request's page. */
  "upload_request.password_failed",
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
  /** A new version was let in past the project's version checks. */
  "version.let_through",
  /** A version's file was replaced by another, its threads moving with it. */
  "variant.replace",
  /** @deprecated How rows before decision 275 record `variant.replace`; read, never written. */
  "variation.replace",
  /** A guest was sent a magic link, used one, or had their links and sessions revoked. */
  "guest.link",
  "guest.sign_in",
  /** A code was sent to a guest opening their link, where the workspace asks for one. */
  "guest.code_sent",
  /** A guest's code was wrong, had expired, or had been tried too often. */
  "guest.code_failed",
  "guest.revoke",
  /** What someone may do in a project's reviews was set on its People page (#55), or cleared. */
  "project.reviewer_grant",
  /** A reviewer was invited from a project's People page (#502), before any review asks them. */
  "project.guest_invite",
  /** A guest opened a review, or commented. */
  "guest.view",
  "comment.create",
  /** Someone attached a file to their comment (#133), or downloaded one attached to a comment. */
  "comment.attachment_add",
  "comment.attachment_download",
  /** Someone shared takes on a thread (#133), which its guests may then hear, or unshared one. */
  "comment.takes_share",
  "comment.takes_unshare",
  /** Someone added a caption file to a video (#146), or removed one. */
  "file.captions_add",
  "file.captions_remove",
  /** Someone renamed a caption track or changed its language or kind (#201), or exported one. */
  "file.captions_update",
  "file.captions_export",
  /** Someone exported a file's comments as a marker list. */
  "comment.export",
  /** Someone imported a marker list as comments on a file (#134). */
  "comment.import",
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
  /**
   * An API token (#198) was made, renamed or given other scopes, or revoked: a member's own, or
   * one of the workspace's service tokens. The token itself is never written; its name and hint are.
   */
  "api_token.create",
  "api_token.change",
  "api_token.revoke",
  /**
   * An OAuth client (#447) was registered, changed, given a new secret or deleted by the
   * workspace's admins. Its secret is never written; its name and client id are.
   */
  "oauth_client.create",
  "oauth_client.change",
  "oauth_client.rotate",
  "oauth_client.delete",
  /** A member connected an application through OAuth (#447), or disconnected it. */
  "oauth.connect",
  "oauth.disconnect",
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
  /** An admin changed the workspace's logo or accent (#185). */
  "organisation.branding",
  /** An admin changed the workspace's directory (LDAP) settings. */
  "organisation.directory",
  /** An admin changed the workspace's single sign-on settings. */
  "organisation.sso",
  /** An admin added, changed or removed one of the workspace's channels (#161). */
  "organisation.channel_add",
  "organisation.channel_change",
  "organisation.channel_remove",
  /** An admin set, changed or removed the workspace's own mail (#161). */
  "organisation.mail",
  /**
   * An owner, or an operator, asked for an export of everything the workspace holds (#186), and
   * someone downloaded a finished one.
   */
  "organisation.export_request",
  "organisation.export_download",
  /**
   * An owner asked to delete the workspace (#186); a second owner confirmed it, so it is
   * suspended and purged after its grace period; the request was withdrawn, or it was kept.
   */
  "organisation.deletion_request",
  "organisation.deletion_confirm",
  "organisation.deletion_cancel",
  /** A project was archived (its open reviews closing), or brought back. */
  "project.archive",
  "project.unarchive",
  /**
   * Someone asked to delete a project; a second owner confirmed it, so it goes in seven days;
   * the request was withdrawn, or the project kept; it was deleted for good.
   */
  "project.deletion_request",
  "project.deletion_confirm",
  "project.deletion_cancel",
  "project.delete",
  /**
   * A move to another workspace (#240): asked for, approved by a second member of the losing
   * workspace, accepted by the gaining one, refused by either, withdrawn by whoever asked, and
   * the move itself, written to both workspaces' logs.
   */
  "project.transfer_request",
  "project.transfer_approve",
  "project.transfer_accept",
  "project.transfer_refuse",
  "project.transfer_cancel",
  "project.transfer",
  /** A ControlRoom project file was imported into a project (#57), with what it created. */
  "project.croom_import",
  /** Someone in the workspace, or an operator, downloaded a file attached to a ticket (#181). */
  "support.attachment_download",
  /** A project's downloads and deletion changed (decision 257): who may download, originals, deleting, marking. */
  "project.asset_security",
  /**
   * Someone corrected a recording's embedded metadata (decision 264): each field changed, what
   * it said and now says. The original is untouched; downloads carry the corrections.
   */
  "file.metadata_edit",
] as const;
export const auditAction = z.enum(auditActions);
export type AuditAction = z.infer<typeof auditAction>;

/** A visitor is someone sending files through an upload request (#139), with no account. */
export const auditActorTypes = ["member", "guest", "visitor", "system"] as const;
export type AuditActorType = (typeof auditActorTypes)[number];

/** Filters for reading the log. Results run newest first; `before` is the last id of the previous page. */
export const auditQuery = z.object({
  projectId: z.uuid().optional(),
  fileId: z.uuid().optional(),
  reviewId: z.uuid().optional(),
  userId: z.string().min(1).max(64).optional(),
  /** A guest's entries, as a person filter picks them from an entry (decision 263). */
  guestId: z.uuid().optional(),
  action: auditAction.optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuery>;
