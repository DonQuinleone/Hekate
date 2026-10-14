import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import {
  ObjectNotFoundError,
  RangeNotSatisfiableError,
  StorageConfigError,
  StorageError,
} from "./errors.ts";
import { assertValidKey, assertValidPrefix, assertValidRange } from "./keys.ts";
import {
  type Body,
  type ByteRange,
  type ListedObject,
  MAX_PARTS,
  type ObjectInfo,
  type StorageBackend,
} from "./types.ts";

export interface S3BackendOptions {
  name: string;
  bucket: string;
  /** Defaults to `us-east-1`, which most S3-compatible services accept. */
  region?: string;
  /** For S3-compatible services (MinIO, Garage, R2, B2, Wasabi and so on). Omit for AWS. */
  endpoint?: string;
  /** Address buckets as `endpoint/bucket` rather than `bucket.endpoint`. Most self-hosted services need this. */
  forcePathStyle?: boolean;
  /** Static credentials. Omit to use the AWS default chain (environment, instance or task role). */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Keep Hekate's objects under this prefix in a shared bucket, for example `hekate/`. */
  prefix?: string;
}

/** Multipart part size. S3 allows at most 10,000 parts, so this supports objects up to about 156 GiB. */
const PART_SIZE = 16 * 1024 * 1024;

const status = (error: unknown) =>
  error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;

const isNotFound = (error: unknown) =>
  status(error) === 404 ||
  (error instanceof S3ServiceException &&
    (error.name === "NoSuchKey" || error.name === "NotFound"));

/** Any S3-compatible object store. */
export function s3Backend(options: S3BackendOptions): StorageBackend {
  if (!options.bucket)
    throw new StorageConfigError(`Storage backend "${options.name}" needs a bucket`);
  const prefix = options.prefix ?? "";
  if (prefix) assertValidPrefix(prefix.endsWith("/") ? prefix : `${prefix}/`);
  const base = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  const bucket = options.bucket;

  const client = new S3Client({
    region: options.region ?? "us-east-1",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? false,
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
  });

  const fullKey = (key: string) => {
    assertValidKey(key);
    return base + key;
  };

  return {
    name: options.name,
    driver: "s3",

    async put(key, body: Body, putOptions) {
      const Key = fullKey(key);
      let size = 0;
      const count = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        },
      });
      const source = body instanceof Uint8Array ? Readable.from([body]) : body;
      source.on("error", (error) => count.destroy(error));
      source.pipe(count);
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key,
          Body: count,
          ...(putOptions?.contentType ? { ContentType: putOptions.contentType } : {}),
        },
        partSize: PART_SIZE,
        queueSize: 4,
        leavePartsOnError: false,
      });
      await upload.done();
      return { size };
    },

    async get(key, range?: ByteRange) {
      const Key = fullKey(key);
      if (range) assertValidRange(range);
      try {
        const result = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key,
            ...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
          }),
        );
        if (!(result.Body instanceof Readable)) {
          throw new Error("S3 returned a body that is not a Node stream");
        }
        return result.Body;
      } catch (error) {
        if (isNotFound(error)) throw new ObjectNotFoundError(key);
        if (status(error) === 416) {
          throw new RangeNotSatisfiableError(`Range starts past the end of "${key}"`);
        }
        throw error;
      }
    },

    async head(key): Promise<ObjectInfo | null> {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: fullKey(key) }),
        );
        return { size: result.ContentLength ?? 0 };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: fullKey(key) }));
    },

    async *list(listPrefix): AsyncGenerator<ListedObject> {
      assertValidPrefix(listPrefix);
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: base + listPrefix,
            ...(token ? { ContinuationToken: token } : {}),
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          yield { key: item.Key.slice(base.length), size: item.Size ?? 0 };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },

    async createMultipart(key, multipartOptions) {
      const result = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          Key: fullKey(key),
          ...(multipartOptions?.contentType ? { ContentType: multipartOptions.contentType } : {}),
        }),
      );
      if (!result.UploadId) throw new StorageError("The bucket did not start a multipart upload");
      return result.UploadId;
    },

    async putPart(key, uploadId, partNumber, body) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS) {
        throw new StorageError(`Part numbers run from 1 to ${MAX_PARTS}`);
      }
      const result = await client.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: fullKey(key),
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.length,
        }),
      );
      if (!result.ETag) throw new StorageError(`The bucket did not acknowledge part ${partNumber}`);
      return result.ETag;
    },

    async completeMultipart(key, uploadId, parts) {
      const Key = fullKey(key);
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: [...parts]
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((p) => ({ PartNumber: p.partNumber, ETag: p.tag })),
            },
          }),
        );
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 400) {
          throw new StorageError(
            `The bucket refused to complete the upload: ${error.name} ${error.message}`,
          );
        }
        throw error;
      }
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      return { size: head.ContentLength ?? 0 };
    },

    async abortMultipart(key, uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: fullKey(key),
            UploadId: uploadId,
          }),
        );
      } catch (error) {
        // Already aborted or completed: nothing left to discard.
        if (
          isNotFound(error) ||
          (error instanceof S3ServiceException && error.name === "NoSuchUpload")
        )
          return;
        throw error;
      }
    },

    async check() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const reason =
          status(error) === 404
            ? "the bucket does not exist"
            : status(error) === 403 || status(error) === 401
              ? "access is denied; check the credentials and bucket policy"
              : `${(error as Error).name}: ${(error as Error).message}`;
        throw new StorageConfigError(
          `Storage backend "${options.name}" cannot use bucket "${bucket}": ${reason}`,
        );
      }
      const probe = `.hekate-probe/${randomUUID()}`;
      try {
        await new Upload({
          client,
          params: { Bucket: bucket, Key: base + probe, Body: Buffer.from("hekate") },
        }).done();
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: base + probe }));
      } catch (error) {
        throw new StorageConfigError(
          `Storage backend "${options.name}" cannot write to bucket "${bucket}": ${(error as Error).name} ${(error as Error).message}`,
        );
      }
    },
  };
}
