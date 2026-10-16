import { readFileSync } from "node:fs";
import { z } from "zod";

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
const fileSettings = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "SMTP_URL",
  "MASTER_KEY",
  "MASTER_KEYS_PREVIOUS",
];

function withFileSettings(env: Record<string, string | undefined>) {
  const resolved = { ...env };
  for (const name of fileSettings) {
    const file = env[`${name}_FILE`];
    if (!env[name] && file) resolved[name] = readFileSync(file, "utf8").trim();
  }
  return resolved;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /** Directory holding the built web app; served with a single-page fallback when set. */
  WEB_DIST: z.string().optional(),
  /** Run pending migrations at start-up (the default in the app image). */
  MIGRATE_ON_START: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Public URL Hekate is served from, used for auth callbacks and trusted origins. */
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  /** Secret for signing sessions and tokens; at least 32 characters. */
  AUTH_SECRET: z.string().min(32),
  /**
   * Instance master key for encryption at rest: 32 random bytes, base64 encoded
   * (`openssl rand -base64 32`). It wraps every organisation key. Losing it loses
   * every stored file, so back it up apart from the database and storage.
   */
  MASTER_KEY: masterKey,
  /** Earlier master keys, comma separated, kept only while rotating (docs/security.md). */
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
            ctx.addIssue({ code: "custom", message: "each key must be 32 bytes, base64 encoded" });
          }
          return key;
        }),
    ),
  /** SMTP connection URL, for example smtp://user:pass@host:587. Without it, emails are written to the log. */
  SMTP_URL: z.string().url().optional(),
  /**
   * Check new passwords against Have I Been Pwned, sending only the first five characters of
   * a hash. Turn off on an instance without internet access.
   */
  PASSWORD_LEAK_CHECK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /**
   * Ask every account on the instance for a second factor, whatever its workspaces say. People
   * without one are asked at their next sign-in and cannot continue until they add one.
   */
  REQUIRE_SECOND_FACTOR: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** How many passkeys and hardware security keys one account may hold. */
  MAX_PASSKEYS: z.coerce.number().int().min(1).max(50).default(5),
  /**
   * Origins of identity providers on a private network (an internal Keycloak, say), comma
   * separated, that the server may reach for single sign-on. Public ones need nothing.
   */
  SSO_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim().replace(/\/$/, ""))
        .filter(Boolean),
    ),
  /** Sender address for email. */
  MAIL_FROM: z.string().default("Hekate <hekate@localhost>"),
  /** Behind a reverse proxy (Caddy in the Compose file), take client addresses from X-Forwarded-For. */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Run background workers (media processing) in this process. Turn off for API-only replicas. */
  WORKER: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Media jobs run at once in this process. ffmpeg is CPU-heavy; about half the cores is a good start. */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(2),
  /**
   * Scratch space for decrypted media while a job runs. A tmpfs keeps it off disk. Media
   * tools take paths inside it as filter arguments, so it is limited to characters that
   * never need escaping there.
   */
  WORK_DIR: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]*$/, "must be an absolute path of letters, digits, / _ . and -")
    .optional(),
  /**
   * What the daily storage reconciliation does with bytes and blobs nothing uses, once a
   * second run a day later still finds them: `remove` them, or only `report` them.
   */
  STORAGE_RECONCILE: z.enum(["remove", "report"]).default("remove"),
  /** Extra origins allowed to call the API with credentials (comma separated), for example the Vite dev server. */
  TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(withFileSettings(env));
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
