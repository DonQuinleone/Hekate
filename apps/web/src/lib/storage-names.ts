import { bucketIdOf, capital } from "@hekate/shared";

/**
 * A storage backend as people read it (#586), never its configured id: the workspace's own
 * bucket is "Your S3 bucket", and the instance's storage is "Instance storage", followed by its
 * name only where the instance keeps more than one.
 */
export function storageName(backend: string, instanceBackends: readonly string[]): string {
  if (bucketIdOf(backend)) return "Your S3 bucket";
  const own = instanceBackends.filter((b) => !bucketIdOf(b));
  return own.length > 1 ? `Instance storage, ${capital(backend)}` : "Instance storage";
}
