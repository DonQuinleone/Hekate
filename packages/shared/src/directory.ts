import { z } from "zod";
import type { OrganisationRole } from "./organisation.ts";

/**
 * A workspace's directory (LDAP, including Active Directory): members sign in with their
 * directory username and password, become members on first sign-in, and take a role from their
 * groups (docs/security.md, Authentication).
 */

/** The roles a directory group can give; owners are made by people, never by a directory. */
export const directoryRoles = ["admin", "member"] as const;

/** A group (its common name or full DN) and the role it gives. */
export const directoryRoleRule = z.object({
  group: z.string().trim().min(1).max(300),
  role: z.enum(directoryRoles),
});
export type DirectoryRoleRule = z.infer<typeof directoryRoleRule>;

const dn = z.string().trim().max(300);

export const directorySettingsInput = z
  .object({
    enabled: z.boolean(),
    /** ldap:// or ldaps://, with a port when not the usual one. */
    url: z
      .string()
      .trim()
      .max(300)
      .regex(/^ldaps?:\/\/[^\s/]+\/?$/, "An ldap:// or ldaps:// address"),
    verifyCertificate: z.boolean(),
    /** The service account that searches; empty searches anonymously. */
    bindDn: dn,
    /** Left out to keep the one stored; never sent back. */
    bindPassword: z.string().max(300).optional(),
    userBase: dn.min(1),
    /** Must hold {username}, which is escaped before it is put in. */
    userFilter: z
      .string()
      .trim()
      .max(300)
      .refine((f) => f.includes("{username}"), "The filter must hold {username}"),
    emailAttribute: z.string().trim().min(1).max(60),
    nameAttribute: z.string().trim().min(1).max(60),
    /** Where groups are; empty reads no groups, and everyone is a member. */
    groupBase: dn,
    /** Must hold {dn}, the person's own DN. */
    groupFilter: z
      .string()
      .trim()
      .max(300)
      .refine((f) => f.includes("{dn}"), "The filter must hold {dn}"),
    roles: z.array(directoryRoleRule).max(50),
  })
  .strict();
export type DirectorySettingsInput = z.infer<typeof directorySettingsInput>;

/** A directory as the settings page shows it: everything but the bind password. */
export type DirectorySettings = Omit<DirectorySettingsInput, "bindPassword"> & {
  hasBindPassword: boolean;
};

export const defaultDirectorySettings: DirectorySettings = {
  enabled: false,
  url: "ldaps://directory.example:636",
  verifyCertificate: true,
  bindDn: "",
  hasBindPassword: false,
  userBase: "ou=people,dc=example",
  userFilter: "(uid={username})",
  emailAttribute: "mail",
  nameAttribute: "cn",
  groupBase: "",
  groupFilter: "(member={dn})",
  roles: [],
};

/** Signing in with a directory: which workspace, and the person's directory username. */
export const directorySignInInput = z.object({
  workspace: z.string().trim().min(1).max(100),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(256),
});

/** The common name in a DN: "cn=producers,ou=groups,dc=example" is "producers". */
const commonName = (group: string) => /^cn=([^,]+)/i.exec(group)?.[1] ?? group;

/**
 * The role a person's groups give: an admin rule that matches wins, otherwise member. A rule
 * names a group by its common name or by its whole DN, in any case.
 */
export function roleForGroups(groups: string[], rules: DirectoryRoleRule[]): OrganisationRole {
  const held = new Set(groups.flatMap((g) => [g.toLowerCase(), commonName(g).toLowerCase()]));
  return rules.some((rule) => rule.role === "admin" && held.has(rule.group.toLowerCase()))
    ? "admin"
    : "member";
}

/**
 * A value made safe for an LDAP filter (RFC 4515): the characters that mean something there
 * are written as escapes, so a username cannot widen the search.
 */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
