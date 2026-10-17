import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INSTALLED,
  needsInstall,
  parseSettings,
  readSettingsFile,
  serialiseSettings,
  withSettings,
  writeSettingsFile,
} from "./settings-file.ts";

describe("the settings file", () => {
  it("reads back exactly what it wrote, whatever the values hold", () => {
    const values = {
      DATABASE_URL: "postgres://hekate:p@ss w#rd@db:5432/hekate",
      MAIL_FROM: 'Hekate "Studio" <hekate@example.com>',
      MASTER_KEY: "O9+fbdu9ZUNbNU3ypSRSFYIkknmlZ2g7iGfBaXKXB08=",
      PUBLIC_URL: "https://review.example.com",
    };
    expect(parseSettings(serialiseSettings(values))).toEqual(values);
  });

  it("skips comments, blank lines and names that are not settings", () => {
    expect(parseSettings("# note\n\nPORT=3000\nlower=x\n=y\nNOEQUALS\n")).toEqual({
      PORT: "3000",
    });
  });

  it("is written whole and readable by the server alone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hekate-settings-")), "config", "hekate.env");
    expect(readSettingsFile(path)).toBeNull();
    writeSettingsFile(path, { PORT: "3000" });
    writeSettingsFile(path, { PORT: "3001" });
    expect(readSettingsFile(path)).toEqual({ PORT: "3001" });
    // One descriptor for both looks, so what is checked is what is read.
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(readFileSync(fd, "utf8")).toMatch(/^# Written by the Hekate installer/);
    } finally {
      closeSync(fd);
    }
  });

  it("gives way to the environment, including a setting read from a file", () => {
    const merged = withSettings(
      { PUBLIC_URL: "https://env.example.com", MASTER_KEY_FILE: "/run/secrets/key" },
      { PUBLIC_URL: "https://file.example.com", MASTER_KEY: "x", MAIL_FROM: "h@example.com" },
    );
    expect(merged).toMatchObject({
      PUBLIC_URL: "https://env.example.com",
      MASTER_KEY_FILE: "/run/secrets/key",
      MAIL_FROM: "h@example.com",
    });
    expect(merged.MASTER_KEY).toBeUndefined();
  });
});

describe("whether the server installs", () => {
  const configured = { DATABASE_URL: "postgres://db/hekate", MASTER_KEY: "x" };

  it("does not when the environment configures it and there is no file", () => {
    expect(needsInstall(configured, null)).toBe(false);
  });

  it("does without a database or a master key", () => {
    expect(needsInstall({ DATABASE_URL: "postgres://db/hekate" }, null)).toBe(true);
    expect(needsInstall({ MASTER_KEY: "x" }, null)).toBe(true);
  });

  it("does until the installer marks its file finished", () => {
    expect(needsInstall(configured, { MAIL_FROM: "h@example.com" })).toBe(true);
    expect(needsInstall({}, { ...configured, [INSTALLED]: "true" })).toBe(false);
  });
});
