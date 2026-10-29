/**
 * Files chosen in the browser, folders and all: what the file chooser gives, and what was
 * dropped, each with the folder it was found in. The upload dialog reads every choice this
 * way, so a folder dropped on it (a day's recording, say) arrives as its files.
 */

/** A file chosen, with the folder it was found in ("" for one chosen on its own). */
export interface Picked {
  file: File;
  folder: string;
}

/** Most files one choice takes; a week of sessions is well under it. */
export const MAX_PICKED_FILES = 20_000;

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
    if (picked.length >= MAX_PICKED_FILES) return;
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
