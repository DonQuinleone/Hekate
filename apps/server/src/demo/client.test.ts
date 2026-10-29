import { describe, expect, it } from "vitest";
import { cookieHeader, remember } from "./client.ts";

describe("the demo's cookie jar", () => {
  it("keeps what set-cookie gives, forgets what it takes back, and sends the rest", () => {
    const jar = new Map<string, string>();
    remember(jar, "hekate.session_token=abc.def; Path=/; HttpOnly; SameSite=Lax");
    remember(jar, "hekate.guest=g1; Path=/; Max-Age=3600");
    expect(cookieHeader(jar)).toBe("hekate.session_token=abc.def; hekate.guest=g1");
    remember(jar, "hekate.session_token=xyz; Path=/");
    remember(jar, "hekate.guest=; Max-Age=0; Path=/");
    remember(jar, "old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    remember(jar, "nonsense");
    expect(cookieHeader(jar)).toBe("hekate.session_token=xyz");
  });
});
