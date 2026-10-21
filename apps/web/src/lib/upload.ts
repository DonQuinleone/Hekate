import { quoting } from "./queries";

/**
 * Resumable uploads (server: apps/server/src/upload-engine.ts). A file is sent as
 * 8 MiB chunks, three at a time, each with a SHA-256 digest. Failed chunks are
 * retried with backoff; if the page closes, choosing the same file again in the
 * same place carries on from the chunks the server already has. Members send
 * through `/uploads`; someone with an upload request's link through its own
 * routes (#139), which work the same way.
 */

export interface UploadView {
  id: string;
  chunkSize: number;
  chunkCount: number;
  receivedChunks: number[];
  status: "open" | "completing" | "completed" | "aborted";
}

export interface UploadedFile {
  id: string;
  name: string;
  kind: string;
  byteSize: number;
}

export interface UploadProgress {
  /** Bytes the server has confirmed, plus bytes in flight. */
  sent: number;
  total: number;
  phase: "starting" | "sending" | "completing";
}

const PARALLEL = 3;
const RETRIES = 5;

class UploadError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string; reference?: string };
    } | null;
    throw new UploadError(
      quoting(body?.error?.message ?? `Request failed (${res.status})`, body?.error?.reference),
      res.status >= 500,
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** One resumable upload per file and destination: the same file sent to two folders is two uploads. */
const resumeKey = (projectId: string, folderId: string | null | undefined, file: File) =>
  `hekate:upload:${projectId}:${folderId ?? "top"}:${file.name}:${file.size}:${file.lastModified}`;

/** The same for an upload request's link: one upload per file and link. */
const linkResumeKey = (token: string, file: File) =>
  `hekate:upload-link:${token}:${file.name}:${file.size}:${file.lastModified}`;

function remember(key: string, id: string | null) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {
    // Private windows may refuse storage; resuming is a convenience.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

async function digest(bytes: ArrayBuffer): Promise<string | undefined> {
  // SubtleCrypto exists only in secure contexts (HTTPS or localhost); the digest is optional.
  if (!globalThis.crypto?.subtle) return undefined;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** PUT one chunk with XMLHttpRequest, which reports upload progress. */
function sendChunk(
  path: string,
  index: number,
  bytes: ArrayBuffer,
  hash: string | undefined,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api${path}/chunks/${index}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    if (hash) xhr.setRequestHeader("content-digest", `sha-256=:${hash}:`);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status === 204) return resolve();
      let message = `Chunk ${index} failed (${xhr.status})`;
      try {
        const { error } = JSON.parse(xhr.responseText) as {
          error: { message: string; reference?: string };
        };
        message = quoting(error.message, error.reference);
      } catch {}
      // Damaged in transit (400 with a digest) and server errors are worth another try.
      const retryable =
        xhr.status >= 500 ||
        xhr.status === 408 ||
        xhr.status === 429 ||
        message.includes("damaged");
      reject(new UploadError(message, retryable));
    };
    xhr.onerror = () => reject(new UploadError("The connection dropped", true));
    xhr.ontimeout = () => reject(new UploadError("The server took too long", true));
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.send(bytes);
  });
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Upload cancelled", "AbortError"));
      },
      { once: true },
    );
  });

/**
 * Sends one file to `base` (the uploads it starts and finishes are `${base}/<id>`), resuming
 * the upload `key` remembers if the server still has it open. `begin` is what starting one
 * sends; the answer is what completing it returns.
 */
async function send<T>(
  file: File,
  options: {
    base: string;
    key: string;
    begin: Record<string, unknown>;
    signal: AbortSignal;
    onProgress: (progress: UploadProgress) => void;
  },
): Promise<T> {
  const { base, key, signal, onProgress } = options;
  onProgress({ sent: 0, total: file.size, phase: "starting" });

  let upload: UploadView | undefined;
  const previous = recall(key);
  if (previous) {
    const found = await call<{ upload: UploadView }>(`${base}/${previous}`)
      .then((r) => r.upload)
      .catch(() => undefined);
    if (found?.status === "completed") {
      // Finished on the server, but the answer never arrived: completing again returns the file.
      const done = await call<T>(`${base}/${found.id}/complete`, {
        method: "POST",
        body: "{}",
        signal,
      });
      remember(key, null);
      onProgress({ sent: file.size, total: file.size, phase: "completing" });
      return done;
    }
    if (found?.status === "open") upload = found;
  }
  if (!upload) {
    upload = (
      await call<{ upload: UploadView }>(base, {
        method: "POST",
        body: JSON.stringify({
          ...options.begin,
          name: file.name,
          size: file.size,
          contentType: file.type || undefined,
        }),
        signal,
      })
    ).upload;
    remember(key, upload.id);
  }
  const { id, chunkSize, chunkCount } = upload;
  const lengthOf = (i: number) => Math.min(chunkSize, file.size - i * chunkSize);

  const done = new Set(upload.receivedChunks);
  const inFlight = new Map<number, number>();
  const report = () => {
    let sent = 0;
    for (const i of done) sent += lengthOf(i);
    for (const loaded of inFlight.values()) sent += loaded;
    onProgress({ sent: Math.min(sent, file.size), total: file.size, phase: "sending" });
  };
  report();

  const queue = [...Array(chunkCount).keys()].filter((i) => !done.has(i));
  const worker = async () => {
    for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
      const bytes = await file
        .slice(index * chunkSize, index * chunkSize + lengthOf(index))
        .arrayBuffer();
      const hash = await digest(bytes);
      for (let attempt = 0; ; attempt++) {
        try {
          await sendChunk(`${base}/${id}`, index, bytes, hash, signal, (loaded) => {
            inFlight.set(index as number, loaded);
            report();
          });
          break;
        } catch (error) {
          inFlight.delete(index);
          if (!(error instanceof UploadError) || !error.retryable || attempt >= RETRIES)
            throw error;
          await wait(1000 * 2 ** attempt, signal);
        }
      }
      inFlight.delete(index);
      done.add(index);
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, Math.max(queue.length, 1)) }, worker));

  onProgress({ sent: file.size, total: file.size, phase: "completing" });
  const created = await call<T>(`${base}/${id}/complete`, {
    method: "POST",
    body: "{}",
    signal,
  });
  remember(key, null);
  return created;
}

export async function uploadFile(
  file: File,
  options: {
    projectId: string;
    folderId?: string | null;
    signal: AbortSignal;
    onProgress: (progress: UploadProgress) => void;
  },
): Promise<UploadedFile> {
  const { projectId, folderId } = options;
  const { file: created } = await send<{ file: UploadedFile }>(file, {
    base: "/uploads",
    key: resumeKey(projectId, folderId, file),
    begin: { projectId, folderId: folderId ?? null },
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return created;
}

/** Sends one file through an upload request's link (#139): the visitor learns only that it arrived. */
export async function sendToRequest(
  file: File,
  options: {
    token: string;
    sender: string;
    password?: string | undefined;
    signal: AbortSignal;
    onProgress: (progress: UploadProgress) => void;
  },
): Promise<{ name: string; size: number }> {
  const { token, sender, password } = options;
  const { arrived } = await send<{ arrived: { name: string; size: number } }>(file, {
    base: `/upload-links/${encodeURIComponent(token)}/uploads`,
    key: linkResumeKey(token, file),
    begin: { sender, ...(password ? { password } : {}) },
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return arrived;
}

/** Cancel an upload the server already knows about, discarding what it stored. */
export async function cancelUpload(projectId: string, folderId: string | null, file: File) {
  const key = resumeKey(projectId, folderId, file);
  const id = recall(key);
  remember(key, null);
  if (id) await call(`/uploads/${id}`, { method: "DELETE" }).catch(() => undefined);
}
