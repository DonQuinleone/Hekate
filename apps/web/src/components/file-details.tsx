import { captionFormatNames, formatBytes } from "@hekate/shared";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { actionCopy } from "~/lib/access-log";
import { formatDates } from "~/lib/locale";
import {
  accessLogQuery,
  captionsQuery,
  type FileDetails,
  fileDetailsQuery,
  projectFoldersQuery,
  projectTracksQuery,
  useCaptionMutations,
  useOrganise,
  useTrackMutations,
} from "~/lib/queries";
import { Avatar } from "./avatar";
import { AttachForm, destinations, MoveForm, RenameForm } from "./file-forms";
import { mediaSummary } from "./files";
import { Icon } from "./icons";
import { Property } from "./property";
import { Button } from "./ui/button";
import { FileInput, Input, Select } from "./ui/input";
import { StatusDot } from "./ui/status";

const dateTime = formatDates({
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
const shortDate = formatDates({ day: "numeric", month: "short" });
const logTime = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** The heading of one part of the sheet. */
function Heading({ children }: { children: ReactNode }) {
  return <h3 className="eyebrow m-0 text-ink-3">{children}</h3>;
}

/** A stage of preparation, in words, with its state. */
function Stage({ status, done }: { status: FileDetails["analysis"]["status"]; done: string }) {
  if (status === "failed")
    return (
      <>
        <Icon name="warning" size={13} className="mr-1.5 inline text-signal" />
        Failed
      </>
    );
  if (status === "pending")
    return (
      <>
        <span className="mr-1.5 inline-flex">
          <StatusDot state="in_review" />
        </span>
        Running
      </>
    );
  return <>{done}</>;
}

/** What has been made from a file to show it, without ever handing out the original. */
function Renditions({ details }: { details: FileDetails }) {
  const { renditions, pages, file } = details;
  const lines: string[] = renditions.map((r) =>
    [
      r.name,
      r.width && r.height ? `${r.width} × ${r.height}` : null,
      `${Math.round(r.bandwidth / 1000)} kb/s`,
      `${r.segments} encrypted segment${r.segments === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  if (pages) lines.push(`${pages.drawn} of ${pages.total} pages drawn, watermarked on render`);
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Renditions</Heading>
      {lines.length > 0 ? (
        lines.map((l) => (
          <span key={l} className="text-[13px] text-ink-2">
            {l}
          </span>
        ))
      ) : (
        <span className="text-[13px] text-ink-2">
          {file.streamStatus === "pending"
            ? "Being made"
            : file.streamStatus === "none"
              ? "None: this kind of file is not played or drawn"
              : "None yet"}
        </span>
      )}
      <span className="text-[12px] text-ink-3">
        The original never leaves storage except through a permitted, watermarked download.
      </span>
    </section>
  );
}

/** "Titles - English.srt" → "Titles - English": a first name for the player's menu. */
const captionNameOf = (fileName: string) => fileName.replace(/\.[^.]+$/, "").slice(0, 60);

/**
 * A video's captions from sidecar files (#146): which there are, and for whoever may upload,
 * adding one (named for the player's Frame menu) or removing one.
 */
function Captions({ fileId, canUpload }: { fileId: string; canUpload: boolean }) {
  const { data: captions = [] } = useQuery(captionsQuery(fileId));
  const { add, remove } = useCaptionMutations(fileId);
  const chooser = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const failure = add.error ?? remove.error;
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Captions</Heading>
      {captions.length === 0 && (
        <span className="text-[13px] text-ink-2">
          {canUpload
            ? "None. Add a SubRip, WebVTT or TTML file; the Frame menu shows it over the picture."
            : "None"}
        </span>
      )}
      <ul aria-label="Captions" className="m-0 flex list-none flex-col p-0">
        {captions.map((c) => (
          <li key={c.id} className="group flex min-h-7 items-center gap-2 text-[13px]">
            <span className="text-ink">{c.label}</span>
            <span className="min-w-0 flex-1 truncate text-ink-3" title={c.name}>
              {captionFormatNames[c.format]} · {c.cues.length} caption
              {c.cues.length === 1 ? "" : "s"}
            </span>
            {canUpload && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove the ${c.label} captions`}
                title="Remove"
                disabled={remove.isPending}
                onClick={() => remove.mutate(c.id)}
                className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              >
                <Icon name="close" size={13} />
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canUpload &&
        (chosen ? (
          <form
            aria-label="Add captions"
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              add.mutate(
                { file: chosen, label },
                {
                  onSuccess: () => {
                    setChosen(null);
                    setLabel("");
                  },
                },
              );
            }}
          >
            <span className="truncate text-[12px] text-ink-3" title={chosen.name}>
              {chosen.name}
            </span>
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                aria-label="Name in the Frame menu"
                placeholder="English"
                value={label}
                maxLength={60}
                onChange={(event) => setLabel(event.target.value)}
                className="min-w-0 flex-1"
              />
              <Button type="submit" size="sm" disabled={!label.trim() || add.isPending}>
                Add
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setChosen(null);
                  add.reset();
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="secondary" size="sm" onClick={() => chooser.current?.click()}>
              Add captions…
            </Button>
            <FileInput
              ref={chooser}
              accept=".srt,.vtt,.ttml,.dfxp,.xml"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                add.reset();
                setChosen(file);
                setLabel(captionNameOf(file.name));
              }}
            />
          </div>
        ))}
      {failure && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {failure.message}
        </p>
      )}
    </section>
  );
}

/** Where the file is used: versions of tracks, a take, reviews. */
function UsedIn({ details }: { details: FileDetails }) {
  const { versions, take, reviews } = details.usedIn;
  const empty = versions.length === 0 && !take && reviews.length === 0;
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Used in</Heading>
      {empty && <span className="text-[13px] text-ink-3">Nothing yet: a loose file.</span>}
      {versions.map((v) => (
        <Link
          key={`${v.trackId}-${v.number}`}
          to="/tracks/$trackId"
          params={{ trackId: v.trackId }}
          search={{ view: "versions" }}
          className="truncate text-[13px] text-ink-2 hover:text-ink"
        >
          {v.track} · V{v.number}
          {v.latest ? " (latest)" : ""} · {v.variation}
          {v.primary ? ", primary" : ""}
        </Link>
      ))}
      {take && (
        <Link
          to="/tracks/$trackId"
          params={{ trackId: take.trackId }}
          search={{ view: "takes" }}
          className="truncate text-[13px] text-ink-2 hover:text-ink"
        >
          {take.track} · Take {take.number}
          {take.label ? ` (${take.label})` : ""}
        </Link>
      )}
      {reviews.map((r) => (
        <Link
          key={r.id}
          to="/reviews/$reviewId"
          params={{ reviewId: r.id }}
          className="truncate text-[13px] text-ink-2 hover:text-ink"
        >
          {r.title}
          {r.status === "open" ? "" : ` (${r.status})`}
        </Link>
      ))}
    </section>
  );
}

/** This file's own access log, with the same action filter as the workspace's. */
function FileLog({ fileId }: { fileId: string }) {
  const [action, setAction] = useState("");
  const log = useInfiniteQuery(accessLogQuery({ fileId, ...(action ? { action } : {}) }));
  const events = log.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Heading>Access</Heading>
        <Select
          aria-label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="ml-auto h-7 w-40 text-[12px]"
        >
          <option value="">Every action</option>
          {Object.entries(actionCopy).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      {log.isPending ? (
        <span className="text-[12px] text-ink-3">Loading</span>
      ) : events.length === 0 ? (
        <span className="text-[12px] text-ink-3">Nothing logged yet.</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-2 text-[12px] text-ink-3">
              <span className="tabular w-[84px] shrink-0">
                {logTime.format(new Date(e.occurredAt))}
              </span>
              <span className="min-w-0 truncate text-ink-2">{e.actorLabel}</span>
              <span className="ml-auto shrink-0">{actionCopy[e.action] ?? e.action}</span>
            </li>
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          Show older
        </Button>
      )}
    </section>
  );
}

/**
 * A file's details, beside its page: what it is, where and how it is stored, what has been
 * made from it, where it is used, and (for owners and admins) who has had it. Those who
 * organise rename, move, attach and delete it from here; a file in a version or a review
 * stays (decision 027).
 */
export function FileDetailsSheet({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const { data: details, error } = useQuery(fileDetailsQuery(fileId));
  const projectId = details?.file.projectId ?? "";
  const { data: folders = [] } = useQuery({
    ...projectFoldersQuery(projectId),
    enabled: Boolean(details?.can.organise),
  });
  const { data: tracks = [] } = useQuery({
    ...projectTracksQuery(projectId),
    enabled: Boolean(details?.can.upload),
  });
  const organise = useOrganise(projectId);
  const trackMutations = useTrackMutations(projectId);
  const client = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<"rename" | "move" | "attach" | "delete" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !editing && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  const refresh = {
    onSuccess: () => {
      setEditing(null);
      void client.invalidateQueries({ queryKey: ["files", fileId] });
    },
  };
  const failure =
    organise.updateFile.error ??
    organise.deleteFile.error ??
    trackMutations.createVersion.error ??
    trackMutations.addVariation.error;

  return (
    <aside
      aria-label="Details"
      data-e2e-layer
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-[380px] flex-col border-l border-line bg-overlay shadow-4"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[14px] font-medium text-ink">Details</h2>
        <button
          type="button"
          aria-label="Close the details"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-4">
        {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
        {!details ? (
          !error && <p className="m-0 text-[13px] text-ink-3">Loading</p>
        ) : (
          <>
            <dl className="m-0 flex flex-col">
              <Property name="Name">
                <span title={details.file.name}>{details.file.name}</span>
              </Property>
              <Property name="Format">
                {mediaSummary(
                  details.file.kind,
                  details.file.mediaInfo,
                  details.file.streamStatus,
                ) ?? details.file.contentType}
              </Property>
              <Property name="Size">{formatBytes(details.file.byteSize)}</Property>
              <Property name="Checksum">
                {details.storage.sha256 ? (
                  <span className="tabular text-ink-2" title={details.storage.sha256}>
                    SHA-256 · {details.storage.sha256.slice(0, 4)}…
                    {details.storage.sha256.slice(-4)}
                  </span>
                ) : (
                  <span className="text-ink-3">Being worked out</span>
                )}
              </Property>
              <Property name="Uploaded">
                {details.file.uploadedBy && details.file.uploadedById ? (
                  <span className="inline-flex items-center gap-2">
                    <Avatar
                      id={details.file.uploadedById}
                      name={details.file.uploadedBy}
                      size={18}
                    />
                    {details.file.uploadedBy}, {dateTime.format(new Date(details.file.createdAt))}
                  </span>
                ) : (
                  dateTime.format(new Date(details.file.createdAt))
                )}
              </Property>
              <Property name="Storage">{details.storage.backend}</Property>
              <Property name="At rest">
                {details.storage.encrypted ? (
                  <span
                    title={
                      details.storage.keySince
                        ? `Workspace key ${details.storage.keyVersion}, in use since ${shortDate.format(new Date(details.storage.keySince))}`
                        : undefined
                    }
                  >
                    Encrypted · key {details.storage.keyVersion}
                  </span>
                ) : (
                  "Not encrypted"
                )}
              </Property>
              {(details.file.kind === "audio" || details.file.kind === "video") && (
                <Property name="Analysis">
                  <Stage
                    status={details.analysis.status}
                    done={
                      [
                        details.analysis.peaks && "Waveform",
                        details.analysis.loudness && "loudness",
                        details.analysis.spectrogram && "spectrogram",
                      ]
                        .filter(Boolean)
                        .join(", ") || "None"
                    }
                  />
                </Property>
              )}
            </dl>
            <Renditions details={details} />
            {details.file.kind === "video" && (
              <Captions fileId={fileId} canUpload={details.can.upload} />
            )}
            <UsedIn details={details} />
            {(details.can.organise || details.can.upload) && (
              <section className="flex flex-col gap-2">
                <Heading>Actions</Heading>
                {editing === "rename" ? (
                  <RenameForm
                    initial={details.file.name}
                    pending={organise.updateFile.isPending}
                    onSave={(name) => organise.updateFile.mutate({ id: fileId, name }, refresh)}
                    onCancel={() => setEditing(null)}
                  />
                ) : editing === "move" ? (
                  <MoveForm
                    options={destinations(folders, new Set())}
                    current={details.file.folderId}
                    pending={organise.updateFile.isPending}
                    onMove={(to) =>
                      organise.updateFile.mutate({ id: fileId, folderId: to }, refresh)
                    }
                    onCancel={() => setEditing(null)}
                  />
                ) : editing === "attach" ? (
                  <AttachForm
                    file={details.file}
                    tracks={tracks}
                    pending={
                      trackMutations.createVersion.isPending ||
                      trackMutations.addVariation.isPending
                    }
                    onAttach={(track, as, name) => {
                      const latest = track.versions.at(-1);
                      if (as === "variation" && latest)
                        trackMutations.addVariation.mutate(
                          { versionId: latest.id, fileId, name },
                          refresh,
                        );
                      else
                        trackMutations.createVersion.mutate(
                          { trackId: track.id, variations: [{ fileId, name }] },
                          refresh,
                        );
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : editing === "delete" ? (
                  <span className="flex flex-wrap items-center gap-2" role="alert">
                    <span className="text-[13px] text-ink-2">
                      Delete {details.file.name}? This cannot be undone.
                    </span>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={organise.deleteFile.isPending}
                      onClick={() =>
                        organise.deleteFile.mutate(fileId, {
                          onSuccess: () =>
                            void navigate({
                              to: "/projects/$projectId/files",
                              params: { projectId },
                            }),
                        })
                      }
                    >
                      Delete
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {details.can.organise && (
                      <>
                        <Button size="sm" variant="secondary" onClick={() => setEditing("rename")}>
                          Rename
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditing("move")}>
                          Move…
                        </Button>
                      </>
                    )}
                    {details.can.upload &&
                      details.usedIn.versions.length === 0 &&
                      tracks.length > 0 && (
                        <Button size="sm" variant="secondary" onClick={() => setEditing("attach")}>
                          Attach to a track…
                        </Button>
                      )}
                    {details.can.organise && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!details.can.delete}
                        onClick={() => setEditing("delete")}
                      >
                        Delete…
                      </Button>
                    )}
                  </div>
                )}
                {details.can.organise && !details.can.delete && (
                  <span className="text-[12px] text-ink-3">
                    A file in a version or a review stays, so what reviewers were asked about stays
                    on the record.
                  </span>
                )}
                {failure && <p className="m-0 text-[12px] text-signal">{failure.message}</p>}
              </section>
            )}
            {details.can.log && <FileLog fileId={fileId} />}
          </>
        )}
      </div>
    </aside>
  );
}
