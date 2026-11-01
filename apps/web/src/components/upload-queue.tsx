import { formatBytes } from "@hekate/shared";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { cn } from "~/lib/cn";
import { cancelUpload, type UploadProgress, uploadFile } from "~/lib/upload";
import { type TraySummary, traySummary } from "~/lib/upload-tray";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/** One file on its way up, wherever in the app it was started. */
export interface QueuedUpload {
  key: string;
  file: File;
  projectId: string;
  /** Where it is going, which stays the same whatever page the browser moves to. */
  folderId: string | null;
  progress: UploadProgress;
  error?: string;
  /** Arrived: shown a moment as done, then gone. */
  done?: boolean;
  controller: AbortController;
}

interface Queue {
  /** Send files to a project's folder; the queue keeps them going across pages. */
  send: (files: File[], to: { projectId: string; folderId: string | null }) => void;
  pending: QueuedUpload[];
  cancel: (upload: QueuedUpload) => void;
  retry: (upload: QueuedUpload) => void;
}

const QueueContext = createContext<Queue | null>(null);

/** How long an arrived file stays in the tray, marked done, before it leaves. */
const DONE_MS = 2500;

/**
 * The app's uploads, held by the shell rather than by the page that started them (#552): a
 * file started on Files keeps going, and keeps its progress in view, on any other page, and
 * closing the tab while anything is still on its way asks first. Pages only start uploads.
 */
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [pending, setPending] = useState<QueuedUpload[]>([]);

  const update = useCallback((key: string, change: Partial<QueuedUpload>) => {
    setPending((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  }, []);

  const send = useCallback<Queue["send"]>(
    (files, { projectId, folderId }) => {
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}:${Math.random()}`;
        const controller = new AbortController();
        setPending((list) => [
          ...list,
          {
            key,
            file,
            projectId,
            folderId,
            controller,
            progress: { sent: 0, total: file.size, phase: "starting" },
          },
        ]);
        uploadFile(file, {
          projectId,
          folderId,
          signal: controller.signal,
          onProgress: (progress) => update(key, { progress }),
        })
          .then(() => {
            update(key, {
              done: true,
              progress: { sent: file.size, total: file.size, phase: "completing" },
            });
            setTimeout(() => setPending((list) => list.filter((p) => p.key !== key)), DONE_MS);
            void client.invalidateQueries({ queryKey: ["projects", projectId, "files"] });
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            update(key, { error: error instanceof Error ? error.message : "Upload failed" });
          });
      }
    },
    [client, update],
  );

  const cancel = useCallback((p: QueuedUpload) => {
    p.controller.abort();
    setPending((list) => list.filter((x) => x.key !== p.key));
    if (!p.done) void cancelUpload(p.projectId, p.folderId, p.file);
  }, []);

  const retry = useCallback(
    (p: QueuedUpload) => {
      setPending((list) => list.filter((x) => x.key !== p.key));
      send([p.file], { projectId: p.projectId, folderId: p.folderId });
    },
    [send],
  );

  // Warn before closing the page mid-upload, on whatever page; choosing the same files again
  // resumes them.
  useEffect(() => {
    if (!pending.some((p) => !p.error && !p.done)) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  const value = useMemo(() => ({ send, pending, cancel, retry }), [send, pending, cancel, retry]);
  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

/** The shell's uploads, or null outside the shell (a guest's pages, a standalone page). */
export const useUploadQueue = () => useContext(QueueContext);

const headline = (s: TraySummary) =>
  s.failed > 0 && s.going === 0
    ? `${s.failed} upload${s.failed === 1 ? "" : "s"} failed`
    : s.going > 0
      ? `Uploading ${s.going} file${s.going === 1 ? "" : "s"}`
      : `${s.done} uploaded`;

/**
 * The uploads under way, at the pane's foot on the right, as Frame.io, Dropbox and Google Drive
 * keep theirs: each file's name and progress with Cancel and, once failed, Retry; folded to a
 * line with the count and how far along; gone once everything has arrived.
 */
export function UploadTray() {
  const queue = useUploadQueue();
  const [folded, setFolded] = useState(false);
  if (!queue || queue.pending.length === 0) return null;
  const summary = traySummary(queue.pending);
  return (
    <section
      aria-label="Uploads"
      data-e2e-overlap
      className="rise-in absolute right-3 bottom-[68px] left-3 z-30 flex flex-col @3xl/app:left-auto @3xl/app:w-[340px] overflow-hidden rounded-panel-lg border border-line bg-overlay shadow-4 @3xl/app:right-5 @3xl/app:bottom-5"
    >
      <div className="flex h-11 items-center gap-2 pr-1.5 pl-4">
        <span role="status" className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
          {headline(summary)}
          {summary.going > 0 && (
            <span className="tabular ml-2 font-normal text-ink-2">{summary.percent}%</span>
          )}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-expanded={!folded}
          aria-controls="upload-tray-list"
          aria-label={folded ? "Show uploads" : "Fold uploads"}
          onClick={() => setFolded(!folded)}
        >
          <Icon name={folded ? "chevronUp" : "chevronDown"} size={14} />
        </Button>
      </div>
      {folded ? (
        <div className="h-0.5 w-full bg-hairline" aria-hidden="true">
          <div
            className="h-full bg-signal transition-[width] duration-300"
            style={{ width: `${Math.max(2, summary.percent)}%` }}
          />
        </div>
      ) : (
        <ul
          id="upload-tray-list"
          className="scroll-quiet m-0 flex max-h-[260px] list-none flex-col overflow-y-auto border-t border-line p-0"
        >
          {queue.pending.map((p) => (
            <TrayRow key={p.key} upload={p} onCancel={queue.cancel} onRetry={queue.retry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TrayRow({
  upload: p,
  onCancel,
  onRetry,
}: {
  upload: QueuedUpload;
  onCancel: (p: QueuedUpload) => void;
  onRetry: (p: QueuedUpload) => void;
}) {
  const share = p.progress.total === 0 ? 1 : p.progress.sent / p.progress.total;
  const label = p.done
    ? "Uploaded"
    : p.error
      ? "Failed"
      : p.progress.phase === "completing"
        ? "Finishing"
        : p.progress.phase === "starting"
          ? "Starting"
          : `${Math.floor(share * 100)}%`;
  return (
    <li className="flex flex-col gap-1.5 border-b border-hairline py-2 pr-1.5 pl-4 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <Icon
          name={p.done ? "check" : p.error ? "warning" : "upload"}
          size={14}
          className={cn("shrink-0", p.error ? "text-warn" : "text-ink-3")}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={p.file.name}>
          {p.file.name}
        </span>
        <span className="tabular shrink-0 text-[12px] text-ink-2">{label}</span>
        {p.error && (
          <Button size="sm" variant="ghost" onClick={() => onRetry(p)}>
            Retry
          </Button>
        )}
        {!p.done && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={`Cancel ${p.file.name}`}
            onClick={() => onCancel(p)}
          >
            <Icon name="close" size={12} />
          </Button>
        )}
      </div>
      {p.error ? (
        <span className="text-[12px] text-ink-3 [overflow-wrap:anywhere]">{p.error}</span>
      ) : (
        !p.done && (
          <div className="flex items-center gap-2" aria-hidden="true">
            <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-hairline">
              <div
                className="h-full bg-signal transition-[width] duration-300"
                style={{ width: `${Math.max(2, share * 100)}%` }}
              />
            </div>
            <span className="tabular shrink-0 text-[11px] text-ink-3">
              {formatBytes(p.progress.total)}
            </span>
          </div>
        )
      )}
    </li>
  );
}
