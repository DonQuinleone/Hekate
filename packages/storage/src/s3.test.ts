import { describe } from "vitest";
import { storageConformance } from "./conformance.ts";
import { s3Backend } from "./s3.ts";

// Runs against a real S3-compatible server when one is configured; CI starts one.
const endpoint = process.env.S3_TEST_ENDPOINT;

describe.runIf(endpoint)("s3", () => {
  const options = {
    name: "s3",
    bucket: process.env.S3_TEST_BUCKET ?? "hekate-test",
    endpoint: endpoint ?? "",
    region: process.env.S3_TEST_REGION ?? "us-east-1",
    forcePathStyle: true,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
  };
  storageConformance("s3", () => s3Backend(options));
  storageConformance("s3 with a key prefix", () => s3Backend({ ...options, prefix: "hekate" }));
});
