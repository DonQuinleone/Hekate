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
