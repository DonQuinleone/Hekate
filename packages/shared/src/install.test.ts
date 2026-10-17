import { describe, expect, it } from "vitest";
import {
  addressStepInput,
  describeSmtp,
  fromAddress,
  isMasterKey,
  mailStepInput,
  masterKeyStepInput,
  normaliseSetupCode,
  redactUrl,
  setupCodeInput,
  smtpUrlOf,
  storageStepInput,
} from "./install.ts";

/** `n` random bytes in base64, as `openssl rand -base64 n` prints them. */
const randomKey = (n: number) => {
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = Array.from({ length: n }, () => Math.floor(Math.random() * 256));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a = 0, b = 0, c = 0] = bytes.slice(i, i + 3);
    const word = (a << 16) | (b << 8) | c;
    const left = bytes.length - i;
    out += digits[word >> 18] ?? "";
    out += digits[(word >> 12) & 63] ?? "";
    out += left > 1 ? (digits[(word >> 6) & 63] ?? "") : "=";
    out += left > 2 ? (digits[word & 63] ?? "") : "=";
  }
  return out;
};

describe("the setup code", () => {
  it("is read however it was typed", () => {
    expect(setupCodeInput.parse({ code: " 7kq2m9xd4hpw " }).code).toBe("7KQ2M9XD4HPW");
    expect(normaliseSetupCode("7kq2m9xd4hpw")).toBe("7KQ2-M9XD-4HPW");
    expect(normaliseSetupCode("7KQ2-M9XD-4HPW")).toBe("7KQ2-M9XD-4HPW");
    expect(setupCodeInput.safeParse({ code: "7KQ2-M9XD" }).success).toBe(false);
  });
});

describe("the master key", () => {
  it("is 32 random bytes in base64, nothing longer or shorter", () => {
    for (let i = 0; i < 50; i++) expect(isMasterKey(randomKey(32))).toBe(true);
    expect(isMasterKey(randomKey(31))).toBe(false);
    expect(isMasterKey(randomKey(33))).toBe(false);
    expect(isMasterKey("not a key")).toBe(false);
  });

  it("is saved only once it is said to be stored", () => {
    const key = randomKey(32);
    expect(masterKeyStepInput.safeParse({ key, stored: false }).success).toBe(false);
    expect(masterKeyStepInput.parse({ key, stored: true }).key).toBe(key);
  });
});

describe("mail", () => {
  it("comes to an SMTP URL, with the provider's host and user filled in", () => {
    expect(
      smtpUrlOf({ provider: "resend", password: "re_123/x", from: "Hekate <h@example.com>" }),
    ).toBe("smtps://resend:re_123%2Fx@smtp.resend.com:465");
    expect(
      smtpUrlOf({
        provider: "smtp",
        host: "mail.example.com",
        port: 587,
        username: "hekate@example.com",
        password: "p@ss word",
        from: "h@example.com",
      }),
    ).toBe("smtp://hekate%40example.com:p%40ss%20word@mail.example.com:587");
    expect(smtpUrlOf({ provider: "smtp", host: "relay", from: "h@example.com" })).toBe(
      "smtp://relay:587",
    );
    expect(smtpUrlOf({ provider: "log", from: "h@example.com" })).toBeUndefined();
  });

  it("is read back without its password", () => {
    expect(describeSmtp("smtps://resend:secret@smtp.resend.com:465")).toEqual({
      provider: "resend",
      host: "smtp.resend.com",
      port: 465,
      username: "resend",
    });
    expect(describeSmtp("smtp://mail.example.com")).toEqual({
      provider: "smtp",
      host: "mail.example.com",
      port: 587,
      username: null,
    });
    expect(describeSmtp("https://example.com")).toBeNull();
  });

  it("needs a host and a real sender, except when it only logs", () => {
    expect(mailStepInput.safeParse({ provider: "smtp", from: "h@example.com" }).success).toBe(
      false,
    );
    expect(
      mailStepInput.safeParse({ provider: "sendgrid", password: "x", from: "Hekate" }).success,
    ).toBe(false);
    expect(mailStepInput.safeParse({ provider: "log", from: "Hekate" }).success).toBe(true);
    expect(fromAddress("Hekate <hekate@example.com>")).toBe("hekate@example.com");
    expect(fromAddress("hekate@example.com")).toBe("hekate@example.com");
    expect(fromAddress("Hekate")).toBeNull();
  });
});

describe("storage and the address", () => {
  it("takes an absolute local path or a whole S3 bucket", () => {
    expect(storageStepInput.safeParse({ kind: "local", path: "data/storage" }).success).toBe(false);
    expect(storageStepInput.safeParse({ kind: "local", path: "/data/storage" }).success).toBe(true);
    expect(
      storageStepInput.safeParse({
        kind: "s3",
        bucket: "Endless Hall",
        region: "eu-west-2",
        forcePathStyle: false,
      }).success,
    ).toBe(false);
  });

  it("keeps only the origin of the public address", () => {
    expect(addressStepInput.parse({ publicUrl: "https://review.example.com/" }).publicUrl).toBe(
      "https://review.example.com",
    );
    expect(
      addressStepInput.safeParse({ publicUrl: "https://review.example.com/hekate" }).success,
    ).toBe(false);
    expect(addressStepInput.safeParse({ publicUrl: "ftp://review.example.com" }).success).toBe(
      false,
    );
  });

  it("hides a connection URL's password", () => {
    expect(redactUrl("postgres://hekate:secret@db:5432/hekate")).toBe(
      "postgres://hekate:••••@db:5432/hekate",
    );
  });
});
