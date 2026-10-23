import type { MailProvider } from "./install.ts";

/**
 * Bounce reports (#161): providers that tell Hekate, by a signed webhook, which addresses
 * bounced for good or complained, so mail to them stops. Each names the secret that proves a
 * report came from it, and where it is found.
 */
export const bounceProviders = ["resend", "mailgun", "sendgrid", "sparkpost"] as const;
export type BounceProvider = (typeof bounceProviders)[number];

export const isBounceProvider = (
  p: MailProvider | string | null | undefined,
): p is BounceProvider => bounceProviders.includes(p as BounceProvider);

export const bounceSecrets: Record<BounceProvider, { label: string; hint: string }> = {
  resend: {
    label: "Webhook signing secret",
    hint: "In Resend's webhook for email.bounced and email.complained: whsec_…",
  },
  mailgun: {
    label: "HTTP webhook signing key",
    hint: "In Mailgun's sending settings, for the failed (permanent) and complained webhooks.",
  },
  sendgrid: {
    label: "Verification key",
    hint: "SendGrid's signed Event Webhook public key, for bounce and spam report events.",
  },
  sparkpost: {
    label: "Webhook user and password",
    hint: "The basic authentication the webhook sends, as user:password, for bounce and spam complaint events.",
  },
};

export const suppressionKinds = ["bounce", "complaint"] as const;
export type SuppressionKind = (typeof suppressionKinds)[number];

/** An address mail is no longer sent to, and why. */
export interface MailSuppression {
  id: string;
  address: string;
  kind: SuppressionKind;
  provider: string;
  detail: string | null;
  at: string;
}
