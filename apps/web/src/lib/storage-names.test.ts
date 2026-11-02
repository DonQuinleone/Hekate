import { bucketBackendName } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { storageName } from "./storage-names";

describe("storageName", () => {
  it("names the instance's one storage without its id", () => {
    expect(storageName("local", ["local"])).toBe("Instance storage");
  });

  it("tells the instance's storages apart by name where it has several", () => {
    expect(storageName("archive", ["local", "archive"])).toBe("Instance storage, Archive");
  });

  it("calls the workspace's own bucket its S3 bucket", () => {
    const bucket = bucketBackendName("0199f0a0-0000-7000-8000-000000000001");
    expect(storageName(bucket, ["local"])).toBe("Your S3 bucket");
    expect(storageName("local", ["local", bucket])).toBe("Instance storage");
  });
});
