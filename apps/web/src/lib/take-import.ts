import { type ImportSource, readWaveHeader } from "@hekate/shared";
import { MAX_PICKED_FILES, type Picked } from "./picked-files.ts";

/**
 * The take import's side in the browser (#45): each chosen file's header read where it lies,
 * before anything is uploaded. Only the header is read: a few kilobytes of each file, however
 * long its audio runs.
 */

/** Files read at once. */
const READING = 8;

/** Hidden files a recorder or an operating system leaves beside the recordings. */
const hidden = (name: string) => name.startsWith(".") || name === "Thumbs.db";

/** Each file's header read, a few at a time, with how many are done. */
export async function readSources(
  picked: Picked[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<{ sources: ImportSource[]; files: Map<string, File> }> {
  const shown = picked.filter((p) => !hidden(p.file.name)).slice(0, MAX_PICKED_FILES);
  const sources: ImportSource[] = new Array(shown.length);
  const files = new Map<string, File>();
  let next = 0;
  let done = 0;
  const work = async () => {
    while (next < shown.length) {
      if (signal.aborted) return;
      const i = next;
      next += 1;
      const { file, folder } = shown[i] as Picked;
      const key = `${i}`;
      files.set(key, file);
      const read = async (position: number, length: number) =>
        new Uint8Array(await file.slice(position, position + length).arrayBuffer());
      const header = /\.(wav|wave|bwf|rf64)$/i.test(file.name)
        ? await readWaveHeader(read, file.size).catch(() => null)
        : null;
      sources[i] = { key, name: file.name, folder, size: file.size, header };
      done += 1;
      onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: READING }, work));
  return { sources: sources.filter(Boolean), files };
}
