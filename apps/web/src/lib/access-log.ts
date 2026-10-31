import type { AuditAction } from "@hekate/shared";

const actionWords = {
  "stream.key": "Key issued",
  "stream.session": "Playback started",
  "stream.segment": "Segment served",
  "page.render": "Page rendered",
  download: "Downloaded",
  "forensic.trace": "Leak traced",
  "file.upload": "Uploaded",
  "file.delete": "Deleted",
  "upload_request.create": "Upload request made",
  "upload_request.close": "Upload request closed",
  "upload_request.password_failed": "Wrong upload request password",
  "audit.export": "Log exported",
  "storage.remove": "Storage tidied",
  "storage.missing": "Bytes missing",
  "review.create": "Review asked",
  "review.cancel": "Review cancelled",
  "review.decision": "Decision recorded",
  "review.submit": "Feedback submitted",
  "review.remind": "Reviewers reminded",
  "review.due": "Due date changed",
  "review.reviewer_add": "Reviewer added",
  "review.reviewer_remove": "Reviewer removed",
  "version.let_through": "Let past the version checks",
  "variant.replace": "File replaced",
  // Rows written before decision 275 carry the action under its old name.
  "variation.replace": "File replaced",
  "comment.takes_share": "Takes shared",
  "comment.takes_unshare": "Takes unshared",
  "file.captions_add": "Captions added",
  "file.captions_remove": "Captions removed",
  "file.captions_update": "Captions renamed",
  "file.captions_export": "Captions exported",
  "file.qa_report": "QA report taken",
  "guest.link": "Guest link sent",
  "guest.sign_in": "Guest signed in",
  "guest.code_sent": "Guest sent a code",
  "guest.code_failed": "Guest code refused",
  "guest.revoke": "Guest revoked",
  "project.reviewer_grant": "Reviewer permissions set",
  "project.guest_invite": "Reviewer invited",
  "guest.view": "Guest opened a review",
  "comment.create": "Comment",
  "comment.attachment_add": "File attached",
  "comment.attachment_download": "Attachment downloaded",
  "comment.export": "Comments exported",
  "comment.import": "Marker list imported",
  "organisation.rename": "Workspace renamed",
  "organisation.settings": "Workspace settings changed",
  "organisation.branding": "Branding changed",
  "organisation.directory": "Directory settings changed",
  "organisation.sso": "Single sign-on settings changed",
  "organisation.channel_add": "Channel added",
  "organisation.channel_change": "Channel changed",
  "organisation.channel_remove": "Channel removed",
  "organisation.mail": "Workspace mail changed",
  "organisation.storage": "Workspace storage changed",
  "organisation.export_request": "Workspace export asked for",
  "organisation.export_download": "Workspace export downloaded",
  "organisation.deletion_request": "Workspace deletion asked for",
  "organisation.deletion_confirm": "Workspace deletion confirmed",
  "organisation.deletion_cancel": "Workspace deletion withdrawn",
  "account.lockout": "Account locked after failed sign-ins",
  "account.password_reset": "Password reset with an emailed code",
  "account.second_factor_added": "Second factor added",
  "account.second_factor_removed": "Second factor removed",
  "account.recovery_codes": "New recovery codes generated",
  "account.passkey_added": "Passkey or hardware security key added",
  "account.passkey_removed": "Passkey or hardware security key removed",
  "api_token.create": "API token made",
  "api_token.change": "API token changed",
  "oauth_client.create": "OAuth client registered",
  "oauth_client.change": "OAuth client changed",
  "oauth_client.rotate": "OAuth client's secret rotated",
  "oauth_client.delete": "OAuth client deleted",
  "oauth.connect": "App connected",
  "oauth.disconnect": "App disconnected",
  "api_token.revoke": "API token revoked",
  "account.deleted": "Account deleted",
  "account.directory_sign_in": "Signed in with the directory",
  "account.sso_sign_in": "Signed in with single sign-on",
  "project.archive": "Project archived",
  "project.unarchive": "Project brought back",
  "project.deletion_request": "Project deletion asked for",
  "project.deletion_confirm": "Project deletion confirmed",
  "project.deletion_cancel": "Project deletion withdrawn",
  "project.delete": "Project deleted",
  "project.transfer_request": "Project move asked for",
  "project.transfer_approve": "Project move approved",
  "project.transfer_accept": "Project move accepted",
  "project.transfer_refuse": "Project move refused",
  "project.transfer_cancel": "Project move withdrawn",
  "project.transfer": "Project moved between workspaces",
  "project.croom_import": "ControlRoom project imported",
  "support.attachment_download": "Ticket attachment downloaded",
  "project.asset_security": "Project downloads and deletion changed",
  "file.metadata_edit": "Embedded metadata corrected",
} satisfies Record<AuditAction, string>;

/** Plain words for what each entry records; every action has some, or this does not compile. */
export const actionCopy: Record<string, string> = actionWords;

/** How far back the log's time filter reaches. */
export const logSince = ["day", "week", "month", "year"] as const;
export type LogSince = (typeof logSince)[number];

export const logSinceLabels: Record<LogSince, string> = {
  day: "Past day",
  week: "Past week",
  month: "Past month",
  year: "Past year",
};

const DAY = 24 * 60 * 60 * 1000;
const sinceDays: Record<LogSince, number> = { day: 1, week: 7, month: 30, year: 365 };

/**
 * What narrows the access log (decision 263): an action, a project, a file, a review, a person
 * (a member or a guest) and how far back. A file, a review and a guest are picked from an entry.
 */
export interface LogFilters {
  action?: string;
  projectId?: string;
  fileId?: string;
  reviewId?: string;
  userId?: string;
  guestId?: string;
  since?: LogSince;
}

export type LogFilterKey = keyof LogFilters;

/** The order filters show in, as chips. */
export const logFilterKeys: LogFilterKey[] = [
  "action",
  "projectId",
  "fileId",
  "reviewId",
  "userId",
  "guestId",
  "since",
];

/**
 * The query the log is read with: each filter set, and a time filter as the moment it starts,
 * worked out when the log is read (so a page left open reads its own past day).
 */
export function logQuery(filters: LogFilters, now = Date.now()): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of logFilterKeys) {
    const value = filters[key];
    if (!value) continue;
    if (key === "since")
      query.from = new Date(now - sinceDays[value as LogSince] * DAY).toISOString();
    else query[key] = value;
  }
  return query;
}

/** Whether any filter is set. */
export const filtered = (filters: LogFilters) => logFilterKeys.some((key) => filters[key]);

/** The filters with one taken away. */
export function without(filters: LogFilters, key: LogFilterKey): LogFilters {
  const { [key]: _gone, ...rest } = filters;
  return rest;
}

/** The address of the log's CSV export, with the filters the page shows. */
export function exportUrl(filters: LogFilters, now = Date.now()): string {
  const query = new URLSearchParams(logQuery(filters, now)).toString();
  return `/api/organisation/audit.csv${query ? `?${query}` : ""}`;
}
