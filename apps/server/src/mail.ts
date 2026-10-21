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

/** SMTP when configured; otherwise messages go to the log so development needs no mail server. */
export function createMailer(options: { smtpUrl?: string | undefined; from: string }): Mailer {
  if (!options.smtpUrl) {
    return {
      async send(message) {
        console.info(`[mail] to ${message.to}: ${message.subject}\n${message.text}`);
      },
    };
  }
  const transport = createTransport(options.smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({ from: options.from, ...message });
    },
    verify: () => transport.verify(),
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
 * A mailer that writes every message to the mail log (#157): sent over SMTP, refused with the
 * server's words, or written to the server's log where there is no SMTP. Writing the log never
 * stands in the way of the message, nor hides its failure.
 */
export function loggedMailer<M extends Mailer>(db: Database, mailer: M, smtp: boolean): M {
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
      try {
        await mailer.send(message);
      } catch (error) {
        await record(message, "failed", error);
        throw error;
      }
      await record(message, smtp ? "sent" : "logged");
    },
  };
}
