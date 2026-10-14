import { z } from "zod";

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
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
