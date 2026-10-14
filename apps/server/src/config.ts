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
  /** Name of the organisation created on first start of a self-hosted install. */
  DEFAULT_ORGANISATION: z.string().min(1).default("Studio"),
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
