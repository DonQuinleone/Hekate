import { createTransport } from "nodemailer";

export interface Message {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: Message): Promise<void>;
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
  };
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
