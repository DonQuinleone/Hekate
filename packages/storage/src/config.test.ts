import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBackends, storageConfigFromEnv } from "./config.ts";

describe("storage configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to one local backend", () => {
    expect(storageConfigFromEnv({})).toEqual({
      backends: [{ driver: "local", name: "local", root: "data/storage" }],
      defaultBackend: "local",
    });
  });

  it("reads several named backends", () => {
    const config = storageConfigFromEnv({
      STORAGE_BACKENDS: "local, archive",
      STORAGE_DEFAULT: "archive",
      STORAGE_LOCAL_PATH: "/data/storage",
      STORAGE_ARCHIVE_DRIVER: "s3",
      STORAGE_ARCHIVE_BUCKET: "masters",
      STORAGE_ARCHIVE_ENDPOINT: "https://s3.example.test",
      STORAGE_ARCHIVE_REGION: "eu-west-2",
      STORAGE_ARCHIVE_FORCE_PATH_STYLE: "true",
      STORAGE_ARCHIVE_PREFIX: "hekate",
      STORAGE_ARCHIVE_ACCESS_KEY_ID: "id",
      STORAGE_ARCHIVE_SECRET_ACCESS_KEY: "secret",
    });
    expect(config).toEqual({
      defaultBackend: "archive",
      backends: [
        { driver: "local", name: "local", root: "/data/storage" },
        {
          driver: "s3",
          name: "archive",
          bucket: "masters",
          endpoint: "https://s3.example.test",
          region: "eu-west-2",
          forcePathStyle: true,
          prefix: "hekate",
          accessKeyId: "id",
          secretAccessKey: "secret",
        },
      ],
    });
  });

  it("maps hyphenated names to underscores and reads secrets from files", () => {
    const secret = join(dir, "secret");
    writeFileSync(secret, "from-a-file\n");
    const config = storageConfigFromEnv({
      STORAGE_BACKENDS: "cold-store",
      STORAGE_COLD_STORE_DRIVER: "s3",
      STORAGE_COLD_STORE_BUCKET: "cold",
      STORAGE_COLD_STORE_ACCESS_KEY_ID: "id",
      STORAGE_COLD_STORE_SECRET_ACCESS_KEY_FILE: secret,
    });
    expect(config.backends[0]).toMatchObject({
      name: "cold-store",
      secretAccessKey: "from-a-file",
    });
  });

  it("uses the AWS credential chain when no keys are given", () => {
    const config = storageConfigFromEnv({ STORAGE_BACKENDS: "s3", STORAGE_S3_BUCKET: "media" });
    expect(config.backends[0]).toEqual({
      driver: "s3",
      name: "s3",
      bucket: "media",
      forcePathStyle: false,
    });
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      storageConfigFromEnv({
        STORAGE_BACKENDS: "Bad Name,archive,disk,half,half",
        STORAGE_DEFAULT: "elsewhere",
        STORAGE_ARCHIVE_DRIVER: "s3",
        STORAGE_ARCHIVE_ENDPOINT: "not a url",
        STORAGE_DISK_DRIVER: "local",
        STORAGE_HALF_DRIVER: "s3",
        STORAGE_HALF_BUCKET: "b",
        STORAGE_HALF_ACCESS_KEY_ID: "only-id",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const expected of [
      "names must be unique",
      '"Bad Name" must be lower case',
      "STORAGE_ARCHIVE_BUCKET: required",
      "STORAGE_ARCHIVE_ENDPOINT: must be a URL",
      "STORAGE_DISK_PATH: required",
      "set both or neither",
      'STORAGE_DEFAULT: "elsewhere" is not listed',
    ]) {
      expect(message).toContain(expected);
    }
  });

  it("refuses an unknown driver", () => {
    expect(() => storageConfigFromEnv({ STORAGE_BACKENDS: "tape" })).toThrow(
      'STORAGE_TAPE_DRIVER: must be "local" or "s3"',
    );
  });

  it("builds the configured backends and checks them all", async () => {
    const backends = createBackends(
      storageConfigFromEnv({
        STORAGE_BACKENDS: "local,spare",
        STORAGE_LOCAL_PATH: join(dir, "a"),
        STORAGE_SPARE_DRIVER: "local",
        STORAGE_SPARE_PATH: join(dir, "b"),
      }),
    );
    expect(backends.names()).toEqual(["local", "spare"]);
    expect(backends.defaultBackend).toBe("local");
    expect(backends.get("spare").driver).toBe("local");
    expect(() => backends.get("missing")).toThrow(/not configured/);
    await expect(backends.checkAll()).resolves.toBeUndefined();
  });
});
