import { type Database, inOrg, schema } from "@hekate/db";
import {
  type DirectorySettings,
  type DirectorySettingsInput,
  defaultDirectorySettings,
  escapeFilterValue,
} from "@hekate/shared";
import { Client, InvalidCredentialsError } from "ldapts";
import type { Keyring } from "./keyring.ts";
import { openSecret, sealSecret } from "./secrets.ts";

const { directories } = schema;

/** What Hekate needs of a directory to look someone up and check their password. */
export interface DirectoryConfig {
  url: string;
  verifyCertificate: boolean;
  bindDn: string;
  bindPassword: string;
  userBase: string;
  userFilter: string;
  emailAttribute: string;
  nameAttribute: string;
  groupBase: string;
  groupFilter: string;
}

/** A person the directory knows, once their password has been checked. */
export interface DirectoryPerson {
  dn: string;
  email: string | null;
  name: string | null;
  groups: string[];
}

const TIMEOUT_MS = 8000;
const sealContext = (organisationId: string) => `directory-bind:${organisationId}`;

// TLS options only for ldaps://: given at all, the client speaks TLS from the start.
const client = (config: DirectoryConfig) =>
  new Client({
    url: config.url,
    timeout: TIMEOUT_MS,
    connectTimeout: TIMEOUT_MS,
    ...(config.url.startsWith("ldaps://")
      ? { tlsOptions: { rejectUnauthorized: config.verifyCertificate } }
      : {}),
  });

const first = (value: unknown): string | null => {
  const one = Array.isArray(value) ? value[0] : value;
  if (one === undefined || one === null) return null;
  return Buffer.isBuffer(one) ? one.toString("utf8") : String(one);
};

/**
 * Whether a password is a known person's, by binding as their DN: how someone signed in
 * through the directory, with no password here, confirms who they are (deleting their
 * account). False for a wrong or empty password.
 */
export async function verifyPassword(
  config: DirectoryConfig,
  dn: string,
  password: string,
): Promise<boolean> {
  if (!password) return false;
  const person = client(config);
  try {
    await person.bind(dn, password);
    return true;
  } catch (error) {
    if (error instanceof InvalidCredentialsError) return false;
    throw error;
  } finally {
    await person.unbind().catch(() => undefined);
  }
}

/**
 * Look a username up with the service account, then check the password by binding as that
 * person; their groups are read with the service account. Null for an unknown username, more
 * than one match, or a wrong password: the same answer for each.
 */
export async function authenticate(
  config: DirectoryConfig,
  username: string,
  password: string,
): Promise<DirectoryPerson | null> {
  // An empty password is an anonymous bind, which most directories accept: never try one.
  if (!password) return null;
  const service = client(config);
  try {
    if (config.bindDn) await service.bind(config.bindDn, config.bindPassword);
    const { searchEntries } = await service.search(config.userBase, {
      scope: "sub",
      filter: config.userFilter.replaceAll("{username}", escapeFilterValue(username)),
      attributes: [config.emailAttribute, config.nameAttribute],
      sizeLimit: 2,
    });
    if (searchEntries.length !== 1) return null;
    const [entry] = searchEntries;
    if (!entry) return null;
    const person = client(config);
    try {
      await person.bind(entry.dn, password);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) return null;
      throw error;
    } finally {
      await person.unbind().catch(() => undefined);
    }
    let groups: string[] = [];
    if (config.groupBase) {
      const found = await service.search(config.groupBase, {
        scope: "sub",
        filter: config.groupFilter.replaceAll("{dn}", escapeFilterValue(entry.dn)),
        attributes: ["cn"],
      });
      groups = found.searchEntries.map((g) => g.dn);
    }
    return {
      dn: entry.dn,
      email: first(entry[config.emailAttribute])?.toLowerCase() ?? null,
      name: first(entry[config.nameAttribute]),
      groups,
    };
  } finally {
    await service.unbind().catch(() => undefined);
  }
}

/** Connect and bind with the service account, and search the user base: the settings' Test. */
export async function testDirectory(config: DirectoryConfig): Promise<string | null> {
  const service = client(config);
  try {
    if (config.bindDn) await service.bind(config.bindDn, config.bindPassword);
    await service.search(config.userBase, { scope: "base", attributes: ["dn"] });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "The directory could not be reached.";
  } finally {
    await service.unbind().catch(() => undefined);
  }
}

/** A workspace's directory as its settings page shows it. */
export async function directoryOf(
  db: Database,
  organisationId: string,
): Promise<DirectorySettings> {
  const [row] = await db.select().from(directories).where(inOrg(directories, organisationId));
  if (!row) return defaultDirectorySettings;
  return {
    enabled: row.enabled,
    url: row.url,
    verifyCertificate: row.verifyCertificate,
    bindDn: row.bindDn,
    hasBindPassword: Boolean(row.bindPasswordSealed),
    userBase: row.userBase,
    userFilter: row.userFilter,
    emailAttribute: row.emailAttribute,
    nameAttribute: row.nameAttribute,
    groupBase: row.groupBase,
    groupFilter: row.groupFilter,
    roles: row.roles,
  };
}

/** What a sign-in or a test needs, with the bind password opened; null when there is none. */
export async function directoryConfig(
  db: Database,
  keyring: Keyring,
  organisationId: string,
): Promise<(DirectoryConfig & { enabled: boolean; roles: DirectorySettings["roles"] }) | null> {
  const [row] = await db.select().from(directories).where(inOrg(directories, organisationId));
  if (!row) return null;
  const bindPassword =
    row.bindPasswordSealed && row.bindPasswordKeyVersion !== null
      ? openSecret(
          await keyring.version(organisationId, row.bindPasswordKeyVersion),
          row.bindPasswordSealed,
          sealContext(organisationId),
        )
      : "";
  return { ...row, bindPassword };
}

/** Save a workspace's directory; a bind password given is sealed, one left out is kept. */
export async function saveDirectory(
  db: Database,
  keyring: Keyring,
  organisationId: string,
  input: DirectorySettingsInput,
) {
  const { bindPassword, ...rest } = input;
  let sealed: { bindPasswordSealed: string | null; bindPasswordKeyVersion: number | null } | null =
    null;
  if (bindPassword !== undefined) {
    if (bindPassword === "") sealed = { bindPasswordSealed: null, bindPasswordKeyVersion: null };
    else {
      const { version, key } = await keyring.current(organisationId);
      sealed = {
        bindPasswordSealed: sealSecret(key, bindPassword, sealContext(organisationId)),
        bindPasswordKeyVersion: version,
      };
    }
  }
  await db
    .insert(directories)
    .values({ organisationId, ...rest, ...(sealed ?? {}) })
    .onConflictDoUpdate({
      target: directories.organisationId,
      set: { ...rest, ...(sealed ?? {}), updatedAt: new Date() },
    });
}
