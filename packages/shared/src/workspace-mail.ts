import { z } from "zod";
import { type MailProvider, type MailStepInput, mailProviders, mailStepFields } from "./install.ts";

/**
 * A workspace's own mail (#161): what its members, guests and invitations are sent through
 * instead of the instance's mail, with the providers the installer offers (#71). Mail that
 * belongs to an account rather than a workspace (a password reset, say) stays with the
 * instance.
 */

/** Every provider but the log: a workspace sends, or leaves sending to the instance. */
export const workspaceMailProviders = (Object.keys(mailProviders) as MailProvider[]).filter(
  (p) => mailProviders[p].transport !== "log",
);

/**
 * A save. The secret may be left out to keep the one stored; the server puts it back before
 * checking the whole as the installer's mail step does.
 */
export const workspaceMailInput = mailStepFields.extend({
  provider: z.enum(workspaceMailProviders as [MailProvider, ...MailProvider[]]),
  /** What proves a bounce report came from the provider (#161); kept when left out. */
  webhookSecret: z.string().trim().max(1024).optional(),
});
export type WorkspaceMailInput = z.infer<typeof workspaceMailInput>;

/** A test of the saved mail: one message, to whoever asks. */
export const workspaceMailTestInput = z.object({}).strict();

/** The workspace's mail as settings show it: everything but its secret. */
export interface WorkspaceMail {
  provider: MailProvider;
  from: string;
  /** Where it leaves through: a host and port, a Microsoft 365 tenant, or a Mailcoach account. */
  target: string;
  host: string | null;
  port: number | null;
  username: string | null;
  tenant: string | null;
  clientId: string | null;
  url: string | null;
  hasSecret: boolean;
  /** Bounce reports: whether a secret is set to check them, and the address to send them to. */
  hasWebhookSecret: boolean;
  bounceUrl: string | null;
  /** Addresses its provider reported, which its mail no longer sends to. */
  suppressed: number;
  /** Paused after repeated failures until this time; the instance's mail stands in meanwhile. */
  pausedUntil: string | null;
  failures: number;
  lastSentAt: string | null;
  lastError: string | null;
}

/** A workspace's mail fails this many times in a row, and pauses. */
export const MAIL_PAUSE_AFTER = 5;
/** For this long; the instance's mail sends meanwhile. */
export const MAIL_PAUSE_MINUTES = 15;

/** Where a provider's mail leaves through, in words for its row. */
export function workspaceMailTarget(mail: MailStepInput): string {
  const preset = mailProviders[mail.provider];
  if (preset.transport === "microsoft") return `Microsoft 365 · ${mail.tenant ?? ""}`;
  if (preset.transport === "mailcoach") {
    try {
      return new URL(mail.url ?? "").host;
    } catch {
      return mail.url ?? "";
    }
  }
  return `${preset.host ?? mail.host ?? ""}:${mail.port ?? preset.port ?? 587}`;
}
