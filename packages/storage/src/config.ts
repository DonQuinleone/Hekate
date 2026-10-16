import { readFileSync } from "node:fs";
import { z } from "zod";
import { StorageConfigError } from "./errors.ts";
import { type LocalBackendOptions, localBackend } from "./local.ts";
import { type S3BackendOptions, s3Backend } from "./s3.ts";
import type { StorageBackend } from "./types.ts";

export type BackendConfig =
  | ({ driver: "local" } & LocalBackendOptions)
  | ({ driver: "s3" } & S3BackendOptions);

export interface StorageConfig {
  backends: BackendConfig[];
  /** Where new objects go unless an organisation chooses another backend. */
  defaultBackend: string;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const envName = (name: string) => name.toUpperCase().replaceAll("-", "_");
const flag = z.enum(["true", "false"]).transform((v) => v === "true");

/**
 * Read storage settings from the environment.
 *
 *   STORAGE_BACKENDS=local,archive       named backends (default: local)
 *   STORAGE_DEFAULT=local                default for new objects (default: the first)
 *   STORAGE_<NAME>_DRIVER=local|s3       inferred for backends named "local" or "s3"
 *
 * Local: STORAGE_<NAME>_PATH (the "local" backend defaults to `data/storage`).
 * S3: STORAGE_<NAME>_BUCKET, _REGION, _ENDPOINT, _FORCE_PATH_STYLE, _PREFIX,
 * _ACCESS_KEY_ID and _SECRET_ACCESS_KEY. Credentials may instead be read from a
 * file named by the same variable with `_FILE` appended, for Docker secrets.
 */
export function storageConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const names = (env.STORAGE_BACKENDS ?? "local")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  const problems: string[] = [];
  if (names.length === 0) problems.push("STORAGE_BACKENDS: name at least one backend");
  if (new Set(names).size !== names.length) problems.push("STORAGE_BACKENDS: names must be unique");

  const backends: BackendConfig[] = [];
  for (const name of names) {
    if (!NAME.test(name)) {
      problems.push(
        `STORAGE_BACKENDS: "${name}" must be lower case letters, digits and hyphens, starting with a letter`,
      );
      continue;
    }
    const key = (suffix: string) => `STORAGE_${envName(name)}_${suffix}`;
    const value = (suffix: string) => {
      const direct = env[key(suffix)];
      if (direct !== undefined && direct !== "") return direct;
      const file = env[`${key(suffix)}_FILE`];
      if (!file) return undefined;
      try {
        return readFileSync(file, "utf8").trim();
      } catch (error) {
        problems.push(`${key(suffix)}_FILE: cannot read ${file}: ${(error as Error).message}`);
        return undefined;
      }
    };

    const driver = value("DRIVER") ?? (name === "local" || name === "s3" ? name : undefined);
    if (driver === "local") {
      const root = value("PATH") ?? (name === "local" ? "data/storage" : undefined);
      if (!root) problems.push(`${key("PATH")}: required for a local backend`);
      else backends.push({ driver, name, root });
    } else if (driver === "s3") {
      const bucket = value("BUCKET");
      if (!bucket) problems.push(`${key("BUCKET")}: required for an S3 backend`);
      const forcePathStyle = flag.safeParse(value("FORCE_PATH_STYLE") ?? "false");
      if (!forcePathStyle.success) problems.push(`${key("FORCE_PATH_STYLE")}: use true or false`);
      const endpoint = value("ENDPOINT");
      if (endpoint && !z.url().safeParse(endpoint).success) {
        problems.push(`${key("ENDPOINT")}: must be a URL`);
      }
      const accessKeyId = value("ACCESS_KEY_ID");
      const secretAccessKey = value("SECRET_ACCESS_KEY");
      if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
        problems.push(
          `${key("ACCESS_KEY_ID")} and ${key("SECRET_ACCESS_KEY")}: set both or neither`,
        );
      }
      const options: S3BackendOptions = { name, bucket: bucket ?? "" };
      const region = value("REGION");
      const prefix = value("PREFIX");
      if (region) options.region = region;
      if (endpoint) options.endpoint = endpoint;
      if (forcePathStyle.success) options.forcePathStyle = forcePathStyle.data;
      if (accessKeyId) options.accessKeyId = accessKeyId;
      if (secretAccessKey) options.secretAccessKey = secretAccessKey;
      if (prefix) options.prefix = prefix;
      backends.push({ driver, ...options });
    } else {
      problems.push(`${key("DRIVER")}: must be "local" or "s3"`);
    }
  }

  const defaultBackend = env.STORAGE_DEFAULT || names[0] || "";
  if (defaultBackend && !names.includes(defaultBackend)) {
    problems.push(`STORAGE_DEFAULT: "${defaultBackend}" is not listed in STORAGE_BACKENDS`);
  }

  if (problems.length > 0) {
    throw new StorageConfigError(
      `Invalid storage configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`,
      problems,
    );
  }
  return { backends, defaultBackend };
}

export function createBackend(config: BackendConfig): StorageBackend {
  return config.driver === "local" ? localBackend(config) : s3Backend(config);
}

/** Every configured backend by name, and the default. */
export interface Backends {
  get(name: string): StorageBackend;
  has(name: string): boolean;
  names(): string[];
  readonly defaultBackend: string;
  /** Check every backend; rejects with all failures together. */
  checkAll(): Promise<void>;
}

export function createBackends(config: StorageConfig): Backends {
  const byName = new Map(config.backends.map((b) => [b.name, createBackend(b)] as const));
  if (!byName.has(config.defaultBackend)) {
    throw new StorageConfigError(
      `Default storage backend "${config.defaultBackend}" is not configured`,
    );
  }
  return {
    defaultBackend: config.defaultBackend,
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
    get(name) {
      const backend = byName.get(name);
      if (!backend) throw new StorageConfigError(`Storage backend "${name}" is not configured`);
      return backend;
    },
    async checkAll() {
      const results = await Promise.allSettled([...byName.values()].map((b) => b.check()));
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as Error).message);
      if (failures.length > 0) throw new StorageConfigError(failures.join("\n"));
    },
  };
}
