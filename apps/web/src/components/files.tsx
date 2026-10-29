import {
  type FileKind,
  formatBytes,
  formatChannels,
  formatDuration,
  type MediaInfo,
} from "@hekate/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "~/lib/cn";
import type { StreamStatus } from "~/lib/queries";
import { cancelUpload, type UploadProgress, uploadFile } from "~/lib/upload";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { FileInput } from "./ui/input";

export const kindIcon: Record<FileKind, IconName> = {
  audio: "music",
  video: "film",
  image: "image",
  document: "file",
  other: "file",
};

/** The facts a reviewer scans for, in the order they read them. */
export function mediaSummary(
  kind: FileKind,
  info: MediaInfo | null,
  streamStatus?: StreamStatus,
): string | null {
  if (kind !== "audio" && kind !== "video") return null;
  if (info === null) return streamStatus === "failed" ? "Could not be measured" : "Measuring";
  const parts: string[] = [];
  if (info.video) {
    parts.push(`${info.video.width} × ${info.video.height}`);
    if (info.video.fps) parts.push(`${info.video.fps} fps`);
  }
  if (info.audio) {
    parts.push(`${info.audio.sampleRate / 1000} kHz`);
    if (info.audio.bitDepth) parts.push(`${info.audio.bitDepth}-bit`);
    parts.push(formatChannels(info.audio.channels, info.audio.channelLayout));
  }
  if (info.duration !== undefined) parts.push(formatDuration(info.duration));
  return parts.length > 0 ? parts.join(" · ") : "Not readable as media";
}

/** A file's format from its name, as people say it: "PDF", "PNG", "ZIP". */
const formatOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : null;
};

/**
 * What a list says about a file (#149): a recording's or a video's measurements, a
 * document's pages, a picture's format; otherwise its type.
 */
export function fileSummary(file: {
  name: string;
  kind: FileKind;
  contentType: string;
  mediaInfo: MediaInfo | null;
  streamStatus: StreamStatus;
  pageCount?: number | null | undefined;
}): string {
  const media = mediaSummary(file.kind, file.mediaInfo, file.streamStatus);
  if (media) return media;
  const format = formatOf(file.name);
  if (file.kind === "image") return format ? `${format} picture` : "Picture";
  if (file.kind === "document") {
    const pages = file.pageCount
      ? ` · ${file.pageCount} page${file.pageCount === 1 ? "" : "s"}`
      : "";
    return `${format ?? "Document"}${pages}`;
  }
  return format ? `${format} file` : file.contentType;
}

interface Pending {
  key: string;
  file: File;
  /** Where it is going, which stays the same if the browser moves to another folder. */
  folderId: string | null;
  progress: UploadProgress;
  error?: string;
  controller: AbortController;
}

interface Uploads {
  /** Send files to a folder (the open one unless told otherwise). */
  start: (files: FileList | File[], into?: string | null) => void;
  pending: Pending[];
  cancel: (p: Pending) => void;
  retry: (p: Pending) => void;
}

const UploadContext = createContext<Uploads | null>(null);

/** Whether a drag carries files, rather than text or a link from the page itself. */
const carriesFiles = (event: globalThis.DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/**
 * Uploads for one project: files dropped anywhere on the page, or chosen with the Upload
 * button, go to the open folder. Progress shows where the list is placed.
 */
export function UploadProvider({
  projectId,
  folderId = null,
  folderName,
  enabled,
  children,
}: {
  projectId: string;
  /** Where new files go; null is the top of the project. */
  folderId?: string | null;
  /** For the drop hint: "Drop to upload to Mixes". */
  folderName?: string;
  /** Off for those whose role cannot upload. */
  enabled: boolean;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);

  const update = useCallback((key: string, change: Partial<Pending>) => {
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  }, []);

  const start = useCallback(
    (files: FileList | File[], into: string | null = folderId) => {
      for (const file of Array.from(files)) {
        const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`;
        const controller = new AbortController();
        setPending((list) => [
          ...list,
          {
            key,
            file,
            folderId: into,
            controller,
            progress: { sent: 0, total: file.size, phase: "starting" },
          },
        ]);
        uploadFile(file, {
          projectId,
          folderId: into,
          signal: controller.signal,
          onProgress: (progress) => update(key, { progress }),
        })
          .then(() => {
            setPending((list) => list.filter((p) => p.key !== key));
            void client.invalidateQueries({ queryKey: ["projects", projectId, "files"] });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            update(key, { error: error instanceof Error ? error.message : "Upload failed" });
          });
      }
    },
    [client, projectId, folderId, update],
  );

  const cancel = useCallback(
    (p: Pending) => {
      p.controller.abort();
      setPending((list) => list.filter((x) => x.key !== p.key));
      void cancelUpload(projectId, p.folderId, p.file);
    },
    [projectId],
  );

  const retry = useCallback(
    (p: Pending) => {
      setPending((list) => list.filter((x) => x.key !== p.key));
      start([p.file], p.folderId);
    },
    [start],
  );

  // Warn before closing the page mid-upload; choosing the same files again resumes them.
  useEffect(() => {
    const active = pending.some((p) => !p.error);
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  // Files dropped anywhere on the page upload to the open folder.
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const enter = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setOver(false);
    };
    const overPage = (event: globalThis.DragEvent) => {
      if (carriesFiles(event)) event.preventDefault();
    };
    const drop = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      if (event.dataTransfer && event.dataTransfer.files.length > 0)
        start(event.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overPage);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overPage);
      window.removeEventListener("drop", drop);
    };
  }, [enabled, start]);

  const value = useMemo(() => ({ start, pending, cancel, retry }), [start, pending, cancel, retry]);

  return (
    <UploadContext.Provider value={enabled ? value : null}>
      {children}
      {over && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-panel border border-dashed border-signal bg-ground/80 backdrop-blur-sm"
        >
          <span className="flex items-center gap-2 text-[15px] text-ink">
            <Icon name="upload" size={18} className="text-signal" />
            Drop to upload to {folderName ?? "the top of the project"}
          </span>
        </div>
      )}
    </UploadContext.Provider>
  );
}

/** Choose files to upload to the open folder; nothing for those who cannot upload. */
/**
 * The page's uploads, for something other than the Upload button to start one (a context
 * menu's Upload); null where nobody may upload here.
 */
export const useUploads = () => useContext(UploadContext);

export function UploadButton() {
  const uploads = useContext(UploadContext);
  const input = useRef<HTMLInputElement>(null);
  if (!uploads) return null;
  return (
    <>
      <FileInput
        ref={input}
        multiple
        aria-label="Files to upload"
        onChange={(event) => {
          if (event.target.files) uploads.start(event.target.files);
          event.target.value = "";
        }}
      />
      <Button size="sm" variant="primary" onClick={() => input.current?.click()}>
        <Icon name="upload" size={14} />
        Upload
      </Button>
    </>
  );
}

/** Uploads under way, each with its progress, and a way to cancel or retry. */
export function UploadList() {
  const uploads = useContext(UploadContext);
  if (!uploads || uploads.pending.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="Uploads in progress">
      {uploads.pending.map((p) => {
        const share = p.progress.total === 0 ? 1 : p.progress.sent / p.progress.total;
        const label = p.error
          ? p.error
          : p.progress.phase === "completing"
            ? "Finishing"
            : p.progress.phase === "starting"
              ? "Starting"
              : `${Math.floor(share * 100)}%`;
        return (
          <li key={p.key} className="flex flex-col gap-2 border-b border-hairline px-2 py-2.5">
            <div className="flex items-center gap-3">
              <Icon name="upload" size={14} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{p.file.name}</span>
              <span className="tabular hidden shrink-0 text-xs text-ink-3 sm:inline">
                {formatBytes(p.progress.sent)} of {formatBytes(p.progress.total)}
              </span>
              <span
                className={cn(
                  "tabular w-20 shrink-0 text-right text-xs",
                  p.error ? "text-signal" : "text-ink-2",
                )}
              >
                {label}
              </span>
              {p.error && (
                <Button size="sm" variant="ghost" onClick={() => uploads.retry(p)}>
                  Retry
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Cancel ${p.file.name}`}
                onClick={() => uploads.cancel(p)}
              >
                <Icon name="close" size={12} />
              </Button>
            </div>
            <div
              className="h-0.5 w-full overflow-hidden rounded-full bg-hairline"
              aria-hidden="true"
            >
              <div
                className={cn(
                  "h-full transition-[width] duration-300",
                  p.error ? "bg-ink-3" : "bg-signal",
                )}
                style={{ width: `${Math.max(2, share * 100)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
