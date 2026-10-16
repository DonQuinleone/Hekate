import { describe, expect, it } from "vitest";
import { directorySettingsInput, escapeFilterValue, roleForGroups } from "./directory.ts";

describe("directory", () => {
  it("escapes what means something in a filter", () => {
    expect(escapeFilterValue("mira")).toBe("mira");
    expect(escapeFilterValue("*)(uid=*")).toBe("\\2a\\29\\28uid=\\2a");
    expect(escapeFilterValue("a\\b")).toBe("a\\5cb");
  });

  it("gives admin to a matching admin group, by name or DN, else member", () => {
    const rules = [{ group: "Producers", role: "admin" as const }];
    expect(roleForGroups(["cn=producers,ou=groups,dc=example,dc=test"], rules)).toBe("admin");
    expect(
      roleForGroups(["cn=x,dc=test"], [{ group: "cn=X,dc=test", role: "admin" as const }]),
    ).toBe("admin");
    expect(roleForGroups(["cn=reviewers,ou=groups,dc=example,dc=test"], rules)).toBe("member");
    expect(roleForGroups([], [])).toBe("member");
  });

  it("asks for an LDAP address and filters that hold their placeholders", () => {
    const base = {
      enabled: true,
      url: "ldaps://directory.example:636",
      verifyCertificate: true,
      bindDn: "",
      userBase: "ou=people,dc=example",
      userFilter: "(uid={username})",
      emailAttribute: "mail",
      nameAttribute: "cn",
      groupBase: "",
      groupFilter: "(member={dn})",
      roles: [],
    };
    expect(directorySettingsInput.safeParse(base).success).toBe(true);
    expect(directorySettingsInput.safeParse({ ...base, url: "https://x" }).success).toBe(false);
    expect(directorySettingsInput.safeParse({ ...base, userFilter: "(uid=mira)" }).success).toBe(
      false,
    );
    expect(
      directorySettingsInput.safeParse({ ...base, roles: [{ group: "x", role: "owner" }] }).success,
    ).toBe(false);
  });
});
