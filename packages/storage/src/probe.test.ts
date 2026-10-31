import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { localBackend } from "./local.ts";
import { bucketProblem, probeBackend } from "./probe.ts";
import type { StorageBackend } from "./types.ts";

const root = mkdtempSync(join(tmpdir(), "hekate-probe-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const s3Error = (name: string, status: number, message = "secret AKIAEXAMPLE in here") =>
  new S3ServiceException({
    name,
    $fault: "client",
    $metadata: { httpStatusCode: status },
    message,
  });

const network = (code: string) => Object.assign(new Error(`connect ${code} AKIAEXAMPLE`), { code });

describe("testing a workspace's bucket (#508)", () => {
  it("writes a probe object and deletes it again", async () => {
    const backend = localBackend({ name: "probe", root });
    expect(await probeBackend(backend)).toEqual({
      ok: true,
      step: null,
      message: "Wrote a probe object and deleted it again.",
    });
    expect(readdirSync(root).filter((f) => f !== ".tmp")).toEqual([]);
  });

  it("says which step failed", async () => {
    const backend = localBackend({ name: "probe", root });
    const refusing = (step: "put" | "delete", error: unknown): StorageBackend => ({
      ...backend,
      [step]: async () => {
        throw error;
      },
    });
    expect(await probeBackend(refusing("put", network("ENOTFOUND")))).toEqual({
      ok: false,
      step: "reach",
      message: "Could not reach the bucket: the endpoint's name could not be found.",
    });
    expect(await probeBackend(refusing("put", s3Error("AccessDenied", 403)))).toMatchObject({
      step: "write",
      message: "Could not write to the bucket: the access key may not do this in the bucket.",
    });
    expect(await probeBackend(refusing("delete", s3Error("AccessDenied", 403)))).toMatchObject({
      step: "delete",
      message: expect.stringMatching(/^Wrote a probe object, but could not delete it/),
    });
  });

  it("puts what went wrong in words, never echoing what the error said", () => {
    const cases: [unknown, string][] = [
      [network("EPRIVATE"), "the endpoint is on a private network"],
      [network("ECONNREFUSED"), "nothing answered at the endpoint"],
      [network("ETIMEDOUT"), "the endpoint did not answer in time"],
      [network("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), "the endpoint's certificate"],
      [Object.assign(new Error("wrapped"), { cause: network("ENOTFOUND") }), "could not be found"],
      [s3Error("NoSuchBucket", 404), "the bucket does not exist"],
      [s3Error("InvalidAccessKeyId", 403), "the service does not know the access key"],
      [s3Error("SignatureDoesNotMatch", 403), "the secret does not match the access key"],
      [s3Error("PermanentRedirect", 301), "the bucket is in another region"],
      [s3Error("SlowDown", 503), "the service answered SlowDown (503)"],
      [new Error("AKIAEXAMPLE"), "the bucket could not be reached"],
    ];
    for (const [error, words] of cases) {
      const said = bucketProblem(error).words;
      expect(said).toContain(words);
      expect(said).not.toContain("AKIAEXAMPLE");
    }
    expect(bucketProblem(network("ENOTFOUND")).reach).toBe(true);
    expect(bucketProblem(s3Error("AccessDenied", 403)).reach).toBe(false);
  });
});
