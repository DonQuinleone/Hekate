import { type Database, schema } from "@hekate/db";
import { createTransport } from "nodemailer";
import { type Email, render } from "./email/render.ts";

/** One mail: plain text always, and its HTML alternative when there is one. */
export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(message: Message): Promise<void>;
  /** Whether the mail server answers (#156); none when mail goes to the log. */
  verify?(): Promise<unknown>;
}

/**
 * How instance mail leaves (#71): SMTP (any of the providers that offer it), Microsoft 365
 * through Microsoft Graph, Mailcoach's transactional API, or the server's log.
 */
export type MailTransport =
  | { kind: "smtp"; url: string }
  | { kind: "microsoft"; tenant: string; clientId: string; clientSecret: string }
  | { kind: "mailcoach"; url: string; token: string }
  | { kind: "log" };

/** The transport the settings name; at most one is ever set (checked as the config loads). */
export function mailTransportOf(settings: {
  SMTP_URL?: string | undefined;
  MAIL_GRAPH_TENANT?: string | undefined;
  MAIL_GRAPH_CLIENT_ID?: string | undefined;
  MAIL_GRAPH_CLIENT_SECRET?: string | undefined;
  MAIL_MAILCOACH_URL?: string | undefined;
  MAIL_MAILCOACH_TOKEN?: string | undefined;
}): MailTransport {
  if (
    settings.MAIL_GRAPH_TENANT &&
    settings.MAIL_GRAPH_CLIENT_ID &&
    settings.MAIL_GRAPH_CLIENT_SECRET
  )
    return {
      kind: "microsoft",
      tenant: settings.MAIL_GRAPH_TENANT,
      clientId: settings.MAIL_GRAPH_CLIENT_ID,
      clientSecret: settings.MAIL_GRAPH_CLIENT_SECRET,
    };
  if (settings.MAIL_MAILCOACH_URL && settings.MAIL_MAILCOACH_TOKEN)
    return {
      kind: "mailcoach",
      url: settings.MAIL_MAILCOACH_URL,
      token: settings.MAIL_MAILCOACH_TOKEN,
    };
  if (settings.SMTP_URL) return { kind: "smtp", url: settings.SMTP_URL };
  return { kind: "log" };
}

/** How long a provider is given to answer before the message counts as failed. */
const PROVIDER_TIMEOUT_MS = 20_000;

/** A provider's refusal in its own words, cut short, and never with the request's secrets. */
async function refused(provider: string, res: Response): Promise<Error> {
  const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 300);
  return new Error(`${provider} answered ${res.status}${body ? `: ${body}` : ""}`);
}

/** The whole message as MIME (plain text and HTML together), as Graph takes it. */
async function mimeOf(from: string, message: Message): Promise<Buffer> {
  const built = await createTransport({ streamTransport: true, buffer: true }).sendMail({
    from,
    ...message,
  });
  return built.message as Buffer;
}

/** The address of a `Name <address>` sender, or the sender itself. */
const senderAddress = (from: string) => /<([^>]+)>\s*$/.exec(from.trim())?.[1] ?? from.trim();

/**
 * Microsoft 365 (#71): Exchange Online turns basic SMTP sign-in off by default at the end of
 * 2026, so mail goes through Microsoft Graph as the sender's mailbox, with an app registration
 * granted Mail.Send. Its token is kept until a minute before it lapses.
 */
function graphMailer(
  transport: Extract<MailTransport, { kind: "microsoft" }>,
  from: string,
  fetcher: typeof fetch,
): Mailer {
  let token: { value: string; until: number } | null = null;
  const signIn = async () => {
    if (token && token.until > Date.now()) return token.value;
    const res = await fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(transport.tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: transport.clientId,
          client_secret: transport.clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw await refused("Microsoft sign-in", res);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Microsoft sign-in gave no token");
    token = {
      value: body.access_token,
      until: Date.now() + Math.max(0, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return token.value;
  };
  return {
    async send(message) {
      const res = await fetcher(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderAddress(from))}/sendMail`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${await signIn()}`, "content-type": "text/plain" },
          body: (await mimeOf(from, message)).toString("base64"),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        },
      );
      if (res.status !== 202 && !res.ok) throw await refused("Microsoft Graph", res);
    },
    verify: signIn,
  };
}

/** Plain text as HTML that reads the same: escaped, its line breaks kept. */
export const htmlOfText = (text: string) =>
  `<p>${text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>")}</p>`;

/** Mailcoach (#71): its transactional API, which keeps no copy of what Hekate sends. */
function mailcoachMailer(
  transport: Extract<MailTransport, { kind: "mailcoach" }>,
  from: string,
  fetcher: typeof fetch,
): Mailer {
  const at = (path: string) => new URL(path, `${transport.url.replace(/\/+$/, "")}/`);
  const headers = {
    authorization: `Bearer ${transport.token}`,
    accept: "application/json",
    "content-type": "application/json",
  };
  return {
    // The account the token belongs to, for the health check (#156).
    async verify() {
      const res = await fetcher(at("api/user"), {
        headers,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!res.ok) throw await refused("Mailcoach", res);
    },
    async send(message) {
      const res = await fetcher(at("api/transactional-mails/send"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          // Mailcoach takes a body only as HTML: a message with none is sent as its text.
          html: message.html ?? htmlOfText(message.text),
          store: false,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!res.ok) throw await refused("Mailcoach", res);
    },
  };
}

/** The mailer for a transport; with none, messages go to the log so development needs no server. */
export function createMailer(options: {
  transport: MailTransport;
  from: string;
  /** For tests: what reaches a provider's API. */
  fetch?: typeof fetch;
}): Mailer {
  const { transport, from } = options;
  const fetcher = options.fetch ?? fetch;
  if (transport.kind === "microsoft") return graphMailer(transport, from, fetcher);
  if (transport.kind === "mailcoach") return mailcoachMailer(transport, from, fetcher);
  if (transport.kind === "log") {
    return {
      async send(message) {
        console.info(`[mail] to ${message.to}: ${message.subject}\n${message.text}`);
      },
    };
  }
  const smtp = createTransport(transport.url);
  return {
    async send(message) {
      await smtp.sendMail({ from, ...message });
    },
    verify: () => smtp.verify(),
  };
}

/** Send a message in Hekate's shape, as plain text and HTML together. */
export function sendEmail(mailer: Mailer, to: string, email: Email) {
  const { subject, text, html } = render(email);
  return mailer.send({ to, subject, text, html });
}

/** Collects messages for tests. */
export function memoryMailer(): Mailer & { sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

/** The mail server's words are kept, but not all of them: a reply can run long. */
const ERROR_CHARS = 500;

/**
 * A mailer that writes every message to the mail log (#157): sent, refused with the server's or
 * provider's words, or written to the server's log where nothing sends mail. Writing the log never
 * stands in the way of the message, nor hides its failure.
 */
export function loggedMailer<M extends Mailer>(db: Database, mailer: M, sends: boolean): M {
  const record = (
    message: Message,
    result: (typeof schema.mailEvents.$inferInsert)["result"],
    error?: unknown,
  ) =>
    db
      .insert(schema.mailEvents)
      .values({
        recipient: message.to,
        subject: message.subject,
        result,
        error:
          error === undefined
            ? null
            : (error instanceof Error ? error.message : String(error)).slice(0, ERROR_CHARS),
      })
      .catch((cause: unknown) => console.error("Could not write the mail log:", cause));
  return {
    ...mailer,
    async send(message: Message) {
      // Written beside the message, never awaited: a slow log holds nothing up.
      try {
        await mailer.send(message);
      } catch (error) {
        void record(message, "failed", error);
        throw error;
      }
      void record(message, sends ? "sent" : "logged");
    },
  };
}
