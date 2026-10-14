import {
  type FileKind,
  formatBytes,
  formatChannels,
  formatDuration,
  type MediaInfo,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type ProjectFile, projectFilesQuery, type StreamStatus } from "~/lib/queries";
import { cancelUpload, type UploadProgress, uploadFile } from "~/lib/upload";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";

export const kindIcon: Record<FileKind, IconName> = {
  audio: "music",
  video: "film",
  image: "image",
  document: "file",
  other: "file",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

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

interface Pending {
  key: string;
  file: File;
  progress: UploadProgress;
  error?: string;
  controller: AbortController;
}

/** Drop zone, upload button and live progress for one project. */
export function Uploader({
  projectId,
  title,
  body,
}: {
  projectId: string;
  title: string;
  body: string;
}) {
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);

  const update = useCallback((key: string, change: Partial<Pending>) => {
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  }, []);

  const start = useCallback(
    (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`;
        const controller = new AbortController();
        setPending((list) => [
          ...list,
          { key, file, controller, progress: { sent: 0, total: file.size, phase: "starting" } },
        ]);
        uploadFile(file, {
          projectId,
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
    [client, projectId, update],
  );

  const cancel = (p: Pending) => {
    p.controller.abort();
    setPending((list) => list.filter((x) => x.key !== p.key));
    void cancelUpload(projectId, p.file);
  };

  const retry = (p: Pending) => {
    setPending((list) => list.filter((x) => x.key !== p.key));
    start([p.file]);
  };

  // Warn before closing the page mid-upload; choosing the same files again resumes them.
  useEffect(() => {
    const active = pending.some((p) => !p.error);
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (event.dataTransfer.files.length > 0) start(event.dataTransfer.files);
  };

  return (
    <div className="flex flex-col gap-3">
      <section
        aria-label="Upload files"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-wrap items-center justify-between gap-4 rounded-panel border border-dashed p-6 transition-colors",
          over ? "border-signal bg-surface" : "border-edge",
        )}
      >
        <div className="flex items-start gap-3">
          <Icon name="upload" size={20} className="mt-0.5 shrink-0 text-ink-2" />
          <div className="flex flex-col gap-1">
            <p className="m-0 text-[15px] font-medium">{title}</p>
            <p className="m-0 max-w-md text-[13px] leading-normal text-ink-3">{body}</p>
          </div>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files) start(event.target.files);
            event.target.value = "";
          }}
        />
        <Button variant="primary" onClick={() => input.current?.click()}>
          <Icon name="upload" size={14} />
          Upload
        </Button>
      </section>
      {pending.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0" aria-label="Uploads in progress">
          {pending.map((p) => {
            const share = p.progress.total === 0 ? 1 : p.progress.sent / p.progress.total;
            const label = p.error
              ? p.error
              : p.progress.phase === "completing"
                ? "Finishing"
                : p.progress.phase === "starting"
                  ? "Starting"
                  : `${Math.floor(share * 100)}%`;
            return (
              <li key={p.key} className="flex flex-col gap-2 border-b border-hairline px-2 py-3">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm">{p.file.name}</span>
                  <span className="tabular shrink-0 text-xs text-ink-3">
                    {formatBytes(p.progress.sent)} of {formatBytes(p.progress.total)}
                  </span>
                  <span
                    className={cn(
                      "tabular w-24 shrink-0 text-right text-xs",
                      p.error ? "text-signal" : "text-ink-2",
                    )}
                  >
                    {label}
                  </span>
                  {p.error && (
                    <Button size="sm" variant="ghost" onClick={() => retry(p)}>
                      Retry
                    </Button>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Cancel ${p.file.name}`}
                    onClick={() => cancel(p)}
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
      )}
    </div>
  );
}

function FileRow({ file }: { file: ProjectFile }) {
  const summary = mediaSummary(file.kind, file.mediaInfo, file.streamStatus);
  return (
    <li className="grid min-h-12 grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 border-b border-hairline px-2 py-2 sm:grid-cols-[auto_minmax(0,1fr)_320px_72px_104px]">
      <Icon name={kindIcon[file.kind]} className="row-span-2 text-ink-2 sm:row-span-1" />
      <Link
        to="/files/$fileId"
        params={{ fileId: file.id }}
        className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
      >
        {file.name}
      </Link>
      <span className="tabular text-right text-xs text-ink-3 sm:order-last">
        {dateFormat.format(new Date(file.createdAt))}
      </span>
      <span
        className={cn(
          "tabular col-span-2 truncate text-xs sm:col-span-1",
          summary === "Measuring" ? "text-ink-3" : "text-ink-2",
        )}
      >
        {summary ?? file.contentType}
      </span>
      <span className="tabular hidden text-right text-xs text-ink-3 sm:block">
        {formatBytes(file.byteSize)}
      </span>
    </li>
  );
}

export function FileList({ projectId }: { projectId: string }) {
  const { data, error } = useQuery(projectFilesQuery(projectId));
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data || data.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="Files">
      <li className="label hidden grid-cols-[auto_minmax(0,1fr)_320px_72px_104px] gap-3 border-b border-hairline px-2 pb-2 sm:grid">
        <span className="w-4" />
        <span>Name</span>
        <span>Details</span>
        <span className="text-right">Size</span>
        <span className="text-right">Added</span>
      </li>
      {data.map((file) => (
        <FileRow key={file.id} file={file} />
      ))}
    </ul>
  );
}
