/**
 * A workspace's Operations page (#165), for its owners: only what they act on (decision 288).
 * The release, the worker, the queues and the metrics are the instance's operators', and are
 * never sent to a workspace.
 */
export interface WorkspaceOperations {
  encryption: {
    /** The workspace key's version, and when it was made; null before the first file. */
    keyVersion: number | null;
    keySince: string | null;
    /** Keys and secrets still wrapped by an earlier version, re-wrapped in the background. */
    behind: number;
  };
}

/**
 * The workspace's encryption in words, for its owners (decision 288): no key versions, which
 * mean nothing to them, only whether it is encrypted, since when, and a change of key under way.
 */
export function encryptionWords(
  encryption: WorkspaceOperations["encryption"],
  day: (iso: string) => string,
): string {
  if (encryption.keyVersion === null)
    return "Nothing stored yet: its key is made with the first file";
  if (encryption.behind > 0) return `Encrypted, moving to a new key: ${encryption.behind} to go`;
  return encryption.keySince ? `Encrypted, on a key from ${day(encryption.keySince)}` : "Encrypted";
}
