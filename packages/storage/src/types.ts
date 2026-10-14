import type { Readable } from "node:stream";

/** A byte range with an inclusive end, as in HTTP `Range: bytes=start-end`. */
export interface ByteRange {
  start: number;
  /** Inclusive. Omit to read to the end; values past the end are clamped. */
  end?: number;
}

export interface ObjectInfo {
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
}

export type Body = Readable | Uint8Array;

/**
 * One configured place to keep objects. Implementations must pass the shared
 * conformance suite in `conformance.ts`.
 *
 * Backends never hand out URLs: every byte leaves Hekate through the server,
 * so delivery stays session-bound and logged (docs/security.md).
 */
export interface StorageBackend {
  /** The configured name, for example `local` or `archive`. */
  readonly name: string;
  readonly driver: "local" | "s3";
  /** Store an object, replacing any object with the same key. Resolves once it is durable. */
  put(key: string, body: Body, options?: { contentType?: string }): Promise<ObjectInfo>;
  /** Read an object or a byte range of it. Rejects with `ObjectNotFoundError` or `RangeNotSatisfiableError`. */
  get(key: string, range?: ByteRange): Promise<Readable>;
  /** Object metadata, or `null` when there is no such object. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Remove an object. Removing a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Every object whose key starts with `prefix`, in key order. */
  list(prefix: string): AsyncIterable<ListedObject>;
  /** Prove the backend is reachable and writable. Used at start-up. */
  check(): Promise<void>;

  /**
   * Multipart writes, for resumable uploads: parts arrive separately, in any order,
   * may be re-sent, and become one object on completion. Every part but the last
   * must be at least `MIN_PART_SIZE` bytes (an S3 rule all backends follow).
   */
  createMultipart(key: string, options?: { contentType?: string }): Promise<string>;
  /** Store part `partNumber` (1 to 10,000), replacing any earlier copy. Returns its tag. */
  putPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string>;
  /** Join the listed parts, in order, into the object at `key`. */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: { partNumber: number; tag: string }[],
  ): Promise<ObjectInfo>;
  /** Discard an unfinished upload and its parts. Aborting twice succeeds. */
  abortMultipart(key: string, uploadId: string): Promise<void>;
}

/** Smallest part allowed, except the last (S3's limit). */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Largest part number (S3's limit). */
export const MAX_PARTS = 10_000;
