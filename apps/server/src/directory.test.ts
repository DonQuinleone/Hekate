import { describe, expect, it } from "vitest";
import { authenticate, type DirectoryConfig, testDirectory } from "./directory.ts";

/**
 * Against a real OpenLDAP with the fixtures in test/ldap (test/ldap/start.sh starts one; CI does
 * the same). Skipped when LDAP_TEST_URL is not set.
 */
const url = process.env.LDAP_TEST_URL;

export const testDirectoryConfig = (over: Partial<DirectoryConfig> = {}): DirectoryConfig => ({
  url: url ?? "",
  verifyCertificate: true,
  bindDn: "cn=hekate,ou=services,dc=example,dc=test",
  bindPassword: "bind-secret-for-tests",
  userBase: "ou=people,dc=example,dc=test",
  userFilter: "(uid={username})",
  emailAttribute: "mail",
  nameAttribute: "cn",
  groupBase: "ou=groups,dc=example,dc=test",
  groupFilter: "(member={dn})",
  ...over,
});

describe.runIf(url)("directory", () => {
  it("checks a password by binding as the person, and reads their groups", async () => {
    const mira = await authenticate(testDirectoryConfig(), "mira", "mira-directory-pass");
    expect(mira).toEqual({
      dn: "uid=mira,ou=people,dc=example,dc=test",
      email: "mira@example.test",
      name: "Mira Solberg",
      groups: [
        "cn=producers,ou=groups,dc=example,dc=test",
        "cn=reviewers,ou=groups,dc=example,dc=test",
      ],
    });
  });

  it("answers the same for a wrong password, an unknown name, an empty password and a wildcard", async () => {
    const config = testDirectoryConfig();
    expect(await authenticate(config, "mira", "wrong")).toBeNull();
    expect(await authenticate(config, "nobody", "mira-directory-pass")).toBeNull();
    expect(await authenticate(config, "mira", "")).toBeNull();
    expect(await authenticate(config, "*", "mira-directory-pass")).toBeNull();
  });

  it("says why a test fails", async () => {
    expect(await testDirectory(testDirectoryConfig())).toBeNull();
    expect(await testDirectory(testDirectoryConfig({ bindPassword: "wrong" }))).toMatch(/.+/);
  });
});
