import { readFileSync } from "node:fs";
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
  "AUTH_SECRET",
  "SMTP_URL",
  "MASTER_KEY",
  "MASTER_KEYS_PREVIOUS",
  "METRICS_TOKEN",
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
  WORKER: flag("true").meta(
    info({
      group: "Media",
      description:
        "Run background jobs (media processing, mail, reminders) in this process. Turn off for API-only replicas.",
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
        description: `The lanes of background jobs a worker takes (${lanes.join(", ")}), each with how many at once if not the default. Unset, it takes every lane.`,
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
          "Media jobs run at once in this process. ffmpeg is CPU-heavy; about half the cores is a good start.",
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
        description: "A status page for the help menu to link to; none when unset.",
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
  const support = env.HEKATE_SUPPORT;
  if ((support === "link" || support === "mail") && !env.HEKATE_SUPPORT_ADDRESS)
    return [
      { name: "HEKATE_SUPPORT_ADDRESS", message: `required when HEKATE_SUPPORT is ${support}` },
    ];
  return [];
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
