import {
  type CarryChoice,
  formatAnchor,
  isPdf,
  profileFor,
  variationNameFrom,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import {
  ApiError,
  carryQuery,
  customProfilesQuery,
  type Project,
  type ProjectFile,
  projectFilesQuery,
  projectTracksQuery,
  type Track,
  useProjectCan,
  useTrackMutations,
  type Version,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { uploadFile } from "~/lib/upload";
import { Avatar } from "./avatar";
import { Empty } from "./empty";
import { kindIcon, mediaSummary } from "./files";
import { Icon } from "./icons";
import { Card } from "./page";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import { Checkbox, Radio } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { FileInput, Input, Select, Textarea } from "./ui/input";
import { ActionMenu, Dropdown, type MenuAction } from "./ui/menu";

const whenFormat = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const carryWords: Record<CarryChoice, string> = {
  open: "Carry over",
  hidden: "Carry, hidden",
  fixed: "Fixed",
  wont_fix: "Won't fix",
};

/** The file a version opens with: its primary variation. */
export const primaryOf = (version: Version) =>
  version.variations.find((v) => v.isPrimary) ?? version.variations[0];

/** A file of a version being made: uploading from this computer, or already in the project. */
interface Pick {
  key: string;
  name: string;
  fileId: string | null;
  /** Bytes sent, out of the total, while uploading. */
  progress: number;
  error: string | null;
  variation: string;
}

/**
 * Files chosen for a version, a variation or a replacement: dropped or chosen from this
 * computer (uploaded into the track's folder at once) or picked from the project's loose
 * files. Each becomes ready once the project holds it.
 */
function useFilePicks(track: Track) {
  const [picks, setPicks] = useState<Pick[]>([]);
  const update = (key: string, change: Partial<Pick>) =>
    setPicks((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  const upload = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Math.random()}`;
      setPicks((list) => [
        ...list,
        {
          key,
          name: file.name,
          fileId: null,
          progress: 0,
          error: null,
          variation: variationNameFrom(file.name, track.name),
        },
      ]);
      uploadFile(file, {
        projectId: track.projectId,
        folderId: track.folderId,
        signal: new AbortController().signal,
        onProgress: (p) => update(key, { progress: p.total ? p.sent / p.total : 0 }),
      })
        .then((done) => update(key, { fileId: done.id, progress: 1 }))
        .catch((error: unknown) =>
          update(key, { error: error instanceof Error ? error.message : "Upload failed" }),
        );
    }
  };
  const add = (file: ProjectFile) =>
    setPicks((list) =>
      list.some((p) => p.fileId === file.id)
        ? list
        : [
            ...list,
            {
              key: file.id,
              name: file.name,
              fileId: file.id,
              progress: 1,
              error: null,
              variation: variationNameFrom(file.name, track.name),
            },
          ],
    );
  const remove = (key: string) => setPicks((list) => list.filter((p) => p.key !== key));
  const rename = (key: string, variation: string) => update(key, { variation });
  const busy = picks.some((p) => !p.fileId && !p.error);
  return { picks, upload, add, remove, rename, busy, clear: () => setPicks([]) };
}

/** Audio and video in the project that no version uses yet: what can become a variation. */
function useLooseMedia(track: Track) {
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(track.projectId));
  const used = new Set(
    tracks.flatMap((t) => t.versions.flatMap((v) => v.variations.map((x) => x.fileId))),
  );
  return files.filter((f) => (f.kind === "audio" || f.kind === "video") && !used.has(f.id));
}

/** The place files are dropped or chosen, with the project's loose files one menu away. */
function DropZone({
  hint,
  accept,
  multiple = true,
  onFiles,
  loose,
  onLoose,
  children,
}: {
  hint: string;
  accept?: string;
  multiple?: boolean;
  onFiles: (files: FileList) => void;
  loose: ProjectFile[];
  onLoose: (file: ProjectFile) => void;
  children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    if (event.dataTransfer.files.length) onFiles(event.dataTransfer.files);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping is a shortcut; the buttons do the same.
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      className={cn(
        "flex flex-col gap-2 rounded-panel border border-dashed p-4 transition-colors",
        over ? "border-ink-3 bg-raised/40" : "border-edge",
      )}
    >
      <p className="text-[14px] text-ink-2">{hint}</p>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => input.current?.click()}>
          <Icon name="upload" size={13} />
          Choose files
        </Button>
        {loose.length > 0 && (
          <Dropdown
            size="sm"
            value="From the project"
            actions={loose.map((f) => ({
              label: f.name,
              icon: <Icon name={kindIcon[f.kind]} size={13} />,
              onSelect: () => onLoose(f),
            }))}
          />
        )}
      </div>
      <FileInput
        ref={input}
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function PickState({ pick }: { pick: Pick }) {
  if (pick.error) return <span className="text-[12px] text-signal">{pick.error}</span>;
  if (!pick.fileId)
    return (
      <span className="tabular text-[12px] text-ink-3">{Math.round(pick.progress * 100)}%</span>
    );
  return null;
}

/**
 * The next version of a track (#131): its files, each a variation with one primary, what
 * changed, an edit decision list, and the threads the last version leaves open, each to
 * carry over, hide or settle. The project's checks answer before it lands; a refusal says
 * why, and someone who may edit workflows can let it through.
 */
function NewVersion({
  track,
  project,
  onClose,
}: {
  track: Track;
  project: Project;
  onClose: () => void;
}) {
  const can = useProjectCan(track.projectId);
  const { createVersion } = useTrackMutations(track.projectId);
  const { data: carry = [] } = useQuery(carryQuery(track.id));
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const loose = useLooseMedia(track);
  const media = useFilePicks(track);
  const edl = useFilePicks(track);
  const [primary, setPrimary] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [choices, setChoices] = useState<Record<string, CarryChoice>>({});
  const next = (track.versions.at(-1)?.number ?? 0) + 1;
  const ready = media.picks.filter((p) => p.fileId);
  const edlFile = edl.picks.find((p) => p.fileId);
  const edlLoose = files.filter((f) => /\.edl$/i.test(f.name));
  const primaryKey = primary ?? ready[0]?.key;
  const error = createVersion.error;
  const refused = error instanceof ApiError && error.code === "version_refused";
  const measuring = error instanceof ApiError && error.code === "version_measuring";

  const send = (letThrough = false) =>
    createVersion.mutate(
      {
        trackId: track.id,
        notes: notes.trim() || undefined,
        variations: ready.map((p) => ({
          fileId: p.fileId as string,
          name: p.variation.trim() || "Main",
          primary: p.key === primaryKey,
        })),
        carry: Object.keys(choices).length ? choices : undefined,
        edlFileId: edlFile?.fileId ?? undefined,
        letThrough: letThrough || undefined,
      },
      { onSuccess: onClose },
    );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready.length > 0 && !media.busy) send();
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`Version ${next}`}
      className="rise-in flex flex-col gap-5 rounded-panel-lg border border-line bg-raised/40 p-5 shadow-1"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-medium">Version {next}</h2>
        <span className="text-[13px] text-ink-3">
          A new edit is a new version, never a replacement.
        </span>
      </div>
      <DropZone
        hint="Drop the files of this version here, or choose them. One file per variation."
        accept="audio/*,video/*"
        onFiles={media.upload}
        loose={loose.filter((f) => !media.picks.some((p) => p.fileId === f.id))}
        onLoose={media.add}
      >
        {media.picks.length > 0 && (
          <ul aria-label="Files of this version" className="flex flex-col gap-1">
            {media.picks.map((p) => (
              <li
                key={p.key}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-control bg-ground px-3 py-2 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_auto_auto]"
              >
                <Icon name="music" className="text-ink-3" />
                <span className="min-w-0 truncate text-[14px] text-ink">{p.name}</span>
                <span className="@3xl/app:hidden">
                  <PickState pick={p} />
                </span>
                <Input
                  size="sm"
                  value={p.variation}
                  onChange={(e) => media.rename(p.key, e.target.value)}
                  aria-label={`Variation name for ${p.name}`}
                  className="col-span-2 @3xl/app:col-span-1"
                />
                <span className="flex items-center gap-3">
                  <span className="hidden @3xl/app:inline">
                    <PickState pick={p} />
                  </span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink-2">
                    <Radio
                      name="primary"
                      checked={p.key === primaryKey}
                      disabled={!p.fileId}
                      onChange={() => setPrimary(p.key)}
                    />
                    Primary
                  </label>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    aria-label={`Remove ${p.name}`}
                    onClick={() => media.remove(p.key)}
                  >
                    <Icon name="close" size={12} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DropZone>
      {(refused || measuring) && (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-panel border border-signal/50 bg-signal/10 px-3 py-2 text-[14px] text-ink"
        >
          <p className="flex items-start gap-2">
            <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
            <span>{error.message}</span>
          </p>
          <div className="flex gap-2 pl-6">
            {measuring && (
              <Button variant="secondary" size="sm" onClick={() => send()}>
                Try again
              </Button>
            )}
            {refused && can("edit_workflows") && (
              <Button variant="secondary" size="sm" onClick={() => send(true)}>
                Let it through
              </Button>
            )}
          </div>
        </div>
      )}
      {error && !refused && !measuring && (
        <p role="alert" className="text-[13px] text-signal">
          {error.message}
        </p>
      )}
      <Field label="What changed">
        <Textarea
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Pedal noise cleaned at bar 5; tighter join at 17."
        />
      </Field>
      {carry.length > 0 && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="mb-1 text-[14px] text-ink-2">
            The {carry.length} open {carry.length === 1 ? "comment" : "comments"} from V{next - 1}
            <span className="block text-[13px] text-ink-3">
              Each carries over unless you say otherwise. Anchors follow the music once the versions
              are aligned; you can move any by hand.
            </span>
          </legend>
          <ul className="flex flex-col">
            {carry.map((t) => (
              <li
                key={t.commentId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{t.body}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {[
                      t.authorName,
                      t.variation,
                      t.anchor ? formatAnchor(t.anchor).replace(/(^|\s)0(\d:)/g, "$1$2") : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <Select
                  size="sm"
                  value={choices[t.commentId] ?? "open"}
                  onChange={(e) =>
                    setChoices({ ...choices, [t.commentId]: e.target.value as CarryChoice })
                  }
                  aria-label={`What becomes of "${t.body}"`}
                  className="w-36"
                >
                  {(Object.keys(carryWords) as CarryChoice[]).map((c) => (
                    <option key={c} value={c}>
                      {carryWords[c]}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-[14px] text-ink-2">Edit decision list</span>
        {edlFile ? (
          <span className="flex items-center gap-2 text-[14px] text-ink">
            <Icon name="file" size={14} className="text-ink-3" />
            {edlFile.name}
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="Remove the edit decision list"
              onClick={edl.clear}
            >
              <Icon name="close" size={12} />
            </Button>
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <EdlChooser
              busy={edl.busy}
              onFiles={(f) => {
                edl.clear();
                edl.upload(f);
              }}
            />
            {edlLoose.length > 0 && (
              <Dropdown
                size="sm"
                value="From the project"
                actions={edlLoose.map((f) => ({
                  label: f.name,
                  onSelect: () => {
                    edl.clear();
                    edl.add(f);
                  },
                }))}
              />
            )}
            <span className="text-[13px] text-ink-3">
              CMX 3600, Pyramix or Sequoia.{" "}
              {project.requireEdl ? "This project asks for one." : "Optional here."}
            </span>
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={ready.length === 0 || media.busy || edl.busy || createVersion.isPending}
        >
          Add version {next}
        </Button>
      </div>
    </form>
  );
}

function EdlChooser({ busy, onFiles }: { busy: boolean; onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Attaching" : "Attach EDL"}
      </Button>
      <FileInput
        ref={input}
        accept=".edl"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );
}

/**
 * Another variation of a version, or a corrected file in place of one: dropped, chosen or
 * picked from the project's loose files.
 */
function VariationDialog({
  track,
  version,
  mode,
  onClose,
}: {
  track: Track;
  version: Version;
  mode: "add" | "replace";
  onClose: () => void;
}) {
  const { addVariation, replaceFile } = useTrackMutations(track.projectId);
  const loose = useLooseMedia(track);
  const pick = useFilePicks(track);
  const [primary, setPrimary] = useState(false);
  const [target, setTarget] = useState(primaryOf(version)?.id ?? "");
  const chosen = pick.picks.at(-1);
  const mutation = mode === "add" ? addVariation : replaceFile;
  const replacing = version.variations.find((v) => v.id === target);
  const save = () => {
    if (!chosen?.fileId) return;
    if (mode === "add") {
      addVariation.mutate(
        {
          versionId: version.id,
          fileId: chosen.fileId,
          name: chosen.variation.trim() || "Main",
          primary,
        },
        { onSuccess: onClose },
      );
    } else {
      replaceFile.mutate({ variationId: target, fileId: chosen.fileId }, { onSuccess: onClose });
    }
  };
  return (
    <Dialog
      title={
        mode === "add"
          ? `Add a variation to V${version.number}`
          : `Replace a file of V${version.number}`
      }
      description={
        mode === "add"
          ? "Another treatment of the same edit, such as a wet mix beside the dry one."
          : "A corrected export in its place. Its comments move to the new file; the old one stays in the project."
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!chosen?.fileId || mutation.isPending} onClick={save}>
            {mode === "add" ? "Add variation" : "Replace"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {mode === "replace" && version.variations.length > 1 && (
          <Field label="Variation">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {version.variations.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.fileName}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {mode === "replace" && replacing && version.variations.length === 1 && (
          <p className="text-[13px] text-ink-3">In place of {replacing.fileName}.</p>
        )}
        <DropZone
          hint="Drop the file here, or choose it."
          accept="audio/*,video/*"
          multiple={false}
          onFiles={(f) => {
            pick.clear();
            pick.upload(f);
          }}
          loose={loose}
          onLoose={(f) => {
            pick.clear();
            pick.add(f);
          }}
        >
          {chosen && (
            <p className="flex items-center gap-2 text-[14px] text-ink">
              <Icon name="music" size={14} className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate">{chosen.name}</span>
              <PickState pick={chosen} />
            </p>
          )}
        </DropZone>
        {mode === "add" && chosen && (
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Name" className="w-48">
              <Input
                value={chosen.variation}
                onChange={(e) => pick.rename(chosen.key, e.target.value)}
              />
            </Field>
            <label className="flex h-9 cursor-pointer items-center gap-2 text-[14px] text-ink-2">
              <Checkbox checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
              Make it the primary
            </label>
          </div>
        )}
        {mutation.error && (
          <p role="alert" className="text-[13px] text-signal">
            {mutation.error.message}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function VersionRow({
  track,
  version,
  latest,
  files,
}: {
  track: Track;
  version: Version;
  latest: boolean;
  files: Map<string, ProjectFile>;
}) {
  const can = useProjectCan(track.projectId);
  const { makePrimary } = useTrackMutations(track.projectId);
  const [dialog, setDialog] = useState<"add" | "replace" | null>(null);
  const pending = version.variations.some((v) => v.streamStatus === "pending");
  const failed = version.variations.some((v) => v.streamStatus === "failed");
  const actions: MenuAction[] = [
    ...(can("upload") ? [{ label: "Add a variation…", onSelect: () => setDialog("add") }] : []),
    ...(can("organise")
      ? [
          { label: "Replace a file…", onSelect: () => setDialog("replace") },
          ...version.variations
            .filter((v) => !v.isPrimary)
            .map((v) => ({
              label: `Make ${v.name} the primary`,
              onSelect: () => makePrimary.mutate(v.id),
            })),
        ]
      : []),
  ];
  return (
    <li className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular text-[15px] font-medium text-ink">V{version.number}</span>
        {latest && <span className="label">latest</span>}
        {(pending || failed) && (
          <span className="flex items-center gap-2 text-[13px] text-ink-2">
            <span
              aria-hidden="true"
              className={cn("size-1.5 rounded-full", failed ? "bg-signal" : "bg-ink-3")}
            />
            {failed ? "Could not be analysed" : "Analysing"}
          </span>
        )}
        <span className="ml-auto flex min-w-0 items-center gap-2 text-[13px] text-ink-3">
          {version.createdByName && (
            <Avatar id={version.createdByName} name={version.createdByName} size={18} />
          )}
          <span className="truncate">
            {version.createdByName ?? "A former member"} ·{" "}
            {whenFormat.format(new Date(version.createdAt))}
          </span>
          {version.edlFileId && (
            <Link
              to="/files/$fileId"
              params={{ fileId: version.edlFileId }}
              className="no-underline"
              title="The edit decision list"
            >
              <Chip>EDL</Chip>
            </Link>
          )}
          {version.letThroughBy && (
            <Chip title="Let in past the project's checks">let through</Chip>
          )}
          {actions.length > 0 && (
            <ActionMenu always label={`V${version.number}`} actions={actions} />
          )}
        </span>
      </div>
      {version.notes && <p className="text-[14px] text-ink-2">{version.notes}</p>}
      {failed && (
        <p className="flex items-start gap-2 text-[14px] text-ink-2">
          <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
          <span>
            A file of this version could not be read. Re-export it and replace the file.
            {can("organise") && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-1 align-baseline"
                onClick={() => setDialog("replace")}
              >
                Replace file
              </Button>
            )}
          </span>
        </p>
      )}
      <ul className="flex flex-wrap gap-2">
        {version.variations.map((v) => {
          const file = files.get(v.fileId);
          const open = file?.openComments ?? 0;
          const facts =
            v.streamStatus === "pending"
              ? "analysing"
              : v.streamStatus === "failed"
                ? "failed"
                : [
                    file ? mediaSummary(file.kind, file.mediaInfo) : "",
                    open > 0 ? `${open} ${open === 1 ? "comment" : "comments"}` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
          return (
            <li key={v.id} className="min-w-0">
              <Link
                to="/files/$fileId"
                params={{ fileId: v.fileId }}
                title={v.fileName}
                className={cn(
                  "flex min-w-0 items-center gap-3 rounded-panel border px-3 py-2 no-underline transition-colors hover:border-edge",
                  v.isPrimary ? "border-edge bg-raised shadow-1" : "border-line bg-ground",
                )}
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-ground">
                  <Icon name="play" size={12} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] text-ink">
                    {v.name}
                    {v.isPrimary && <span className="text-ink-3"> · primary</span>}
                  </span>
                  {facts && (
                    <span className="tabular truncate text-[12px] text-ink-3">{facts}</span>
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {dialog && (
        <VariationDialog
          track={track}
          version={version}
          mode={dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </li>
  );
}

/** The score beside the track's recordings: a link to it, or choosing one for those who may. */
function ScoreChoice({ track, canEdit }: { track: Track; canEdit: boolean }) {
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const { updateTrack } = useTrackMutations(track.projectId);
  const scores = files.filter((f) => isPdf(f.name, f.contentType));
  const linked = scores.find((f) => f.id === track.scoreFileId);
  const choose = (id: string | null) => updateTrack.mutate({ id: track.id, scoreFileId: id });
  if (linked) {
    return (
      <span className="flex items-center gap-1">
        <Link
          to="/files/$fileId"
          params={{ fileId: linked.id }}
          className="flex items-center gap-1.5 text-ink-2 hover:text-ink"
        >
          <Icon name="score" size={14} />
          {linked.name}
        </Link>
        {canEdit && (
          <ActionMenu
            always
            label="the score"
            actions={[
              ...scores
                .filter((f) => f.id !== linked.id)
                .map((f) => ({ label: `Use ${f.name}`, onSelect: () => choose(f.id) })),
              { label: "Unlink the score", onSelect: () => choose(null) },
            ]}
          />
        )}
      </span>
    );
  }
  if (!canEdit) return null;
  return scores.length > 0 ? (
    <Dropdown
      size="sm"
      value={
        <>
          <Icon name="plus" size={12} /> Link a score
        </>
      }
      actions={scores.map((f) => ({ label: f.name, onSelect: () => choose(f.id) }))}
    />
  ) : (
    <span>No score: upload its PDF to link one</span>
  );
}

/**
 * A track's versions (#131), newest first: who added each and when, its note, its
 * variations with the primary marked, and adding the next. The track itself opens in the
 * player on its latest version; this page is one step from there.
 */
export function TrackVersions({
  track,
  project,
  adding,
  onAdding,
}: {
  track: Track;
  project: Project;
  adding: boolean;
  onAdding: (adding: boolean) => void;
}) {
  const can = useProjectCan(track.projectId);
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const byId = new Map(files.map((f) => [f.id, f]));
  const newest = [...track.versions].reverse();
  const latest = newest[0];
  const open = track.versions
    .flatMap((v) => v.variations)
    .reduce((n, v) => n + (byId.get(v.fileId)?.openComments ?? 0), 0);
  // The track's own profile, else the project's or the workspace's (#144).
  const { data: customs = [] } = useQuery(customProfilesQuery);
  const { data: workspace } = useQuery(workspaceSettingsQuery);
  const profile = profileFor(
    track.deliveryProfile ?? project.deliveryProfile ?? workspace?.deliveryProfile,
    customs,
  );
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[22px] font-medium tracking-tight text-ink">{track.name}</h1>
        <p className="mt-1 text-[13px] text-ink-3">
          {newest.length} {newest.length === 1 ? "version" : "versions"}
          {latest && primaryOf(latest) && (
            <>
              {" · "}
              <Link
                to="/files/$fileId"
                params={{ fileId: primaryOf(latest)?.fileId ?? "" }}
                className="text-ink-2 hover:text-ink"
              >
                open V{latest.number} in the player
              </Link>
            </>
          )}
        </p>
      </div>
      {adding && <NewVersion track={track} project={project} onClose={() => onAdding(false)} />}
      {newest.length === 0 ? (
        !adding && (
          <Empty
            title="No versions yet"
            text="Upload the first version of this track. Each later edit becomes the next version, and comments carry across."
            action={
              can("upload") ? (
                <Button variant="primary" onClick={() => onAdding(true)}>
                  Add version 1
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
            <ScoreChoice track={track} canEdit={can("organise")} />
            <span>
              {open} open {open === 1 ? "comment" : "comments"}
            </span>
            {profile && <span>Delivery: {profile.label}</span>}
          </div>
          <Card>
            <ul aria-label="Versions">
              {newest.map((v) => (
                <VersionRow
                  key={v.id}
                  track={track}
                  version={v}
                  latest={v.id === latest?.id}
                  files={byId}
                />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
