import { type ImportSource, readWaveHeader } from "@hekate/shared";

/**
 * The take import's side in the browser (#45): what was dropped, folders and all, and each
 * file's header read where it lies, before anything is uploaded. Only the header is read: a
 * few kilobytes of each file, however long its audio runs.
 */

/** A file chosen for the import, with the folder it was found in. */
export interface Picked {
  file: File;
  folder: string;
}

/** Most files one import reads; a week of sessions is well under it. */
export const MAX_IMPORT_FILES = 20_000;
/** Files read at once. */
const READING = 8;

const folderOf = (path: string) => path.split("/").slice(0, -1).filter(Boolean).join("/");

/** Files chosen with the file chooser, a folder's with their folder (`webkitRelativePath`). */
export const pickedFromList = (list: FileList | File[]): Picked[] =>
  [...list].map((file) => ({ file, folder: folderOf(file.webkitRelativePath || "") }));

/** Everything dropped: files, and folders walked to the files they hold. */
export async function pickedFromDrop(data: DataTransfer): Promise<Picked[]> {
  const entries = [...data.items]
    .map((item) => item.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => Boolean(e));
  if (entries.length === 0) return pickedFromList(data.files);
  const picked: Picked[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (picked.length >= MAX_IMPORT_FILES) return;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      picked.push({ file, folder: folderOf(entry.fullPath) });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // A directory gives its entries in batches until one comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return picked;
}

/** Hidden files a recorder or an operating system leaves beside the recordings. */
const hidden = (name: string) => name.startsWith(".") || name === "Thumbs.db";

/** Each file's header read, a few at a time, with how many are done. */
export async function readSources(
  picked: Picked[],
  onProgress: (done: number) => void,
  signal: AbortSignal,
): Promise<{ sources: ImportSource[]; files: Map<string, File> }> {
  const shown = picked.filter((p) => !hidden(p.file.name)).slice(0, MAX_IMPORT_FILES);
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
