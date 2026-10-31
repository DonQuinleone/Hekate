import { randomUUID } from "node:crypto";
import type { StorageBackend } from "./types.ts";

/**
 * Testing a bucket someone gave (#508): a small object written and deleted again, and what
 * failed said in words. The words are built from the error's code and status alone, never its
 * message, so nothing the request carried (an access key, say) can be echoed back.
 */

export interface ProbeResult {
  ok: boolean;
  /** Where it failed: reaching the service at all, writing the probe, or deleting it. */
  step: "reach" | "write" | "delete" | null;
  message: string;
}

interface ErrorShape {
  name?: unknown;
  code?: unknown;
  cause?: unknown;
  $metadata?: { httpStatusCode?: number };
}

const codeOf = (error: unknown): string => {
  const e = (error ?? {}) as ErrorShape;
  if (typeof e.code === "string") return e.code;
  return e.cause && e.cause !== error ? codeOf(e.cause) : "";
};

/** What went wrong with a bucket, in words, and whether it was reaching the service at all. */
export function bucketProblem(error: unknown): { reach: boolean; words: string } {
  const e = (error ?? {}) as ErrorShape;
  const name = typeof e.name === "string" ? e.name : "";
  const code = codeOf(error);
  const status = e.$metadata?.httpStatusCode;
  const reach = (words: string) => ({ reach: true, words });
  const said = (words: string) => ({ reach: false, words });
  if (code === "EPRIVATE")
    return reach(
      "the endpoint is on a private network, which this instance does not reach for a workspace",
    );
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return reach("the endpoint's name could not be found");
  if (code === "ECONNREFUSED") return reach("nothing answered at the endpoint");
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || name === "TimeoutError")
    return reach("the endpoint did not answer in time");
  if (/CERT|SELF_SIGNED|ERR_TLS|UNABLE_TO_VERIFY/.test(code))
    return reach("the endpoint's certificate could not be verified");
  if (name === "NoSuchBucket") return said("the bucket does not exist");
  if (name === "InvalidAccessKeyId") return said("the service does not know the access key");
  if (name === "SignatureDoesNotMatch") return said("the secret does not match the access key");
  if (
    name === "PermanentRedirect" ||
    name === "AuthorizationHeaderMalformed" ||
    name === "IllegalLocationConstraintException" ||
    status === 301
  )
    return said("the bucket is in another region");
  if (name === "AccessDenied" || status === 403)
    return said("the access key may not do this in the bucket");
  if (status === 404) return said("the bucket does not exist");
  if (name && name !== "Error")
    return said(`the service answered ${name}${status ? ` (${status})` : ""}`);
  return reach(status ? `the service answered ${status}` : "the bucket could not be reached");
}

/** Write a small object and delete it again, saying which step failed and why. */
export async function probeBackend(backend: StorageBackend): Promise<ProbeResult> {
  const key = `hekate-probe/${randomUUID()}`;
  try {
    await backend.put(key, Buffer.from("A probe from Hekate, deleted at once."), {
      contentType: "text/plain",
    });
  } catch (error) {
    const problem = bucketProblem(error);
    return problem.reach
      ? { ok: false, step: "reach", message: `Could not reach the bucket: ${problem.words}.` }
      : { ok: false, step: "write", message: `Could not write to the bucket: ${problem.words}.` };
  }
  try {
    await backend.delete(key);
  } catch (error) {
    return {
      ok: false,
      step: "delete",
      message: `Wrote a probe object, but could not delete it: ${bucketProblem(error).words}. Hekate deletes what it no longer needs, so it must be allowed to.`,
    };
  }
  return { ok: true, step: null, message: "Wrote a probe object and deleted it again." };
}
