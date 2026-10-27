import { type Database, schema } from "@hekate/db";
import type {
  InstanceEnvironment,
  InstanceOperations,
  InstanceSettings,
  QueueRow,
  SystemHealth,
  SystemInformation,
} from "@hekate/shared";
import { count, desc, gt } from "drizzle-orm";

/**
 * The support bundle (decision 254): what an operator downloads from Debug tools to attach to an
 * issue or send to whoever helps them. It describes the machine, never its content or its people:
 * no secret, credential, address, name, file name or workspace name is in it, and nothing a
 * failure's message could carry, only where it happened and the code it ran through.
 */

export interface SupportBundleError {
  reference: string;
  occurredAt: string;
  source: string;
  location: string;
  status: number | null;
  /** The error's class (`PdfError`), from the first line of its stack; never the message. */
  kind: string | null;
  /** The stack's frames: where in the code, nothing of what it was given. */
  frames: string[];
}

export interface SupportBundle {
  kind: "hekate-support-bundle";
  format: 1;
  generatedAt: string;
  system: Omit<SystemInformation, "available">;
  environment: {
    subdomains: boolean;
    requireSecondFactor: boolean;
    operatorSecurityKey: boolean;
    mail: InstanceEnvironment["mail"];
    bounces: { provider: string; secretSet: boolean } | null;
    passwordLeakCheck: boolean;
    sessionDays: number;
    /** Whether traces and logs go to a collector; never where. */
    telemetry: boolean;
    modules: { billing: string; support: string };
  };
  settings: Omit<InstanceSettings, "support"> & {
    support: { statusPage: boolean; onCall: boolean };
  };
  capacity: InstanceOperations["capacity"];
  health: {
    now: SystemHealth["now"];
    services: SystemHealth["services"];
    storage: {
      backends: Omit<SystemHealth["storage"]["backends"][number], "where">[];
      masterKey: SystemHealth["storage"]["masterKey"];
      reconciliation: SystemHealth["storage"]["reconciliation"];
    };
  };
  queues: QueueRow[] | null;
  flags: { key: string; on: boolean }[];
  counts: { workspaces: number; accounts: number; projects: number; files: number };
  errors: SupportBundleError[];
}

/** A stack's class and frames, without its message: a frame names code, never data. */
export function stackOutline(stack: string | null): { kind: string | null; frames: string[] } {
  if (!stack) return { kind: null, frames: [] };
  const [first = "", ...rest] = stack.split("\n");
  const kind = /^([A-Za-z_$][\w$]*)(?::|$)/.exec(first.trim())?.[1] ?? null;
  // A frame is `at name (path:line:column)` or `at path:line:column`; anything else is dropped,
  // as a message running over several lines would be.
  const frames = rest
    .map((line) => line.trim())
    .filter((line) => /^at [\w$.<>\s[\]]*\(?[^()\s]+:\d+:\d+\)?$/.test(line))
    .slice(0, 30);
  return { kind, frames };
}

/** The day's failures, as the bundle carries them. */
export async function bundleErrors(db: Database, since: Date): Promise<SupportBundleError[]> {
  const rows = await db
    .select({
      reference: schema.errorReports.reference,
      occurredAt: schema.errorReports.occurredAt,
      source: schema.errorReports.source,
      location: schema.errorReports.location,
      status: schema.errorReports.status,
      stack: schema.errorReports.stack,
    })
    .from(schema.errorReports)
    .where(gt(schema.errorReports.occurredAt, since))
    .orderBy(desc(schema.errorReports.occurredAt))
    .limit(200);
  return rows.map((r) => ({
    reference: r.reference,
    occurredAt: r.occurredAt.toISOString(),
    source: r.source,
    location: r.location,
    status: r.status,
    ...stackOutline(r.stack),
  }));
}

/** How big the instance is, in counts alone. */
export async function bundleCounts(db: Database): Promise<SupportBundle["counts"]> {
  const tally = async (
    table:
      | typeof schema.organisations
      | typeof schema.users
      | typeof schema.projects
      | typeof schema.files,
  ) => (await db.select({ n: count() }).from(table))[0]?.n ?? 0;
  const [workspaces, accounts, projects, files] = await Promise.all([
    tally(schema.organisations),
    tally(schema.users),
    tally(schema.projects),
    tally(schema.files),
  ]);
  return { workspaces, accounts, projects, files };
}

/** The environment as the bundle says it: what is on, never an address or a secret. */
export function bundleEnvironment(env: InstanceEnvironment): SupportBundle["environment"] {
  return {
    subdomains: Boolean(env.subdomains),
    requireSecondFactor: env.requireSecondFactor,
    operatorSecurityKey: env.operatorSecurityKey,
    mail: env.mail,
    bounces: env.bounces
      ? { provider: env.bounces.provider, secretSet: env.bounces.secretSet }
      : null,
    passwordLeakCheck: env.passwordLeakCheck,
    sessionDays: env.sessionDays,
    telemetry: Boolean(env.telemetry),
    modules: { billing: env.modules.billing, support: env.modules.support },
  };
}

/** The settings as the bundle says them: who is on call, and where the status page is, left out. */
export function bundleSettings(settings: InstanceSettings): SupportBundle["settings"] {
  const { support, ...rest } = settings;
  return { ...rest, support: { statusPage: support.statusUrl !== null, onCall: !!support.onCall } };
}

/** The machine's health as the bundle says it: each backend without its path or bucket. */
export function bundleHealth(health: SystemHealth): SupportBundle["health"] {
  return {
    now: health.now,
    services: health.services,
    storage: {
      backends: health.storage.backends.map(({ where: _where, ...b }) => b),
      masterKey: health.storage.masterKey,
      reconciliation: health.storage.reconciliation,
    },
  };
}
