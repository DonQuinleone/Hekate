import { type StorageConfig, StorageConfigError, storageConfigFromEnv } from "@hekate/storage";
import {
  type Config,
  ConfigError,
  type ConfigProblem,
  formatProblems,
  loadConfig,
} from "./config.ts";

/**
 * Every setting checked before anything starts, configuration and storage together, with
 * every problem reported at once; exits when there are any. The server and the command line
 * both start here.
 */
export function settingsOrExit(env: Record<string, string | undefined> = process.env): {
  config: Config;
  storageConfig: StorageConfig;
} {
  const problems: ConfigProblem[] = [];
  let config: Config | undefined;
  let storageConfig: StorageConfig | undefined;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }
  try {
    storageConfig = storageConfigFromEnv(env);
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error;
    for (const problem of error.problems) {
      const at = problem.indexOf(": ");
      problems.push(
        at > 0
          ? { name: problem.slice(0, at), message: problem.slice(at + 2) }
          : { name: "STORAGE", message: problem },
      );
    }
  }
  if (problems.length > 0 || !config || !storageConfig) {
    console.error(formatProblems(problems));
    process.exit(1);
  }
  return { config, storageConfig };
}
