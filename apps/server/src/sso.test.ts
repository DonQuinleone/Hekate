import { describe, expect, it } from "vitest";
import {
  bareCertificate,
  fetchJson,
  groupsOf,
  mayFetch,
  privateAddress,
  providerIdFor,
  publicLookup,
  serviceProvider,
} from "./sso.ts";

describe("single sign-on", () => {
  it("never lets an admin point the server inside its own network", async () => {
    for (const url of [
      "http://localhost:8080/realms/x",
      "http://127.0.0.1/x",
      "http://10.1.2.3/x",
      "http://172.20.0.1/x",
      "http://192.168.1.1/x",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/x",
      "http://[fd00::1]/x",
      "http://metadata.google.internal/x",
      "file:///etc/passwd",
    ])
      expect(await mayFetch(url, [])).toBe(false);
    // Public addresses are fine, and the operator can allow a private one.
    expect(await mayFetch("https://1.1.1.1/x", [])).toBe(true);
    expect(await mayFetch("http://localhost:8080/realms/x", ["http://localhost:8080"])).toBe(true);
  });

  it("knows every range that is not the public internet, IPv6 included", async () => {
    for (const address of [
      "fe80::1",
      "fe90::1",
      "feb0::1",
      "fec0::1",
      "fc00::1",
      "ff02::1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001:db8::1",
      "198.18.0.1",
      "100.64.0.1",
      "240.0.0.1",
      "not an address",
    ])
      expect(privateAddress(address), address).toBe(true);
    for (const address of ["2606:4700:4700::1111", "1.1.1.1", "8.8.8.8"])
      expect(privateAddress(address), address).toBe(false);
    expect(await mayFetch("http://[fe90::1]/x", [])).toBe(false);
  });

  it("checks the address it connects to, not only the one it looked up first", async () => {
    // The lookup the connection uses refuses a private answer itself (DNS rebinding).
    const answer = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) =>
      publicLookup("localhost", {}, (error) => resolve({ error })),
    );
    expect(answer.error?.code).toBe("EPRIVATE");
    await expect(fetchJson("http://localhost:9/.well-known/x", [])).rejects.toMatchObject({
      code: "EPRIVATE",
    });
  });

  it("tells the identity provider where to send people back", () => {
    const sp = serviceProvider("https://hekate.example/", "0190-org");
    expect(providerIdFor("0190-org")).toBe("workspace-0190-org");
    expect(sp).toEqual({
      redirectUri: "https://hekate.example/api/auth/sso/callback/workspace-0190-org",
      entityId:
        "https://hekate.example/api/auth/sso/saml2/sp/metadata?providerId=workspace-0190-org",
      acsUrl: "https://hekate.example/api/auth/sso/saml2/sp/acs/workspace-0190-org",
    });
  });

  it("reads groups however they come, and certificates with or without their PEM lines", () => {
    expect(groupsOf("producers")).toEqual(["producers"]);
    expect(groupsOf(["producers", 3, "engineers"])).toEqual(["producers", "engineers"]);
    expect(groupsOf(undefined)).toEqual([]);
    expect(
      bareCertificate("-----BEGIN CERTIFICATE-----\nMIIC\nabc=\n-----END CERTIFICATE-----"),
    ).toBe("MIICabc=");
  });
});
