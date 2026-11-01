import { type FileKind, formatChannels, formatDuration, type MediaInfo } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
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
import { type Picked, pickedFromDrop } from "~/lib/picked-files";
import {
  projectQuery,
  projectTracksQuery,
  type StreamStatus,
  type Track,
  useItemWords,
  useProjectCan,
} from "~/lib/queries";
import { isAudio } from "~/lib/upload-plan";
import { Icon, type IconName } from "./icons";
import { Button } from "./ui/button";
import { FileInput } from "./ui/input";
import { AudioUploadDialog } from "./upload-choice";
import { type QueuedUpload, useUploadQueue } from "./upload-queue";

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

/** An upload under way: the shell's queue holds it, whatever page is open (#552). */
type Pending = QueuedUpload;

interface Uploads {
  /** Send files to a folder (the open one unless told otherwise), or onto a track's row. */
  start: (files: FileList | File[], into?: string | null, onto?: Track | null) => void;
  /** Whether audio is asked what it becomes here (#485): the dialog opens, and picks the files. */
  asks: boolean;
  /** Open the dialog with nothing chosen yet. */
  open: () => void;
  pending: Pending[];
  cancel: (p: Pending) => void;
  retry: (p: Pending) => void;
}

const UploadContext = createContext<Uploads | null>(null);
/** The track whose row files are being dragged over, for the row to show it. */
const AimContext = createContext<string | null>(null);

/** Whether a drag carries files, rather than text or a link from the page itself. */
const carriesFiles = (event: globalThis.DragEvent) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** The track row under a drag, by the `data-drop-track` the file browser puts on it. */
const trackUnder = (target: EventTarget | null) =>
  (target instanceof Element ? target.closest("[data-drop-track]") : null)?.getAttribute(
    "data-drop-track",
  ) ?? null;

/**
 * Files dropped anywhere on the page: `onDrop` gets them, folders walked to their files, with
 * the track row they landed on if any; `onAim` follows the track row under the drag. Returns
 * whether a drag is over the page.
 */
export function usePageDrop({
  enabled,
  onDrop,
  onAim,
}: {
  enabled: boolean;
  onDrop: (picked: Picked[], trackId: string | null) => void;
  onAim?: (trackId: string | null) => void;
}) {
  const [over, setOver] = useState(false);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const aim = useRef(onAim);
  aim.current = onAim;
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    let aimed: string | null = null;
    const point = (next: string | null) => {
      if (next === aimed) return;
      aimed = next;
      aim.current?.(next);
    };
    const enter = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setOver(true);
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        setOver(false);
        point(null);
      }
    };
    const overPage = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      point(trackUnder(event.target));
    };
    const dropped = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setOver(false);
      const onto = trackUnder(event.target);
      point(null);
      if (event.dataTransfer)
        void pickedFromDrop(event.dataTransfer).then((picked) => {
          if (picked.length > 0) drop.current(picked, onto);
        });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overPage);
    window.addEventListener("drop", dropped);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overPage);
      window.removeEventListener("drop", dropped);
      setOver(false);
      point(null);
    };
  }, [enabled]);
  return over;
}

/**
 * What a drag over the page is told: a veil over the page with the message in the middle, or,
 * `quiet`, the message alone along the foot, so the row it is over stays in view.
 */
export function DropHint({ text, quiet = false }: { text: string; quiet?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none fixed inset-2 z-50 flex justify-center rounded-panel border border-dashed border-signal",
        quiet ? "items-end pb-6" : "items-center bg-ground/80 backdrop-blur-sm",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-2 text-[15px] text-ink",
          quiet && "rounded-full border border-line bg-overlay px-4 py-2 shadow-3",
        )}
      >
        <Icon name="upload" size={18} className="text-signal" />
        {text}
      </span>
    </div>
  );
}

/**
 * Uploads for one project: files dropped anywhere on the page, or chosen with the Upload
 * button, go to the open folder. They go up through the shell's queue, so they keep going, and
 * show in its tray, on any page (#552); this page only starts them. In a music project
 * audio is asked what it becomes first (#485), in the upload dialog: a drop on a track's row
 * opens it on a new version of that track.
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
  const queue = useUploadQueue();
  const pending = useMemo(
    () => queue?.pending.filter((p) => p.projectId === projectId) ?? [],
    [queue, projectId],
  );
  const { data: project } = useQuery(projectQuery(projectId));
  const music = project?.profile === "music";
  const can = useProjectCan(projectId);
  const { data: tracks } = useQuery({
    ...projectTracksQuery(projectId),
    enabled: enabled && music,
  });
  const { words } = useItemWords(projectId);
  /** Audio is asked about where it can become a track, or a version of one. */
  const asks = enabled && music && (can("organise") || (tracks?.length ?? 0) > 0);
  const [asking, setAsking] = useState<{ files: Picked[]; onto: Track | null } | null>(null);
  const open = asking !== null;
  const [aimed, setAimed] = useState<string | null>(null);
  const aimedTrack = aimed ? tracks?.find((t) => t.id === aimed) : undefined;

  /** Send files as they are, to a folder. */
  const send = useCallback(
    (files: File[], into: string | null) => queue?.send(files, { projectId, folderId: into }),
    [queue, projectId],
  );

  const start = useCallback(
    (
      files: FileList | File[] | Picked[],
      into: string | null = folderId,
      onto: Track | null = null,
    ) => {
      // A drop keeps each file's folder, so two alike in different folders stay two.
      const picked: Picked[] = Array.from(files as ArrayLike<File | Picked>).map((f) =>
        f instanceof File ? { file: f, folder: "" } : f,
      );
      // Audio in a music project is asked what it becomes, and whatever was dropped with it
      // goes up alongside; anything else, anywhere else, goes up as it is.
      if (asks && (onto || picked.some((p) => isAudio(p.file)))) setAsking({ files: picked, onto });
      else
        send(
          picked.map((p) => p.file),
          into,
        );
    },
    [asks, folderId, send],
  );

  const cancel = useCallback((p: Pending) => queue?.cancel(p), [queue]);
  const retry = useCallback((p: Pending) => queue?.retry(p), [queue]);

  // Files dropped anywhere on the page upload to the open folder; while the dialog is open,
  // its own zone takes them.
  const over = usePageDrop({
    enabled: enabled && !open,
    onDrop: (picked, trackId) =>
      start(picked, folderId, tracks?.find((t) => t.id === trackId) ?? null),
    onAim: asks ? setAimed : undefined,
  });

  const value = useMemo(
    () => ({
      start,
      asks,
      open: () => setAsking({ files: [], onto: null }),
      pending,
      cancel,
      retry,
    }),
    [start, asks, pending, cancel, retry],
  );

  return (
    <UploadContext.Provider value={enabled && queue ? value : null}>
      <AimContext.Provider value={over ? aimed : null}>{children}</AimContext.Provider>
      {over &&
        (aimedTrack ? (
          <DropHint
            quiet
            text={`Drop to add ${words.version} ${aimedTrack.versions.length + 1} of ${aimedTrack.name}`}
          />
        ) : (
          <DropHint text={`Drop to upload to ${folderName ?? "the top of the project"}`} />
        ))}
      {asking && (
        <AudioUploadDialog
          projectId={projectId}
          folderId={folderId}
          folderName={folderName}
          tracks={tracks ?? []}
          initial={asking.files}
          onto={asking.onto}
          onClose={() => setAsking(null)}
        />
      )}
    </UploadContext.Provider>
  );
}

/**
 * The page's uploads, for something other than the Upload button to start one (a context
 * menu's Upload); null where nobody may upload here.
 */
export const useUploads = () => useContext(UploadContext);

/** The track whose row files are being dragged over, for the row to show it. */
export function useDropAim() {
  return useContext(AimContext);
}

/**
 * Choose files to upload to the open folder; nothing for those who cannot upload. Where
 * audio is asked what it becomes, the dialog opens and picks the files itself.
 */
export function UploadButton() {
  const uploads = useContext(UploadContext);
  const input = useRef<HTMLInputElement>(null);
  if (!uploads) return null;
  return (
    <>
      {!uploads.asks && (
        <FileInput
          ref={input}
          multiple
          aria-label="Files to upload"
          onChange={(event) => {
            if (event.target.files) uploads.start(event.target.files);
            event.target.value = "";
          }}
        />
      )}
      <Button
        size="sm"
        variant="primary"
        onClick={() => (uploads.asks ? uploads.open() : input.current?.click())}
      >
        <Icon name="upload" size={14} />
        Upload
      </Button>
    </>
  );
}

/**
 * Uploads under way used to be listed on the Files page; they are in the shell's tray now, on
 * every page (#552). This draws nothing, for the places that still put it.
 */
export function UploadList() {
  return null;
}
