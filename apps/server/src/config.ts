import { readFileSync } from "node:fs";
import { bounceProviders } from "@hekate/shared";
import { z } from "zod";
import { type LanePlan, lanes, parseLanes, roles } from "./lanes.ts";

const masterKey = z
  .string({ error: "required: 32 random bytes, base64 encoded (openssl rand -base64 32)" })
  .transform((value, ctx) => {
    const key = Buffer.from(value, "base64");
    if (key.length !== 32 || key.toString("base64") !== value.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "must be 32 random bytes, base64 encoded (openssl rand -base64 32)",
      });
    }
    return key;
  });

/** Settings that may instead be read from a file named by `<NAME>_FILE`, for Docker secrets. */
export const fileSettings = [
  "DATABASE_URL",
  "DATABASE_DIRECT_URL",
  "AUTH_SECRET",
  "SMTP_URL",
  "MAIL_GRAPH_CLIENT_SECRET",
  "MAIL_MAILCOACH_TOKEN",
  "MAIL_WEBHOOK_SECRET",
  "MASTER_KEY",
  "MASTER_KEYS_PREVIOUS",
  "METRICS_TOKEN",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
];

export function withFileSettings(env: Record<string, string | undefined>) {
  const resolved = { ...env };
  // A file that cannot be read is a problem like any other, reported with the rest.
  const problems: ConfigProblem[] = [];
  for (const name of fileSettings) {
    const file = env[`${name}_FILE`];
    if (env[name] || !file) continue;
    try {
      resolved[name] = readFileSync(file, "utf8").trim();
    } catch (error) {
      const code = (error as { code?: string }).code;
      problems.push({
        name: `${name}_FILE`,
        message: `cannot read ${file}${code === "ENOENT" ? ": no such file" : code === "EACCES" ? ": permission denied" : ""}`,
      });
    }
  }
  return { resolved, problems };
}

/** What the reference (docs/configuration.md) says about a setting. */
export interface SettingInfo {
  description: string;
  group: (typeof settingGroups)[number];
  /** Shown as an example value; never a real secret. */
  example?: string;
  /** May be read from a file named by `<NAME>_FILE` (Docker secrets). */
  secret?: boolean;
}

export const settingGroups = [
  "Server",
  "Database",
  "Security",
  "Sign-in",
  "Mail",
  "Media",
  "Modules",
] as const;

const info = (meta: SettingInfo) => ({ hekate: meta });
const flag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"], { error: "use true or false" })
    .default(fallback)
    .transform((v) => v === "true");
const list = z
  .string()
  .default("")
  .transform((v) =>
    v
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development")
    .meta(info({ group: "Server", description: "Set to production by the app image." })),
  PORT: z.coerce
    .number({ error: "must be a port number" })
    .int()
    .positive()
    .default(3000)
    .meta(info({ group: "Server", description: "The port the server listens on." })),
  PUBLIC_URL: z
    .url({ error: "must be the full address people open, such as https://review.example.com" })
    .default("http://localhost:3000")
    .meta(
      info({
        group: "Server",
        description:
          "The address people open Hekate at. Links in emails, sign-in callbacks and passkeys are bound to it.",
        example: "https://review.example.com",
      }),
    ),
  TRUST_PROXY: flag("false").meta(
    info({
      group: "Server",
      description:
        "Behind a reverse proxy (Caddy in the Compose file), take client addresses from X-Forwarded-For.",
    }),
  ),
  METRICS_TOKEN: z
    .string()
    .min(32, "must be at least 32 characters (openssl rand -hex 32)")
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "Turns on `/metrics` for Prometheus (#70): a scraper sends it as a bearer token. Unset, there is no `/metrics`.",
        example: "(openssl rand -hex 32)",
        secret: true,
      }),
    ),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url({ error: "must be the collector's OTLP/HTTP address, such as http://otel:4318" })
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "Sends traces and logs to this OpenTelemetry collector over OTLP/HTTP (#162): a span for each request, job and media tool run, and every log line. Unset, nothing is sent.",
        example: "http://otel-collector:4318",
      }),
    ),
  OTEL_EXPORTER_OTLP_HEADERS: z
    .string()
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "Headers sent with every export, as name=value pairs separated by commas: a collector's credentials, say.",
        example: "authorization=Bearer%20(token)",
        secret: true,
      }),
    ),
  OTEL_SERVICE_NAME: z
    .string()
    .default("hekate")
    .meta(
      info({
        group: "Server",
        description:
          "The service name traces and logs carry: worth setting where several instances send to one collector.",
      }),
    ),
  WORKSPACE_SUBDOMAINS: flag("false").meta(
    info({
      group: "Server",
      description:
        "Each workspace also answers at its own name under PUBLIC_URL's host, such as `endless-hall.review.example` (#176). Needs a wildcard DNS record, and a certificate for every name: the subdomains Caddyfile asks the server which names to get one for. One sign-in reaches every workspace someone belongs to: the session cookie is sent to every name under that host, so give Hekate a host of its own (`review.example`, not `example.com`), with no other service beneath it.",
    }),
  ),
  TRUSTED_ORIGINS: list.meta(
    info({
      group: "Server",
      description:
        "Extra origins allowed to call the API with credentials, comma separated: the Vite dev server, say.",
      example: "http://localhost:5173",
    }),
  ),
  WEB_DIST: z
    .string()
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "Directory holding the built web app, served with a single-page fallback. Set in the app image.",
      }),
    ),
  HEKATE_SETTINGS_FILE: z
    .string()
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "The file the installer writes its settings to, read at every start beneath the environment (which wins). Set to /config/hekate.env in the app image; data/hekate.env otherwise.",
        example: "/config/hekate.env",
      }),
    ),
  HEKATE_SETUP_CODE: z
    .string()
    .optional()
    .meta(
      info({
        group: "Server",
        description:
          "The code that opens the installer and creates the first owner, three groups of four letters and digits. Leave unset: the server makes a new one at each start and prints it in its log.",
      }),
    ),
  HEKATE_DEMO: z
    .enum(["0", "1"], { error: "use 1 for the demo, or leave it unset" })
    .default("0")
    .transform((v) => v === "1")
    .meta(
      info({
        group: "Server",
        description:
          "Set to 1 by deploy/compose.demo.yml (decision 265): `cli.ts demo seed` then fills the instance with sample data, and the server starts only with PUBLIC_URL at localhost or 127.0.0.1, so the demo's published keys and passwords can never serve a real address.",
      }),
    ),
  DATABASE_URL: z
    .url({
      error: "must be a PostgreSQL connection URL, such as postgres://hekate:secret@db:5432/hekate",
    })
    .meta(
      info({
        group: "Database",
        description: "The PostgreSQL connection URL.",
        example: "postgres://hekate:secret@db:5432/hekate",
        secret: true,
      }),
    ),
  DATABASE_DIRECT_URL: z
    .url({
      error: "must be a PostgreSQL connection URL, such as postgres://hekate:secret@db:5432/hekate",
    })
    .optional()
    .meta(
      info({
        group: "Database",
        description:
          "A connection to the primary that bypasses a transaction pooler, for what needs a session of its own: migrations, and replicas telling each other of a change. Unset, DATABASE_URL serves for both.",
        example: "postgres://hekate:secret@primary:5432/hekate",
        secret: true,
      }),
    ),
  MIGRATE_ON_START: flag("false").meta(
    info({
      group: "Database",
      description: "Run pending migrations at start-up. On in the app image.",
    }),
  ),
  MIGRATE_ALLOW_DESTRUCTIVE: flag("false").meta(
    info({
      group: "Database",
      description:
        "Let an upgrade apply a migration that drops or rewrites data. Hekate refuses one until this is set: take a backup and read the upgrade notes first, then start once with it and unset it again.",
    }),
  ),
  AUTH_SECRET: z
    .string({ error: "required: at least 32 random characters (openssl rand -hex 32)" })
    .min(32, "must be at least 32 characters (openssl rand -hex 32)")
    .meta(
      info({
        group: "Security",
        description:
          "Signs sessions and tokens, and keys the hashes of recovery codes. At least 32 random characters.",
        example: "(openssl rand -hex 32)",
        secret: true,
      }),
    ),
  MASTER_KEY: masterKey.meta(
    info({
      group: "Security",
      description:
        "The instance master key for encryption at rest: 32 random bytes, base64 encoded. It wraps every workspace key; losing it loses every stored file, so back it up apart from the database and storage.",
      example: "(openssl rand -base64 32)",
      secret: true,
    }),
  ),
  MASTER_KEYS_PREVIOUS: z
    .string()
    .default("")
    .transform((v, ctx) =>
      v
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => {
          const key = Buffer.from(k, "base64");
          if (key.length !== 32) {
            ctx.addIssue({
              code: "custom",
              message: "each key must be 32 bytes, base64 encoded",
            });
          }
          return key;
        }),
    )
    .meta(
      info({
        group: "Security",
        description:
          "Earlier master keys, comma separated, kept only while rotating (docs/security.md).",
        secret: true,
      }),
    ),
  PASSWORD_LEAK_CHECK: flag("true").meta(
    info({
      group: "Sign-in",
      description:
        "Check new passwords against Have I Been Pwned, sending only the first five characters of a hash. Turn off on an instance without internet access.",
    }),
  ),
  REQUIRE_SECOND_FACTOR: flag("false").meta(
    info({
      group: "Sign-in",
      description:
        "Ask every account for a second factor, whatever its workspaces say. People without one are asked at their next sign-in.",
    }),
  ),
  OPERATOR_SECURITY_KEY: flag("true").meta(
    info({
      group: "Sign-in",
      description:
        "Operators reach the instance side only from a session signed in with a passkey or hardware security key. Turn off only for testing.",
    }),
  ),
  MAX_PASSKEYS: z.coerce
    .number({ error: "must be a number from 1 to 50" })
    .int()
    .min(1)
    .max(50)
    .default(5)
    .meta(
      info({
        group: "Sign-in",
        description: "How many passkeys and hardware security keys one account may hold.",
      }),
    ),
  SSO_TRUSTED_ORIGINS: list.meta(
    info({
      group: "Sign-in",
      description:
        "Origins of identity providers on a private network (an internal Keycloak, say), comma separated, that single sign-on may reach. Public ones need nothing.",
      example: "https://login.internal.example",
    }),
  ),
  WEBHOOK_TRUSTED_ORIGINS: list.meta(
    info({
      group: "Server",
      description:
        "Origins on a private network (a chat server or receiver inside your own network), comma separated, that workspaces' channels, webhooks and own mail may reach (#161): `https://host` for a webhook or Mailcoach, `smtp://host:port` for an SMTP server. Public ones need nothing; anything else on a private address is refused.",
      example: "https://hooks.internal.example,smtp://mail.internal.example:587",
    }),
  ),
  SMTP_URL: z
    .url({ error: "must be an SMTP URL, such as smtp://user:pass@mail.example.com:587" })
    .optional()
    .meta(
      info({
        group: "Mail",
        description:
          "The SMTP server to send mail through. Without it, mail is written to the log instead.",
        example: "smtp://user:pass@mail.example.com:587",
        secret: true,
      }),
    ),
  MAIL_FROM: z
    .string()
    .default("Hekate <hekate@localhost>")
    .meta(info({ group: "Mail", description: "The sender of every message." })),
  MAIL_GRAPH_TENANT: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta(
      info({
        group: "Mail",
        description:
          "Microsoft 365, instead of SMTP: the directory (tenant) ID of an app registration granted Mail.Send, which sends as the MAIL_FROM mailbox through Microsoft Graph. With MAIL_GRAPH_CLIENT_ID and MAIL_GRAPH_CLIENT_SECRET.",
        example: "contoso.onmicrosoft.com",
      }),
    ),
  MAIL_GRAPH_CLIENT_ID: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta(
      info({
        group: "Mail",
        description: "Microsoft 365: the app registration's application (client) ID.",
        example: "00000000-0000-0000-0000-000000000000",
      }),
    ),
  MAIL_GRAPH_CLIENT_SECRET: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta(
      info({
        group: "Mail",
        description: "Microsoft 365: a client secret of the app registration.",
        secret: true,
      }),
    ),
  MAIL_MAILCOACH_URL: z
    .url({ error: "must be a web address, such as https://endlesshall.mailcoach.app" })
    .optional()
    .meta(
      info({
        group: "Mail",
        description:
          "Mailcoach, instead of SMTP: the address of the Mailcoach account whose transactional API sends mail. With MAIL_MAILCOACH_TOKEN.",
        example: "https://endlesshall.mailcoach.app",
      }),
    ),
  MAIL_MAILCOACH_TOKEN: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta(
      info({
        group: "Mail",
        description: "Mailcoach: an API token allowed to send transactional mail.",
        secret: true,
      }),
    ),
  MAIL_WEBHOOK_SECRET: z
    .string()
    .trim()
    .min(1)
    .optional()
    .meta(
      info({
        group: "Mail",
        description:
          "Bounce reports (#161, #432): what proves a report came from the instance's mail provider, so Hekate stops sending to addresses that bounced for good or complained. Resend's webhook signing secret, Mailgun's HTTP webhook signing key, SendGrid's verification key, SparkPost's webhook user:password, the ARN of the Amazon SNS topic Amazon SES notifies, Postal's signing public key (its DKIM record's p= value), the bearer token a Plunk workflow's Webhook step sends, or the secret on Mailcoach's webhook. The provider's webhook goes to /api/hooks/mail/instance.",
        secret: true,
      }),
    ),
  MAIL_BOUNCE_PROVIDER: z
    .enum(bounceProviders, { error: `must be one of ${bounceProviders.join(", ")}` })
    .optional()
    .meta(
      info({
        group: "Mail",
        description: `Bounce reports: which provider the instance's mail is (${bounceProviders.join(", ")}), where its host cannot say. Needed for Postal, which runs on a host of your own, and for a self-hosted Plunk; Amazon SES's regional SMTP endpoints, Plunk's own host and Mailcoach are known without it.`,
        example: "postal",
      }),
    ),
  WORKER: flag("true").meta(
    info({
      group: "Media",
      description:
        "Run background jobs (media processing, mail, reminders) in this process. Turn off for API-only replicas.",
    }),
  ),
  SHUTDOWN_DRAIN_SECONDS: z.coerce
    .number({ error: "must be a number of seconds from 0 to 120" })
    .int()
    .min(0)
    .max(120)
    .default(5)
    .meta(
      info({
        group: "Server",
        description:
          "Told to stop, how long a process says it is not ready while still serving, for the load balancer to take it out of rotation first.",
      }),
    ),
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce
    .number({ error: "must be a number of seconds from 5 to 3600" })
    .int()
    .min(5)
    .max(3600)
    .default(30)
    .meta(
      info({
        group: "Server",
        description:
          "Told to stop, how long a process has in all to drain, finish the requests and jobs under way and close. Give the orchestrator a longer grace period (the Compose file allows 40 s).",
      }),
    ),
  ROLE: z
    .enum(roles, { error: `must be one of ${roles.join(", ")}` })
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "What this process does: all (requests and background jobs), api (requests only) or worker (background jobs, answering only health and metrics). Unset, WORKER decides: all, or api when it is false.",
        example: "worker",
      }),
    ),
  WORKER_LANES: z
    .string()
    .optional()
    .transform((text, ctx): LanePlan => {
      if (text === undefined || text.trim() === "") return null;
      const read = parseLanes(text);
      if ("error" in read) {
        ctx.addIssue({ code: "custom", message: read.error });
        return z.NEVER;
      }
      return read.plan;
    })
    .meta(
      info({
        group: "Media",
        description: `The lanes of background jobs a worker takes (${lanes.join(", ")}), each with how many of each kind of its jobs to run at once if not the default (analyse:2 runs up to two measurements, two analyses, two alignments and two checksums). Unset, it takes every lane.`,
        example: "transcode:4,analyse:2,pages",
      }),
    ),
  WORKER_CONCURRENCY: z.coerce
    .number({ error: "must be a number from 1 to 64" })
    .int()
    .min(1)
    .max(64)
    .default(2)
    .meta(
      info({
        group: "Media",
        description:
          "Jobs of each kind of media work run at once in this process (probing, analysing, pages and so on, each up to this many; streaming renditions and alignments half as many). ffmpeg is CPU-heavy; about half the cores is a good start.",
      }),
    ),
  WORK_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]*$/, "must be an absolute path of letters, digits, / _ . and -")
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "Scratch space for decrypted media while a job runs, or a page or download is marked; a tmpfs keeps it off disk. Defaults to hekate-work in the system's temporary directory.",
        example: "/tmp/hekate-work",
      }),
    ),
  ADM_RENDERER_PATH: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]*$/, "must be an absolute path of letters, digits, / _ . and -")
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "Where the EBU ADM Renderer (ear) and its Python packages are installed, to render an ADM master's objects for listening. The image sets it; without it, only an ADM master's bed is heard.",
        example: "/opt/ear",
      }),
    ),
  PDF_FONT: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]*$/, "must be an absolute path of letters, digits, / _ . and -")
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "A TrueType font (.ttf) for text in the PDFs Hekate writes (the annotated score, patch list, stage plan, schedule and comment sheets) that Helvetica cannot print: Greek, Cyrillic, Hebrew, Arabic, a Czech ř. Only the glyphs a PDF uses are embedded; Latin text stays in Helvetica. The image sets DejaVu Sans; without a font, such text prints as question marks.",
        example: "/usr/share/fonts/dejavu/DejaVuSans.ttf",
      }),
    ),
  PDF_FONT_BOLD: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]*$/, "must be an absolute path of letters, digits, / _ . and -")
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "The bold face of PDF_FONT, for headings. Without it, bold text in PDF_FONT is drawn heavier instead.",
        example: "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
      }),
    ),
  PDF_FONT_FALLBACK: list
    .refine(
      (paths) => paths.every((path) => /^\/[A-Za-z0-9/_.-]*$/.test(path)),
      "must be absolute paths of letters, digits, / _ . and -, comma separated",
    )
    .meta(
      info({
        group: "Media",
        description:
          "TrueType fonts, comma separated, tried in turn for characters PDF_FONT lacks. The image sets Droid Sans Fallback, for Chinese, Japanese and Korean.",
        example: "/usr/share/fonts/droid-nonlatin/DroidSansFallback.ttf",
      }),
    ),
  VIDEO_LADDER: z
    .string()
    .default("1080:6000,720:3000,480:1200")
    .transform((text, ctx) => {
      const rungs = text.split(",").map((rung) => {
        const [height, kbps] = rung.trim().split(":").map(Number);
        return { height: height ?? Number.NaN, rate: (kbps ?? Number.NaN) * 1000 };
      });
      const valid = rungs.every(
        (r) =>
          Number.isInteger(r.height) &&
          r.height >= 144 &&
          r.height <= 4320 &&
          r.height % 2 === 0 &&
          Number.isInteger(r.rate) &&
          r.rate >= 100_000 &&
          r.rate <= 100_000_000,
      );
      const descending = rungs.every((r, i) => i === 0 || r.height < (rungs[i - 1]?.height ?? 0));
      if (!valid || !descending || rungs.length > 8) {
        ctx.addIssue({
          code: "custom",
          message:
            "must be up to eight rungs of height:kbps, highest first, such as 1080:6000,720:3000",
        });
        return z.NEVER;
      }
      return rungs;
    })
    .meta(
      info({
        group: "Media",
        description:
          "The video ladder: each rung an even height in pixels and a bitrate in kbit/s, highest first. A video gets the highest rungs at or below its own height, as many as VIDEO_RUNGS allows.",
        example: "2160:16000,1080:6000,720:3000",
      }),
    ),
  VIDEO_RUNGS: z.coerce
    .number({ error: "must be a number from 1 to 4" })
    .int()
    .min(1)
    .max(4)
    .default(2)
    .meta(
      info({
        group: "Media",
        description:
          "The most rungs of the ladder one video is encoded at. Each is another encode, twice over with VIDEO_ROYALTY_FREE.",
      }),
    ),
  VIDEO_ROYALTY_FREE: z
    .enum(["av1", "vp9", "off"], { error: "use av1, vp9 or off" })
    .default("av1")
    .meta(
      info({
        group: "Media",
        description:
          "A royalty-free encoding beside H.264 at every rung, with Opus sound, for browsers that play it: AV1, VP9 (faster to encode, larger), or off.",
      }),
    ),
  VIDEO_HARDWARE: z
    .string()
    .regex(/^\/dev\/dri\/[A-Za-z0-9]+$/, "must be a render node such as /dev/dri/renderD128")
    .optional()
    .meta(
      info({
        group: "Media",
        description:
          "A VAAPI render node (Intel or AMD) to encode H.264 on. Pass the device to the container; a rendition the GPU cannot encode is encoded in software instead.",
        example: "/dev/dri/renderD128",
      }),
    ),
  STORAGE_RECONCILE: z
    .enum(["remove", "report"], { error: "use remove or report" })
    .default("remove")
    .meta(
      info({
        group: "Media",
        description:
          "What the daily storage reconciliation does with bytes and blobs nothing uses, once a second run a day later still finds them: remove them, or only report them.",
      }),
    ),
  HEKATE_BILLING: z
    .enum(["off", "stripe", "paddle", "manual"], { error: "use off, stripe, paddle or manual" })
    .default("off")
    .meta(
      info({
        group: "Modules",
        description:
          "Billing for a hosted offering (decision 041). Off for a self-hosted install, which shows none.",
      }),
    ),
  STRIPE_SECRET_KEY: z
    .string()
    .trim()
    .regex(/^(sk|rk)_test_\w+$/, {
      error:
        "a test-mode secret or restricted key (sk_test_… or rk_test_…): live keys come with the hosted offering",
    })
    .optional()
    .meta(
      info({
        group: "Modules",
        description:
          "With HEKATE_BILLING=stripe (#178): the Stripe account's secret key, or a restricted key allowed customers, products, Checkout, the customer portal and subscriptions. Test mode only for now.",
        example: "sk_test_…",
        secret: true,
      }),
    ),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^whsec_\w+$/, { error: "the endpoint's signing secret, whsec_…" })
    .optional()
    .meta(
      info({
        group: "Modules",
        description:
          "With HEKATE_BILLING=stripe: the signing secret of the webhook endpoint added in Stripe for /api/hooks/billing/stripe, which proves each event came from Stripe.",
        example: "whsec_…",
        secret: true,
      }),
    ),
  STRIPE_TAX: flag("false").meta(
    info({
      group: "Modules",
      description:
        "With HEKATE_BILLING=stripe: work out tax with Stripe Tax, from the address and tax id collected at checkout. Stripe Tax must be set up in the account first.",
    }),
  ),
  HEKATE_SUPPORT: z
    .enum(["off", "app", "link", "mail"], { error: "use off, app, link or mail" })
    .default("off")
    .meta(
      info({
        group: "Modules",
        description:
          "Support: off; app, tickets in the application; link, an external help desk; or mail, tickets sent to an address (decision 041).",
      }),
    ),
  HEKATE_SUPPORT_ADDRESS: z
    .string()
    .optional()
    .meta(
      info({
        group: "Modules",
        description:
          "Where support goes: the help desk's address when HEKATE_SUPPORT is link, or the mailbox when it is mail.",
        example: "support@example.com",
      }),
    ),
  HEKATE_UPDATE_CHECK: flag("false").meta(
    info({
      group: "Modules",
      description:
        "Check the project's public releases once a day, for System information and the Overview. Nothing about the instance is sent. Off by default: the instance asks nothing of anyone.",
    }),
  ),
  HEKATE_BUILD: z
    .string()
    .trim()
    .max(64)
    .default("dev")
    .meta(
      info({
        group: "Modules",
        description: "The commit the image was built from. Set by the image; leave it alone.",
      }),
    ),
  HEKATE_DOCS_URL: z
    .url({ error: "must be a web address" })
    .default("https://docs.hekate.studio")
    .meta(
      info({ group: "Modules", description: "Where the help menu's documentation link goes." }),
    ),
  HEKATE_STATUS_URL: z
    .url({ error: "must be a web address" })
    .optional()
    .meta(
      info({
        group: "Modules",
        description:
          "Another status page for the help menu and the Support page to link to, kept somewhere that stays up when the instance does not. Unset, they link the instance's own page at /status, which always shows the incidents posted from the support desk. The desk can set its own address, which is used instead.",
      }),
    ),
});

/** Every setting the server reads, with what the reference says about it. */
export function settings(): {
  name: string;
  info: SettingInfo;
  fallback?: unknown;
  required: boolean;
}[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const meta = (field.meta() as { hekate: SettingInfo }).hekate;
    const parsed = (field as z.ZodType).safeParse(undefined);
    return {
      name,
      info: meta,
      required: !parsed.success,
      ...(parsed.success && parsed.data !== undefined ? { fallback: rawDefault(field) } : {}),
    };
  });
}

/** A default as it is written in the environment, not as it is parsed. */
function rawDefault(field: z.ZodType): unknown {
  let current: z.ZodType = field;
  for (let i = 0; i < 6; i++) {
    const def = (
      current as {
        def?: { type?: string; defaultValue?: unknown; in?: z.ZodType; innerType?: z.ZodType };
      }
    ).def;
    if (!def) return undefined;
    if (def.type === "default") return def.defaultValue;
    current = (def.in ?? def.innerType) as z.ZodType;
    if (!current) return undefined;
  }
  return undefined;
}

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const { resolved, problems: unread } = withFileSettings(env);
  const result = schema.safeParse(resolved);
  const unreadNames = new Set(unread.map((p) => p.name.replace(/_FILE$/, "")));
  const problems = [
    ...unread,
    // A setting whose file could not be read is reported once, by its file.
    ...(result.success
      ? []
      : problemsOf(result.error, env).filter((p) => !unreadNames.has(p.name))),
    ...together(resolved),
  ];
  if (problems.length > 0 || !result.success) throw new ConfigError(problems);
  return result.data;
}

/** Settings that only make sense with another, checked even when others are wrong. */
function together(env: Record<string, string | undefined>): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const support = env.HEKATE_SUPPORT;
  if ((support === "link" || support === "mail") && !env.HEKATE_SUPPORT_ADDRESS)
    problems.push({
      name: "HEKATE_SUPPORT_ADDRESS",
      message: `required when HEKATE_SUPPORT is ${support}`,
    });
  if (env.HEKATE_BILLING === "stripe")
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])
      if (!env[name]) problems.push({ name, message: "required when HEKATE_BILLING is stripe" });
  // The demo's keys and passwords are published (deploy/demo.env): it serves this machine only.
  if (env.HEKATE_DEMO === "1") {
    const host = hostOf(env.PUBLIC_URL);
    if (host && host !== "localhost" && host !== "127.0.0.1")
      problems.push({
        name: "HEKATE_DEMO",
        message: `the demo serves localhost or 127.0.0.1 only, not ${host}: its keys and passwords are published, so keep PUBLIC_URL on this machine, or unset HEKATE_DEMO`,
      });
  }
  // Mail leaves one way (#71): each provider's settings whole, and no more than one of them.
  const sets = {
    smtp: ["SMTP_URL"],
    microsoft: ["MAIL_GRAPH_TENANT", "MAIL_GRAPH_CLIENT_ID", "MAIL_GRAPH_CLIENT_SECRET"],
    mailcoach: ["MAIL_MAILCOACH_URL", "MAIL_MAILCOACH_TOKEN"],
  };
  const used = Object.entries(sets).filter(([, names]) => names.some((n) => env[n]));
  for (const [, names] of used) {
    const missing = names.filter((n) => !env[n]);
    for (const name of missing)
      problems.push({ name, message: `required with ${names.filter((n) => env[n]).join(", ")}` });
  }
  if (used.length > 1)
    problems.push({
      name: used.flatMap(([, names]) => names.filter((n) => env[n]))[1] ?? "SMTP_URL",
      message: `mail goes out one way: set only one of ${used.map(([, names]) => names[0]).join(", ")}`,
    });
  return problems;
}

/** PUBLIC_URL's host, as the schema would read it; nothing for one the schema refuses. */
function hostOf(publicUrl: string | undefined): string | undefined {
  try {
    return new URL(publicUrl || "http://localhost:3000").hostname;
  } catch {
    return undefined;
  }
}

/** One problem with a setting, in words: which, and what would be valid. */
export interface ConfigProblem {
  name: string;
  message: string;
}

/** Every problem at once, so a start-up fails once rather than once per setting. */
export class ConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(formatProblems(problems));
    this.problems = problems;
  }
}

function problemsOf(error: z.ZodError, env: Record<string, string | undefined>): ConfigProblem[] {
  return error.issues.map((issue) => {
    const name = String(issue.path[0] ?? "configuration");
    const missing = env[name] === undefined && env[`${name}_FILE`] === undefined;
    return {
      name,
      message:
        missing && issue.code === "invalid_type"
          ? `missing: ${issue.message.replace(/^required: /, "")}`
          : issue.message,
    };
  });
}

/** The report printed when Hekate cannot start: each setting, what is wrong, where to read. */
export function formatProblems(problems: ConfigProblem[]): string {
  const width = Math.max(...problems.map((p) => p.name.length));
  const lines = problems.map((p) => `  ${p.name.padEnd(width)}  ${p.message}`);
  const count = problems.length === 1 ? "One setting needs" : `${problems.length} settings need`;
  return [
    `Hekate cannot start. ${count} attention:`,
    "",
    ...lines,
    "",
    "Every setting is described in docs/configuration.md and .env.example.",
  ].join("\n");
}
