import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createDb, runMigrations } from "@hekate/db";
import {
  addressStepInput,
  databaseStepInput,
  describeSmtp,
  type InstallCheck,
  type InstallState,
  type InstallStep,
  installSteps,
  type MailStepInput,
  mailStepInput,
  mailTestInput,
  masterKeyStepInput,
  redactUrl,
  setupCodeInput,
  smtpUrlOf,
  storageStepInput,
} from "@hekate/shared";
import { createBackends, StorageConfigError, storageConfigFromEnv } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { z } from "zod";
import { withFileSettings } from "../config.ts";
import { CodedException } from "../errors.ts";
import { blocking, checkRequirements } from "../install/requirements.ts";
import { createMailer } from "../mail.ts";
import {
  given,
  INSTALLED,
  PROGRESS,
  readSettingsFile,
  withSettings,
  writeSettingsFile,
} from "../settings-file.ts";
import { createSetupGate, requireSetupCode, type SetupGate } from "../setup-code.ts";
import { settingsOrProblems } from "../startup.ts";

export interface InstallerOptions {
  /** The environment the server started with, without the settings file. */
  env: Record<string, string | undefined>;
  settingsFile: string;
  gate: SetupGate;
  /** Known only to this server, so the address check can tell it answered and not another. */
  nonce: string;
  /** Starts the full server once the settings are complete. */
  finish: () => Promise<void>;
  /** For tests: what the requirement checks are told Node's version is. */
  nodeVersion?: string;
}

/** Which settings each step writes; a step whose settings the environment gives is fixed. */
const fixedBy: Record<InstallStep, (env: Record<string, string | undefined>) => boolean> = {
  requirements: () => false,
  database: (env) => given(env, "DATABASE_URL"),
  storage: (env) => given(env, "STORAGE_BACKENDS"),
  masterKey: (env) => given(env, "MASTER_KEY"),
  mail: (env) => given(env, "SMTP_URL") || given(env, "MAIL_FROM"),
  address: (env) => given(env, "PUBLIC_URL"),
};

const problem = (message: string) => new CodedException(422, "install_check_failed", message);

/** A body checked against its schema, refused with the first thing wrong in plain words. */
const valid = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result) => {
    if (!result.success)
      throw new CodedException(
        400,
        "invalid",
        result.error.issues[0]?.message ?? "Check the details and try again",
      );
  });
const elapsed = (from: number) => `${Math.max(1, Math.round(performance.now() - from))} ms`;

/** One mail configuration, as a key: its SMTP URL and its sender. Held in memory only. */
const mailKey = (mail: MailStepInput) => JSON.stringify([smtpUrlOf(mail) ?? "log", mail.from]);

/** A check that takes too long fails rather than leaving the page waiting. */
const within = <T>(ms: number, work: Promise<T>, what: string) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000} s`)), ms),
    ),
  ]);

/**
 * The installer's routes (decision 061). In install mode they configure the server; once it is
 * installed they answer that there is nothing left to do.
 */
export function installRoutes(installer: InstallerOptions | null) {
  // Once installed, nothing past the first two routes is reached; this stands in for the options.
  const options: InstallerOptions = installer ?? {
    env: {},
    settingsFile: "",
    gate: createSetupGate(),
    nonce: "",
    finish: async () => {},
  };
  const { env, settingsFile, gate } = options;
  /** Mail settings a test message went out with, so only those are saved. */
  const tested = new Set<string>();
  /** The full server starting, once. */
  let finishing: Promise<void> | null = null;
  const file = () => readSettingsFile(settingsFile) ?? {};
  const merged = () => withSettings(env, file());
  const progress = () =>
    new Set(
      (file()[PROGRESS] ?? "")
        .split(",")
        .filter((s): s is InstallStep => (installSteps as readonly string[]).includes(s)),
    );
  /** Saves settings and marks a step done; the session secret is made with the first save. */
  const save = (step: InstallStep, values: Record<string, string | null>, drop?: RegExp) => {
    const current = file();
    const next: Record<string, string> = {};
    for (const [name, value] of Object.entries(current)) if (!drop?.test(name)) next[name] = value;
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete next[name];
      else next[name] = value;
    }
    if (!given(env, "AUTH_SECRET") && !next.AUTH_SECRET)
      next.AUTH_SECRET = randomBytes(48).toString("base64url");
    const done = progress();
    done.add(step);
    next[PROGRESS] = installSteps.filter((s) => done.has(s)).join(",");
    writeSettingsFile(settingsFile, next);
  };

  const state = (): InstallState => {
    const settings = merged();
    const done = progress();
    const fixed = installSteps.filter((s) => fixedBy[s](env));
    const smtp = settings.SMTP_URL ? describeSmtp(settings.SMTP_URL) : null;
    const backends = (settings.STORAGE_BACKENDS || "local").split(",").map((n) => n.trim());
    const s3 = backends[0] === "s3";
    return {
      step: installSteps.find((s) => !done.has(s)) ?? "ready",
      done: installSteps.filter((s) => done.has(s)),
      fixed,
      settingsFile,
      database: { url: settings.DATABASE_URL ? redactUrl(settings.DATABASE_URL) : null },
      storage: s3
        ? {
            kind: "s3",
            bucket: settings.STORAGE_S3_BUCKET || "",
            region: settings.STORAGE_S3_REGION || null,
            endpoint: settings.STORAGE_S3_ENDPOINT || null,
          }
        : {
            kind: "local",
            path: settings.STORAGE_LOCAL_PATH || null,
            pathFixed: given(env, "STORAGE_LOCAL_PATH"),
          },
      mail: {
        provider: smtp?.provider ?? (settings.MAIL_FROM ? "log" : "smtp"),
        host: smtp?.host ?? null,
        port: smtp?.port ?? null,
        from: settings.MAIL_FROM || null,
      },
      address: { publicUrl: settings.PUBLIC_URL || null },
    };
  };

  /** Asks the address for this server's nonce: it resolves, it answers, and it is this server. */
  const addressChecks = async (publicUrl: string): Promise<InstallCheck[]> => {
    const url = new URL(publicUrl);
    const checks: InstallCheck[] = [];
    try {
      const { address } = await within(5000, lookup(url.hostname), "DNS");
      checks.push({ name: "DNS resolves", state: "ok", detail: address });
    } catch (error) {
      checks.push({
        name: "DNS resolves",
        state: "fail",
        detail: `${url.hostname} does not resolve: ${(error as Error).message}`,
      });
      return checks;
    }
    try {
      const res = await within(
        8000,
        fetch(new URL("/api/install/ping", url), { redirect: "follow" }),
        "The address",
      );
      const body = (await res.json().catch(() => null)) as { nonce?: unknown } | null;
      const here = body?.nonce === options.nonce;
      checks.push({
        name: url.protocol === "https:" ? "HTTPS answers" : "The address answers",
        state: here ? "ok" : "fail",
        detail: here
          ? url.protocol === "https:"
            ? "certificate valid, and it is this server"
            : "it is this server"
          : "another server answers there",
      });
    } catch (error) {
      checks.push({
        name: url.protocol === "https:" ? "HTTPS answers" : "The address answers",
        state: "fail",
        detail: (error as Error).message,
      });
    }
    if (url.protocol !== "https:")
      checks.push({
        name: "HTTPS",
        state: "warn",
        detail: "without it, passkeys and secure cookies will not work outside this machine",
      });
    return checks;
  };

  return (
    new Hono()
      .get("/", (c) => c.json({ installing: installer !== null }))
      .get("/ping", (c) => c.json({ nonce: installer ? options.nonce : null }))
      .use("*", async (_c, next) => {
        if (!installer) throw new CodedException(409, "installed", "Hekate is already installed");
        await next();
      })
      // The code is checked on its own first, so the page can say at once whether it was right.
      .post("/code", valid(setupCodeInput), (c) => {
        const result = gate.check(c.req.valid("json").code);
        if (result === "locked")
          throw new CodedException(
            429,
            "setup_code_locked",
            "Too many wrong codes. Wait ten minutes, then try again.",
          );
        if (result === "wrong")
          throw new CodedException(
            403,
            "setup_code_wrong",
            "That is not the setup code. Copy it from the server's log.",
          );
        return c.body(null, 204);
      })
      .use("/state", requireSetupCode(gate))
      .use("/steps/*", requireSetupCode(gate))
      .use("/checks/*", requireSetupCode(gate))
      .use("/finish", requireSetupCode(gate))
      .get("/state", (c) => c.json(state()))
      .get("/checks/requirements", (c) =>
        c.json({
          checks: checkRequirements({
            settingsFile,
            ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
          }),
        }),
      )
      .post("/steps/requirements", (c) => {
        const checks = checkRequirements({
          settingsFile,
          ...(options.nodeVersion ? { nodeVersion: options.nodeVersion } : {}),
        });
        if (blocking(checks))
          throw problem(checks.find((check) => check.state === "fail")?.detail ?? "");
        save("requirements", {});
        return c.json({ checks, state: state() });
      })
      .post("/steps/database", valid(databaseStepInput), async (c) => {
        const input = c.req.valid("json");
        // A connection URL the environment gives, directly or from a file (Docker secrets).
        const url = fixedBy.database(env)
          ? withFileSettings(merged()).resolved.DATABASE_URL
          : input.url;
        if (!url) throw problem("Give the connection URL");
        const started = performance.now();
        const { db, close } = createDb(url, { max: 1, connectTimeout: 5 });
        let version: string;
        try {
          const rows = await within(
            8000,
            db.execute<{ server_version: string }>(sql`show server_version`),
            "The database",
          );
          version = String(rows[0]?.server_version ?? "").split(" ")[0] ?? "";
        } catch (error) {
          throw problem(`The database could not be reached: ${(error as Error).message}`);
        } finally {
          await close().catch(() => {});
        }
        const reached = elapsed(started);
        try {
          // Past a transaction pooler where the environment says how (#412): the lock lasts the run.
          await runMigrations(withFileSettings(merged()).resolved.DATABASE_DIRECT_URL || url);
        } catch (error) {
          throw problem(`The migrations failed: ${(error as Error).message}`);
        }
        save("database", fixedBy.database(env) ? {} : { DATABASE_URL: url });
        const supported = Number(version.split(".")[0]) >= 18;
        const checks: InstallCheck[] = [
          {
            name: "Reached",
            state: supported ? "ok" : "warn",
            detail: supported
              ? `in ${reached} · PostgreSQL ${version}`
              : `in ${reached} · PostgreSQL ${version}: Hekate is built and tested on 18`,
          },
          { name: "Migrated", state: "ok", detail: "up to date" },
        ];
        return c.json({ checks, state: state() });
      })
      .post("/steps/storage", valid(storageStepInput), async (c) => {
        const input = c.req.valid("json");
        const values: Record<string, string> = {};
        if (!fixedBy.storage(env)) {
          if (input.kind === "local") {
            values.STORAGE_BACKENDS = "local";
            if (!given(env, "STORAGE_LOCAL_PATH")) {
              if (!input.path) throw problem("Give the path");
              values.STORAGE_LOCAL_PATH = input.path;
            }
          } else {
            values.STORAGE_BACKENDS = "s3";
            values.STORAGE_S3_BUCKET = input.bucket;
            values.STORAGE_S3_REGION = input.region;
            values.STORAGE_S3_FORCE_PATH_STYLE = String(input.forcePathStyle);
            if (input.endpoint) values.STORAGE_S3_ENDPOINT = input.endpoint;
            if (input.prefix) values.STORAGE_S3_PREFIX = input.prefix;
            if (input.accessKeyId) values.STORAGE_S3_ACCESS_KEY_ID = input.accessKeyId;
            if (input.secretAccessKey) values.STORAGE_S3_SECRET_ACCESS_KEY = input.secretAccessKey;
          }
        }
        // Tried as it will run: the environment, the file without its old storage, and these.
        const kept = Object.fromEntries(
          Object.entries(file()).filter(([name]) => !name.startsWith("STORAGE_")),
        );
        const started = performance.now();
        try {
          const backends = createBackends(
            storageConfigFromEnv(withSettings(env, { ...kept, ...values })),
          );
          await within(15000, backends.checkAll(), "The storage");
        } catch (error) {
          throw problem(
            error instanceof StorageConfigError
              ? error.message
              : `The storage could not be written to and read back: ${(error as Error).message}`,
          );
        }
        save("storage", values, fixedBy.storage(env) ? undefined : /^STORAGE_/);
        return c.json({
          checks: [
            {
              name: "Wrote and read a test object",
              state: "ok",
              detail: elapsed(started),
            },
          ] satisfies InstallCheck[],
          state: state(),
        });
      })
      .post("/steps/master-key", valid(masterKeyStepInput), (c) => {
        const { key } = c.req.valid("json");
        if (fixedBy.masterKey(env)) {
          save("masterKey", {});
        } else {
          if (!key) throw problem("Generate a key, or give your own");
          save("masterKey", { MASTER_KEY: key });
        }
        return c.json({ checks: [], state: state() });
      })
      .post("/checks/mail", valid(mailTestInput), async (c) => {
        const { mail, to } = c.req.valid("json");
        const mailer = createMailer({ smtpUrl: smtpUrlOf(mail), from: mail.from });
        try {
          await within(
            20000,
            mailer.send({
              to,
              subject: "Hekate can send mail",
              text: "This is the installer's test message. Mail from Hekate will arrive like this one.",
            }),
            "The mail server",
          );
        } catch (error) {
          throw problem(`The test message was not sent: ${(error as Error).message}`);
        }
        tested.add(mailKey(mail));
        return c.json({
          checks: [
            {
              name: "Test message",
              state: "ok",
              detail: mail.provider === "log" ? "written to the log" : `sent to ${to}`,
            },
          ] satisfies InstallCheck[],
        });
      })
      .post("/steps/mail", valid(mailStepInput), (c) => {
        const mail = c.req.valid("json");
        if (fixedBy.mail(env)) save("mail", {});
        else {
          // Saved only as a test message went out: settings that cannot send never finish.
          if (!tested.has(mailKey(mail)))
            throw problem("Send a test message with these settings first");
          save("mail", { SMTP_URL: smtpUrlOf(mail) ?? null, MAIL_FROM: mail.from });
        }
        return c.json({ checks: [], state: state() });
      })
      .post("/checks/address", valid(addressStepInput), async (c) => {
        const publicUrl = fixedBy.address(env)
          ? merged().PUBLIC_URL
          : c.req.valid("json").publicUrl;
        if (!publicUrl) throw problem("Give the public address");
        return c.json({ checks: await addressChecks(publicUrl) });
      })
      .post("/steps/address", valid(addressStepInput), async (c) => {
        const publicUrl = fixedBy.address(env)
          ? merged().PUBLIC_URL
          : c.req.valid("json").publicUrl;
        if (!publicUrl) throw problem("Give the public address");
        // An address that does not reach this server would break every link, passkey and
        // playback URL: it is saved only once its checks pass.
        const checks = await addressChecks(publicUrl);
        const failed = checks.find((check) => check.state === "fail");
        if (failed) throw problem(`${failed.name}: ${failed.detail}`);
        save("address", fixedBy.address(env) ? {} : { PUBLIC_URL: publicUrl });
        return c.json({ checks, state: state() });
      })
      // Every step saved and the settings whole: mark the file finished and start the server.
      .post("/finish", async (c) => {
        // Two finishes at once start the server once: the second waits for the first.
        if (finishing) {
          await finishing;
          return c.json({ installed: true });
        }
        const current = state();
        if (current.step !== "ready")
          throw problem(
            `Finish the ${current.step === "masterKey" ? "master key" : current.step} step first`,
          );
        const checked = settingsOrProblems(merged());
        if ("problems" in checked)
          throw problem(
            checked.problems.map((p) => `${p.name}: ${p.message}`).join("; ") ||
              "The settings are incomplete",
          );
        writeSettingsFile(settingsFile, { ...file(), [INSTALLED]: "true" });
        finishing = options.finish();
        try {
          await finishing;
        } catch (error) {
          finishing = null;
          throw error;
        }
        return c.json({ installed: true });
      })
  );
}
