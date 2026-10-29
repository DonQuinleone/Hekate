import { createSql } from "@hekate/db";
import type { Config } from "../config.ts";
import { fetchClient } from "./client.ts";
import { accounts, PASSWORD, seed } from "./seed.ts";

/**
 * `cli.ts demo seed` (decision 266): fills the demo instance at PUBLIC_URL with the seed's
 * sample data, through its API, and says who to sign in as. Only a demo: HEKATE_DEMO must be
 * set, and the configuration already holds PUBLIC_URL to this machine with it.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether the instance still waits for its first owner; waits for the server to answer. */
async function setupNeeded(base: string): Promise<boolean> {
  let lastError: unknown;
  for (let tries = 0; tries < 60; tries++) {
    try {
      const response = await fetch(new URL("/api/setup", base));
      if (!response.ok) throw new Error(`GET /api/setup: ${response.status}`);
      const { needed } = (await response.json()) as { needed: boolean };
      return needed;
    } catch (error) {
      lastError = error;
      await sleep(1000);
    }
  }
  throw new Error(`No answer from ${base} in a minute: ${String(lastError)}`);
}

/** What to tell whoever runs the demo, once it is seeded. */
export function signIns(base: string, setupCode: string): string {
  const width = Math.max(...Object.values(accounts).map((a) => a.email.length));
  return [
    `Seeded Hekate at ${base}. Sign in as:`,
    "",
    ...Object.values(accounts).map(
      (a) => `  ${a.email.padEnd(width)}  ${a.name}, ${a.workspace}: ${a.note}`,
    ),
    "",
    `The password is "${PASSWORD}" for each of them.`,
    `The setup code, ${setupCode}, has been used: the instance is set up.`,
    "There is no mail server: invitations and guest links are written to the app's log",
    "(docker compose ... logs app), to open in a private window.",
  ].join("\n");
}

/** Runs the command; the exit code. */
export async function demoSeed(config: Config): Promise<number> {
  if (!config.HEKATE_DEMO) {
    console.error(
      "demo seed fills a demo instance only: set HEKATE_DEMO=1, as deploy/compose.demo.yml does, which also holds the server to localhost.",
    );
    return 2;
  }
  if (!config.HEKATE_SETUP_CODE) {
    console.error(
      "demo seed needs HEKATE_SETUP_CODE, the code that opens POST /api/setup: give the server and this command the same one.",
    );
    return 2;
  }
  const base = config.PUBLIC_URL;
  if (!(await setupNeeded(base))) {
    console.log(`Hekate at ${base} is already set up: nothing to seed.`);
    return 0;
  }
  console.log(`Seeding ${base}: a few minutes, while the sample media is made and measured.`);
  const sql = createSql(config.DATABASE_URL);
  try {
    await seed({ client: fetchClient(base), setupCode: config.HEKATE_SETUP_CODE, sql });
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log(signIns(base, config.HEKATE_SETUP_CODE));
  return 0;
}
