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
  /** Sender address for email. */
  MAIL_FROM: z.string().default("Hekate <hekate@localhost>"),
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
