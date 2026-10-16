import { describe, expect, it } from "vitest";
import { defaultSsoSettings, ssoSettingsInput } from "./sso.ts";

const { hasClientSecret: _, ...base } = defaultSsoSettings;

describe("single sign-on settings", () => {
  it("can be saved switched off and half filled in", () => {
    expect(ssoSettingsInput.safeParse(base).success).toBe(true);
  });

  it("needs what each protocol needs, once switched on", () => {
    const oidc = ssoSettingsInput.safeParse({ ...base, enabled: true });
    expect(oidc.success).toBe(false);
    expect(
      ssoSettingsInput.safeParse({
        ...base,
        enabled: true,
        issuer: "https://login.example/realms/hekate",
        clientId: "hekate",
      }).success,
    ).toBe(true);
    expect(ssoSettingsInput.safeParse({ ...base, enabled: true, protocol: "saml" }).success).toBe(
      false,
    );
    expect(
      ssoSettingsInput.safeParse({
        ...base,
        enabled: true,
        protocol: "saml",
        entryPoint: "https://login.example/saml",
        idpEntityId: "https://login.example",
        certificate: "MIIC",
      }).success,
    ).toBe(true);
  });

  it("takes only web addresses, and nothing it does not know", () => {
    expect(ssoSettingsInput.safeParse({ ...base, issuer: "javascript:alert(1)" }).success).toBe(
      false,
    );
    expect(ssoSettingsInput.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});
