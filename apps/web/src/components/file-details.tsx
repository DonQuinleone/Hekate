import {
  type CaptionKind,
  captionFormatNames,
  captionFormatOf,
  captionFormats,
  captionKindNames,
  captionKindOf,
  captionKinds,
  captionLanguageOf,
  commonCaptionLanguages,
  defaultCaptionLabel,
  formatBytes,
  languageName,
} from "@hekate/shared";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { actionCopy } from "~/lib/access-log";
import { formatDates } from "~/lib/locale";
import {
  accessLogQuery,
  captionsQuery,
  downloadsQuery,
  exportCaptions,
  type FileDetails,
  fileDetailsQuery,
  projectFoldersQuery,
  projectTracksQuery,
  useCaptionMutations,
  useOrganise,
  useTrackMutations,
} from "~/lib/queries";
import { Avatar } from "./avatar";
import { Checksum } from "./checksum";
import { AttachForm, destinations, MoveForm, RenameForm } from "./file-forms";
import { mediaSummary } from "./files";
import { Icon } from "./icons";
import { Property } from "./property";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { FileInput, Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { Segmented } from "./ui/segmented";
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
  if (details.filmstrip) lines.push(`Filmstrip, ${details.filmstrip} frames`);
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

/** What a track is called, its language and what it is for, as the form holds them. */
interface TrackFields {
  label: string;
  language: string | null;
  kind: CaptionKind;
}

/**
 * A caption track's name, language and kind (#201): asked when it is added, with what the
 * file says of itself filled in, and again when it is renamed. The name follows the language
 * and kind until it is typed over.
 */
function TrackForm({
  title,
  initial,
  file,
  submit,
  pending,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: TrackFields;
  /** The sidecar being added, named above the fields. */
  file?: File;
  submit: string;
  pending: boolean;
  onSubmit: (fields: TrackFields) => void;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState(initial);
  const [named, setNamed] = useState(
    initial.label !== defaultCaptionLabel(initial.language, initial.kind),
  );
  const set = (change: Partial<TrackFields>) =>
    setFields((f) => {
      const next = { ...f, ...change };
      return named ? next : { ...next, label: defaultCaptionLabel(next.language, next.kind) };
    });
  // The common languages, and the track's own where it is another.
  const languages: readonly string[] =
    fields.language && !commonCaptionLanguages.some((l) => l === fields.language)
      ? [fields.language, ...commonCaptionLanguages]
      : commonCaptionLanguages;
  return (
    <form
      aria-label={title}
      className="flex flex-col gap-3 rounded-panel border border-hairline p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(fields);
      }}
    >
      {file && (
        <span className="flex min-w-0 items-center gap-2 text-[13px]">
          <Icon name="file" size={14} className="shrink-0 text-ink-3" />
          <span className="min-w-0 truncate text-ink" title={file.name}>
            {file.name}
          </span>
        </span>
      )}
      <Field label="Language">
        <Select
          size="sm"
          value={fields.language ?? ""}
          onChange={(event) => set({ language: event.target.value || null })}
        >
          <option value="">Not said</option>
          {languages.map((tag) => (
            <option key={tag} value={tag}>
              {languageName(tag) ?? tag}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
        <span aria-hidden="true">For</span>
        <Segmented
          label="What the track is for"
          value={fields.kind}
          onChange={(kind) => set({ kind })}
          options={captionKinds.map((k) => ({ value: k, label: captionKindNames[k] }))}
          className="self-start"
        />
        <span className="text-[12px] text-ink-3">
          {fields.kind === "subtitles"
            ? "The words, for viewers who hear them."
            : "The words and the sounds, for viewers who are deaf or hard of hearing."}
        </span>
      </div>
      <Field label="Name in the Captions menu">
        <Input
          size="sm"
          value={fields.label}
          maxLength={60}
          onChange={(event) => {
            setNamed(true);
            setFields((f) => ({ ...f, label: event.target.value }));
          }}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!fields.label.trim() || pending}>
          {submit}
        </Button>
      </div>
    </form>
  );
}

/**
 * A video's or a recording's caption tracks (#146, #201): which there are, each with what it
 * is for and the format it came as; for whoever may download, exporting one as SubRip, WebVTT
 * or TTML; for whoever may upload, adding one from a sidecar, renaming or removing one.
 */
function Captions({
  fileId,
  canUpload,
  canExport,
}: {
  fileId: string;
  canUpload: boolean;
  canExport: boolean;
}) {
  const { data: captions = [] } = useQuery(captionsQuery(fileId));
  const { add, update, remove } = useCaptionMutations(fileId);
  const chooser = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<{ file: File; initial: TrackFields } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const failure = add.error ?? update.error ?? remove.error;
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Captions</Heading>
      {captions.length === 0 && (
        <span className="text-[13px] text-ink-2">
          {canUpload
            ? "None yet. Add SubRip, WebVTT or TTML files: each is a track in the player's Captions menu and a transcript beside the comments."
            : "None"}
        </span>
      )}
      <ul aria-label="Captions" className="m-0 flex list-none flex-col p-0">
        {captions.map((c) =>
          renaming === c.id ? (
            <li key={c.id}>
              <TrackForm
                title={`Rename the ${c.label} captions`}
                initial={{ label: c.label, language: c.language, kind: c.kind }}
                submit="Save"
                pending={update.isPending}
                onSubmit={(fields) =>
                  update.mutate(
                    { captionId: c.id, ...fields },
                    { onSuccess: () => setRenaming(null) },
                  )
                }
                onCancel={() => {
                  setRenaming(null);
                  update.reset();
                }}
              />
            </li>
          ) : (
            <li key={c.id} className="group flex min-h-8 items-center gap-2 text-[13px]">
              <span className="shrink-0 text-ink">{c.label}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3" title={c.name}>
                {captionKindNames[c.kind]} · {captionFormatNames[c.format]} · {c.cues.length}{" "}
                {c.cues.length === 1 ? "caption" : "captions"}
              </span>
              {(canUpload || canExport) && (
                <ActionMenu
                  label={`the ${c.label} captions`}
                  actions={[
                    ...(canUpload ? [{ label: "Rename…", onSelect: () => setRenaming(c.id) }] : []),
                    ...(canExport
                      ? captionFormats.map((f) => ({
                          label: `Export as ${captionFormatNames[f]} (.${f})`,
                          onSelect: () => exportCaptions(fileId, c.id, f),
                        }))
                      : []),
                    ...(canUpload
                      ? [
                          "divider" as const,
                          {
                            label: "Remove",
                            danger: true,
                            onSelect: () => remove.mutate(c.id),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </li>
          ),
        )}
      </ul>
      {canUpload &&
        (chosen ? (
          <TrackForm
            key={chosen.file.name}
            title="Add captions"
            file={chosen.file}
            initial={chosen.initial}
            submit="Add captions"
            pending={add.isPending}
            onSubmit={(fields) =>
              add.mutate({ file: chosen.file, ...fields }, { onSuccess: () => setChosen(null) })
            }
            onCancel={() => {
              setChosen(null);
              add.reset();
            }}
          />
        ) : (
          <div>
            <Button variant="secondary" size="sm" onClick={() => chooser.current?.click()}>
              Add captions…
            </Button>
            <FileInput
              ref={chooser}
              accept=".srt,.vtt,.ttml,.dfxp,.xml"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                add.reset();
                // What the file says of itself fills the form in: its language and kind.
                const head = await file.slice(0, 4096).text();
                const format = captionFormatOf(file.name, head);
                const language = format ? captionLanguageOf(file.name, head, format) : null;
                const kind = captionKindOf(file.name) ?? "subtitles";
                setChosen({
                  file,
                  initial: { language, kind, label: defaultCaptionLabel(language, kind) },
                });
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
  // Whether this member may download from the file: who may export its caption tracks.
  const { data: downloads } = useQuery(downloadsQuery(fileId));
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
                <Checksum sha256={details.storage.sha256} />
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
            {(details.file.kind === "video" || details.file.kind === "audio") && (
              <Captions
                fileId={fileId}
                canUpload={details.can.upload}
                canExport={downloads !== undefined && downloads.level !== "none"}
              />
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
