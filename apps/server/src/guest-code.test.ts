import { describe, expect, it } from "vitest";
import {
  checkGuestCode,
  GUEST_CODE_MS,
  GUEST_CODE_TRIES,
  GUEST_CODES_PER_LINK,
  hashGuestCode,
  maskEmail,
  mayResend,
  newGuestCode,
} from "./guest-code.ts";

const now = new Date("2026-10-16T10:00:00Z");
const link = (code: string, over: Partial<{ codeAttempts: number; codeExpiresAt: Date }> = {}) => ({
  id: "link-1",
  codeHash: hashGuestCode("link-1", code),
  codeExpiresAt: new Date(now.getTime() + GUEST_CODE_MS),
  codeAttempts: 0,
  ...over,
});

describe("guest codes", () => {
  it("makes six digits", () => {
    for (let i = 0; i < 20; i++) expect(newGuestCode()).toMatch(/^\d{6}$/);
  });

  it("takes the code sent, however it is spaced, and nothing else", () => {
    expect(checkGuestCode(link("042137"), "042 137", now)).toBe("ok");
    expect(checkGuestCode(link("042137"), "042138", now)).toBe("wrong");
    // A code is bound to its link: the same digits for another link are wrong.
    expect(checkGuestCode({ ...link("042137"), id: "link-2" }, "042137", now)).toBe("wrong");
  });

  it("refuses a code past its ten minutes, or tried too often", () => {
    expect(checkGuestCode(link("042137", { codeExpiresAt: now }), "042137", now)).toBe("expired");
    expect(checkGuestCode(link("042137", { codeAttempts: GUEST_CODE_TRIES }), "042137", now)).toBe(
      "too_many",
    );
    expect(checkGuestCode({ ...link("1"), codeHash: null }, "042137", now)).toBe("none");
  });

  it("sends another after half a minute, up to five for a link", () => {
    expect(mayResend({ codeSentAt: null, codesSent: 0 }, now)).toBe("send");
    expect(mayResend({ codeSentAt: new Date(now.getTime() - 10_000), codesSent: 1 }, now)).toBe(
      "wait",
    );
    expect(mayResend({ codeSentAt: new Date(now.getTime() - 31_000), codesSent: 1 }, now)).toBe(
      "send",
    );
    expect(mayResend({ codeSentAt: null, codesSent: GUEST_CODES_PER_LINK }, now)).toBe("limit");
  });

  it("hints at the address without spelling it out", () => {
    expect(maskEmail("conductor@example.test")).toBe("c•••@example.test");
  });
});
