import { describe, expect, it } from "vitest";
import { requestOf, signInMethodOf } from "./auth-log.ts";

describe("the authentication log (#157)", () => {
  it("knows how a sign-in was made from its path, and that other paths sign no one in", () => {
    expect(signInMethodOf("/sign-in/email")).toBe("password");
    expect(signInMethodOf("/passkey/verify-authentication")).toBe("passkey");
    expect(signInMethodOf("/two-factor/verify-totp")).toBe("second_factor");
    expect(signInMethodOf("/two-factor/verify-backup-code")).toBe("second_factor");
    expect(signInMethodOf("/sign-in/directory")).toBe("directory");
    expect(signInMethodOf("/sso/callback/endless-hall")).toBe("sso");
    expect(signInMethodOf("/update-session")).toBeNull();
    expect(signInMethodOf("/change-password")).toBeNull();
  });

  it("reads the address only behind the proxy, and the browser always", () => {
    const request = new Request("http://localhost/", {
      headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.8", "user-agent": "Firefox" },
    });
    expect(requestOf(request, true)).toEqual({ ipAddress: "203.0.113.8", userAgent: "Firefox" });
    expect(requestOf(request, false)).toEqual({ ipAddress: null, userAgent: "Firefox" });
    const claimed = new Request("http://localhost/", { headers: { "x-forwarded-for": "nope" } });
    expect(requestOf(claimed, true)).toEqual({ ipAddress: null, userAgent: null });
    expect(requestOf(undefined, true)).toEqual({ ipAddress: null, userAgent: null });
  });
});
