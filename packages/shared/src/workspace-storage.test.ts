import { describe, expect, it } from "vitest";
import { notOnPlanMessage } from "./plans.ts";
import {
  bucketBackendName,
  bucketIdOf,
  bucketLine,
  samePlace,
  workspaceBucketInput,
} from "./workspace-storage.ts";

const id = "01a15000-0000-7000-8000-0000000000b1";
const details = {
  endpoint: " https://fsn1.your-objectstorage.com/ ",
  region: "eu-central",
  bucket: "endless-hall-masters",
  prefix: "hekate/",
  pathStyle: true,
};

describe("a workspace's own bucket (#508)", () => {
  it("is named so that no instance backend can be mistaken for it", () => {
    expect(bucketBackendName(id)).toBe(`bucket:${id}`);
    expect(bucketIdOf(bucketBackendName(id))).toBe(id);
    expect(bucketIdOf("local")).toBeNull();
    expect(bucketIdOf("bucket:local")).toBeNull();
  });

  it("takes an endpoint, or none for Amazon S3, and a prefix without its slash", () => {
    expect(workspaceBucketInput.parse(details)).toEqual({
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "eu-central",
      bucket: "endless-hall-masters",
      prefix: "hekate",
      pathStyle: true,
    });
    expect(workspaceBucketInput.parse({ ...details, endpoint: "", prefix: "" })).toMatchObject({
      endpoint: null,
      prefix: "",
    });
    for (const wrong of [
      { endpoint: "ftp://files.example" },
      { endpoint: "https://s3.example?x=1" },
      { bucket: "" },
      { bucket: "a bucket" },
      { region: "" },
      { prefix: "../escape" },
      { prefix: "/rooted" },
      { prefix: "two//slashes" },
    ])
      expect(workspaceBucketInput.safeParse({ ...details, ...wrong }).success).toBe(false);
  });

  it("is the same place only at the same endpoint, bucket and prefix", () => {
    const place = workspaceBucketInput.parse(details);
    expect(samePlace(place, { ...place, endpoint: "https://FSN1.your-objectstorage.com" })).toBe(
      true,
    );
    expect(samePlace(place, { ...place, bucket: "endless-hall-archive" })).toBe(false);
    expect(samePlace(place, { ...place, prefix: "" })).toBe(false);
    expect(samePlace(place, { ...place, endpoint: null })).toBe(false);
  });

  it("reads as a line, and its refusal names the plan", () => {
    const place = workspaceBucketInput.parse(details);
    expect(bucketLine(place)).toBe("endless-hall-masters/hekate at fsn1.your-objectstorage.com");
    expect(bucketLine({ ...place, endpoint: null, prefix: "" })).toBe(
      "endless-hall-masters at Amazon S3",
    );
    expect(notOnPlanMessage("ownStorage", "Studio")).toBe(
      "Your own storage is not on the Studio plan.",
    );
    expect(notOnPlanMessage("ownStorage", null)).toBe(
      "Your own storage is not on this workspace's plan.",
    );
  });
});
