import { z } from "zod";

/**
 * The installer (#127, decision 061): what each step asks for, checked the same way in the
 * browser and on the server, and the mail providers it knows.
 */

export const installSteps = [
  "requirements",
  "database",
  "storage",
  "masterKey",
  "mail",
  "address",
] as const;
export type InstallStep = (typeof installSteps)[number];

/** The steps as the rail names them; the last, the first workspace, is the owner's setup. */
export const installStepLabels: Record<InstallStep | "owner", string> = {
  requirements: "Requirements",
  database: "Database",
  storage: "Storage",
  masterKey: "Master key",
  mail: "Mail",
  address: "Address",
  owner: "First workspace",
};

/** The code the server prints in its log, three groups of four: `7KQ2-M9XD-4HPW`. */
export const setupCodeInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4}-?[A-Z0-9]{4}-?[A-Z0-9]{4}$/, "Copy the code from the server's log"),
});

/** The same code as the server keeps it: grouped, without ambiguity in how it was typed. */
export const normaliseSetupCode = (code: string) => {
  const bare = code.trim().toUpperCase().replaceAll("-", "");
  return `${bare.slice(0, 4)}-${bare.slice(4, 8)}-${bare.slice(8, 12)}`;
};

const postgresUrl = z
  .string()
  .trim()
  .min(1, "Give the connection URL")
  .max(2000)
  .pipe(
    z.url({
      protocol: /^postgres(ql)?$/,
      error: "A PostgreSQL URL, such as postgres://hekate:secret@db:5432/hekate",
    }),
  );

/** Nothing when the environment fixes the database; the step still tests and migrates it. */
export const databaseStepInput = z.object({ url: postgresUrl.optional() });

const bucketName = z
  .string()
  .trim()
  .min(3, "Name the bucket")
  .max(63)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, "Lower case letters, digits, dots and hyphens");

export const storageStepInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    /** Absolute, on a volume of its own; omitted when the environment fixes it. */
    path: z
      .string()
      .trim()
      .max(500)
      .regex(/^\//, "An absolute path, such as /data/storage")
      .optional(),
  }),
  z.object({
    kind: z.literal("s3"),
    endpoint: z.url({ error: "A URL, such as https://s3.eu-west-2.amazonaws.com" }).optional(),
    bucket: bucketName,
    region: z.string().trim().min(1, "Give the region").max(64),
    accessKeyId: z.string().trim().max(256).optional(),
    secretAccessKey: z.string().max(512).optional(),
    forcePathStyle: z.boolean(),
    prefix: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9/_.-]*$/, "Letters, digits and / _ . -")
      .optional(),
  }),
]);
export type StorageStepInput = z.infer<typeof storageStepInput>;

/** 32 random bytes, base64: what `openssl rand -base64 32` prints. */
export const isMasterKey = (value: string) =>
  /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(value.trim());

/** A key, generated in the browser or brought along, and the promise that it is kept safe. */
export const masterKeyStepInput = z.object({
  key: z.string().trim().refine(isMasterKey, "44 characters of base64: 32 random bytes").optional(),
  stored: z.literal(true, { error: "Confirm the key is stored where the server cannot reach" }),
});

/** Providers send by SMTP; each fills in its host, port and, where it is fixed, the user. */
export const mailProviders = {
  smtp: { label: "SMTP", host: null, port: 587, username: null, secret: "Password" },
  resend: {
    label: "Resend",
    host: "smtp.resend.com",
    port: 465,
    username: "resend",
    secret: "API key",
  },
  sparkpost: {
    label: "SparkPost",
    host: "smtp.sparkpostmail.com",
    port: 587,
    username: "SMTP_Injection",
    secret: "API key",
  },
  mailgun: {
    label: "Mailgun",
    host: "smtp.mailgun.org",
    port: 587,
    username: null,
    secret: "SMTP password",
  },
  sendgrid: {
    label: "SendGrid",
    host: "smtp.sendgrid.net",
    port: 587,
    username: "apikey",
    secret: "API key",
  },
  postal: { label: "Postal", host: null, port: 25, username: null, secret: "Password" },
  google: {
    label: "Google Workspace",
    host: "smtp.gmail.com",
    port: 587,
    username: null,
    secret: "App password",
  },
  microsoft: {
    label: "Microsoft 365",
    host: "smtp.office365.com",
    port: 587,
    username: null,
    secret: "Password",
  },
  log: { label: "Log only (development)", host: null, port: null, username: null, secret: null },
} as const satisfies Record<
  string,
  {
    label: string;
    host: string | null;
    port: number | null;
    username: string | null;
    secret: string | null;
  }
>;
export type MailProvider = keyof typeof mailProviders;
export const mailProviderIds = Object.keys(mailProviders) as MailProvider[];

const hostName = z
  .string()
  .trim()
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, "A host name, such as smtp.example.com");

export const mailStepInput = z
  .object({
    provider: z.enum(mailProviderIds as [MailProvider, ...MailProvider[]]),
    host: hostName.optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().max(256).optional(),
    password: z.string().max(512).optional(),
    from: z.string().trim().min(3, "Say who mail comes from").max(320),
  })
  .superRefine((mail, ctx) => {
    if (mail.provider === "log") return;
    const preset = mailProviders[mail.provider];
    if (!(preset.host ?? mail.host))
      ctx.addIssue({ code: "custom", path: ["host"], message: "Give the SMTP host" });
    if (!fromAddress(mail.from))
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "An address, or a name and an address: Hekate <hekate@example.com>",
      });
  });
export type MailStepInput = z.infer<typeof mailStepInput>;
export const mailTestInput = z.object({
  mail: mailStepInput,
  to: z.email({ error: "An address to send the test to" }),
});

/** The address in `Name <address>` or a bare address; null when there is none. */
export function fromAddress(from: string) {
  // Read by position rather than a pattern: the last "<…>" at the end, if there is one.
  const text = from.trim();
  const open = text.lastIndexOf("<");
  const address = text.endsWith(">") && open >= 0 ? text.slice(open + 1, -1).trim() : text;
  return address && z.email().safeParse(address).success ? address : null;
}

/** The SMTP URL a provider's settings come to; none for log only. Port 465 is TLS from the start. */
export function smtpUrlOf(mail: MailStepInput): string | undefined {
  if (mail.provider === "log") return undefined;
  const preset = mailProviders[mail.provider];
  const host = preset.host ?? mail.host;
  const port = mail.port ?? preset.port ?? 587;
  const username = preset.username ?? mail.username;
  const auth = username
    ? `${encodeURIComponent(username)}${mail.password ? `:${encodeURIComponent(mail.password)}` : ""}@`
    : "";
  return `${port === 465 ? "smtps" : "smtp"}://${auth}${host}:${port}`;
}

/** What an SMTP URL says, without its password, for showing settings already made. */
export function describeSmtp(url: string): {
  provider: MailProvider;
  host: string;
  port: number;
  username: string | null;
} | null {
  const match = /^(smtps?):\/\/(?:([^:@/]*)(?::[^@/]*)?@)?([^:/?#@]+)(?::(\d+))?\/?$/i.exec(
    url.trim(),
  );
  if (!match) return null;
  const [, scheme, user, host = "", port] = match;
  return {
    provider:
      (Object.entries(mailProviders).find(([, p]) => p.host === host)?.[0] as
        | MailProvider
        | undefined) ?? "smtp",
    host,
    port: Number(port || (scheme?.toLowerCase() === "smtps" ? 465 : 587)),
    username: user ? decodeURIComponent(user) : null,
  };
}

/** The address people open Hekate at: an origin, with no path. */
export const addressStepInput = z.object({
  publicUrl: z
    .string()
    .trim()
    .regex(
      /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i,
      "The full address, such as https://review.example.com",
    )
    .transform((v) => v.replace(/\/$/, "").toLowerCase())
    .optional(),
});

/** One line of a checklist: met, short of what is needed, or worth knowing. */
export interface InstallCheck {
  name: string;
  state: "ok" | "warn" | "fail";
  detail: string;
}

/** Where the installer stands, for whoever holds the setup code. */
export interface InstallState {
  /** The first step not yet saved; `ready` once all are. */
  step: InstallStep | "ready";
  done: InstallStep[];
  /** Steps whose settings the environment gives; they are tested, never overwritten. */
  fixed: InstallStep[];
  settingsFile: string;
  database: { url: string | null };
  storage:
    | { kind: "local"; path: string | null; pathFixed: boolean }
    | { kind: "s3"; bucket: string; region: string | null; endpoint: string | null };
  mail: { provider: MailProvider; host: string | null; port: number | null; from: string | null };
  address: { publicUrl: string | null };
}

/** The connection URL with its password hidden, for showing. */
export const redactUrl = (url: string) => url.replace(/^([a-z]+:\/\/[^:/@]+:)[^@]*@/i, "$1••••@");
