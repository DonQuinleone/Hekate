import {
  type CarryChoice,
  capital,
  formatAnchor,
  isPdf,
  profileFor,
  renditionTraits,
  restartPoints,
  variantNameFrom,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import type { Picked } from "~/lib/picked-files";
import {
  carryQuery,
  customProfilesQuery,
  type Project,
  type ProjectFile,
  projectFilesQuery,
  projectWorkflowsQuery,
  type Track,
  trackStandingQuery,
  useItemWords,
  useProjectCan,
  useProjectTool,
  useTrackMutations,
  type Version,
  workspaceSettingsQuery,
} from "~/lib/queries";
import { swappedSummary } from "~/lib/score-swap";
import { type UploadedFile, uploadFile } from "~/lib/upload";
import { primaryOf } from "~/lib/versions";
import { Avatar } from "./avatar";
import { Empty } from "./empty";
import { kindIcon, mediaSummary } from "./files";
import { Icon } from "./icons";
import { Card } from "./page";
import { ShareDialog } from "./share";
import { Button } from "./ui/button";
import { Chip } from "./ui/chip";
import { Radio } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { FileInput, Input, Select, Textarea } from "./ui/input";
import { ActionMenu, Dropdown, type MenuAction } from "./ui/menu";
import { ReviewerDot } from "./ui/status";
import { type ChosenFile, UploadDialog } from "./ui/upload-dialog";
import { useLooseMedia, VariantDialog } from "./variant-dialog";
import { letThrough, versionProblem } from "./version-problem";
import { WorkflowHistory } from "./workflow-history";

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

/** The edit decision list of a version being made: uploading, or already in the project. */
interface Pick {
  key: string;
  name: string;
  fileId: string | null;
  error: string | null;
}

/**
 * The edit decision list chosen for a new version (its media goes through the upload
 * dialog): chosen from this computer and uploaded into the track's folder at once, or picked
 * from the project's lists. Ready once the project holds it.
 */
function useEdlPick(track: Track) {
  const [picks, setPicks] = useState<Pick[]>([]);
  const update = (key: string, change: Partial<Pick>) =>
    setPicks((list) => list.map((p) => (p.key === key ? { ...p, ...change } : p)));
  const upload = (files: FileList | File[]) => {
    const file = Array.from(files)[0];
    if (!file) return;
    const key = `${file.name}:${file.size}:${Math.random()}`;
    setPicks([{ key, name: file.name, fileId: null, error: null }]);
    uploadFile(file, {
      projectId: track.projectId,
      folderId: track.folderId,
      signal: new AbortController().signal,
      onProgress: () => {},
    })
      .then((done) => update(key, { fileId: done.id }))
      .catch((error: unknown) =>
        update(key, { error: error instanceof Error ? error.message : "Upload failed" }),
      );
  };
  const add = (file: ProjectFile) =>
    setPicks([{ key: file.id, name: file.name, fileId: file.id, error: null }]);
  const busy = picks.some((p) => !p.fileId && !p.error);
  return { picks, upload, add, busy, clear: () => setPicks([]) };
}

/**
 * The next version of a track (#131): its files, each a variant with one primary, what
 * changed, an edit decision list, and the threads the last version leaves open, each to
 * carry over, hide or settle. The files are uploaded when the version is added; the
 * project's checks answer before it lands, a refusal says why, and someone who may edit
 * workflows can let it through.
 */
function NewVersion({
  track,
  project,
  initial,
  onClose,
}: {
  track: Track;
  project: Project;
  /** Files dropped on the track's page, which opened this. */
  initial?: Picked[] | undefined;
  onClose: () => void;
}) {
  const can = useProjectCan(track.projectId);
  const { words, video } = useItemWords(track.projectId);
  const { createVersion } = useTrackMutations(track.projectId);
  const { data: carry = [] } = useQuery(carryQuery(track.id));
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const loose = useLooseMedia(track);
  const edl = useEdlPick(track);
  const [chosen, setChosen] = useState<ChosenFile<UploadedFile>[]>([]);
  /** Each file's variant name as typed; until then, read from the file's name. */
  const [names, setNames] = useState<Record<string, string>>({});
  const nameOf = (c: ChosenFile<UploadedFile>) =>
    names[c.key] ?? variantNameFrom(c.name, track.name);
  const [primary, setPrimary] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [choices, setChoices] = useState<Record<string, CarryChoice>>({});
  // Where its workflow starts again from (#25), for those who edit workflows: by default it
  // carries on where it is. The track's own workflows where it has any, else the project's.
  const mayRestart = can("edit_workflows");
  const { data: flows = [] } = useQuery({
    ...projectWorkflowsQuery(track.projectId),
    enabled: mayRestart,
  });
  const own = flows.filter((w) => w.active && w.trackId === track.id);
  const running = own.length > 0 ? own : flows.filter((w) => w.active && !w.trackId);
  const stages = running.flatMap((w) =>
    restartPoints(w.definition).map((n) => ({
      value: `${w.id}:${n.id}`,
      label: running.length > 1 ? `${w.name}: ${n.name}` : n.name,
    })),
  );
  const [restart, setRestart] = useState("");
  const next = (track.versions.at(-1)?.number ?? 0) + 1;
  const edlFile = edl.picks.find((p) => p.fileId);
  const edlLoose = files.filter((f) => /\.edl$/i.test(f.name));
  const primaryKey = chosen.some((c) => c.key === primary) ? primary : chosen[0]?.key;

  const send = async (sent: ChosenFile<UploadedFile>[], hint?: unknown) => {
    await createVersion.mutateAsync({
      trackId: track.id,
      notes: notes.trim() || undefined,
      variants: sent.flatMap((c) =>
        c.result
          ? [
              {
                fileId: c.result.id,
                name: nameOf(c).trim() || "Main",
                primary: c.key === primaryKey,
              },
            ]
          : [],
      ),
      carry: Object.keys(choices).length ? choices : undefined,
      edlFileId: edlFile?.fileId ?? undefined,
      letThrough: letThrough(hint) || undefined,
      restartFrom: restart
        ? {
            workflowId: restart.slice(0, restart.indexOf(":")),
            nodeId: restart.slice(restart.indexOf(":") + 1),
          }
        : undefined,
    });
    onClose();
  };

  return (
    <UploadDialog<UploadedFile>
      title={`${capital(words.version)} ${next}`}
      description={`A new edit is a new ${words.version}, never a replacement. One file per ${words.variant}; one of them is the primary.`}
      onClose={onClose}
      width="lg"
      inputLabel={`${capital(words.version)} files`}
      listLabel={`Files of this ${words.version}`}
      prompt={`Drop the files of this ${words.version} here, or choose them`}
      hint={`One file per ${words.variant}.`}
      accept="audio/*,video/*"
      multiple
      initial={initial}
      send={(file, onProgress, signal) =>
        uploadFile(file, {
          projectId: track.projectId,
          folderId: track.folderId,
          signal,
          onProgress: (p) => onProgress(p.total ? p.sent / p.total : 0),
        })
      }
      alternatives={(add) => {
        const left = loose.filter((f) => !chosen.some((c) => c.key === f.id));
        return (
          left.length > 0 && (
            <Dropdown
              size="sm"
              value="From the project"
              actions={left.map((f) => ({
                label: f.name,
                icon: <Icon name={kindIcon[f.kind]} size={13} />,
                onSelect: () =>
                  add({
                    key: f.id,
                    name: f.name,
                    size: f.byteSize,
                    result: { id: f.id, name: f.name, kind: f.kind, byteSize: f.byteSize },
                  }),
              }))}
            />
          )
        );
      }}
      onChange={setChosen}
      row={(c) => (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Input
            size="sm"
            value={nameOf(c)}
            onChange={(e) => setNames((n) => ({ ...n, [c.key]: e.target.value }))}
            aria-label={`${capital(words.variant)} name for ${c.name}`}
            className="w-48 min-w-0 flex-1 @3xl/app:flex-none"
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink-2">
            <Radio
              name="primary"
              checked={c.key === primaryKey}
              onChange={() => setPrimary(c.key)}
            />
            Primary
          </label>
        </div>
      )}
      fields={
        <>
          <Field label="What changed">
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={
                video
                  ? "Grade pass on the night exteriors; titles re-timed."
                  : "Pedal noise cleaned at bar 5; tighter join at 17."
              }
            />
          </Field>
          {carry.length > 0 && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-1 text-[14px] text-ink-2">
                The {carry.length} open {carry.length === 1 ? "comment" : "comments"} from V
                {next - 1}
                <span className="block text-[13px] text-ink-3">
                  Each carries over unless you say otherwise. Anchors follow the music once the
                  versions are aligned; you can move any by hand.
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
                          t.variant,
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
            <span className="text-[13px] text-ink-2">Edit decision list</span>
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
                <EdlChooser busy={edl.busy} onFiles={edl.upload} />
                {edlLoose.length > 0 && (
                  <Dropdown
                    size="sm"
                    value="From the project"
                    actions={edlLoose.map((f) => ({
                      label: f.name,
                      onSelect: () => edl.add(f),
                    }))}
                  />
                )}
                <span className="text-[13px] text-ink-3">
                  CMX 3600, Pyramix or Sequoia.{" "}
                  {project.requireEdl ? "This project asks for one." : "Optional here."}
                </span>
              </span>
            )}
            {edl.picks[0]?.error && (
              <span role="alert" className="text-[13px] text-signal">
                {edl.picks[0].name}: {edl.picks[0].error}
              </span>
            )}
          </div>
          {mayRestart && stages.length > 0 && (
            <Field label="Restart the workflow from">
              <Select
                className="@3xl/app:w-80"
                value={restart}
                onChange={(e) => setRestart(e.target.value)}
              >
                <option value="">Keep the current stage</option>
                {stages.map((st) => (
                  <option key={st.value} value={st.value}>
                    {st.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      }
      what={`Uploaded into the ${words.track}'s folder as ${capital(words.version)} ${next}${
        carry.length > 0 ? `; the open comments from V${next - 1} follow as chosen above` : ""
      }.`}
      action={(list) =>
        list.some((c) => c.file && c.state !== "sent")
          ? `Upload ${words.version} ${next}`
          : `Add ${words.version} ${next}`
      }
      disabled={edl.busy}
      onSubmit={send}
      problem={versionProblem(can("edit_workflows"))}
    />
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

type Said = "yes" | "no" | "";
const saidOf = (value: boolean | null): Said => (value === null ? "" : value ? "yes" : "no");
const answerOf = (said: Said) => (said === "" ? null : said === "yes");

/**
 * A version's variants by name, and for a deliverable's renditions what sets each apart
 * (#16): subtitled or clean, graded or ungraded. Its shape and codec are measured, not said.
 */
function DescribeDialog({
  track,
  version,
  onClose,
}: {
  track: Track;
  version: Version;
  onClose: () => void;
}) {
  const { updateVariant } = useTrackMutations(track.projectId);
  const { versionLabel, video } = useItemWords(track.projectId);
  const [rows, setRows] = useState(() =>
    version.variants.map((v) => ({
      id: v.id,
      name: v.name,
      subtitled: saidOf(v.subtitled),
      graded: saidOf(v.graded),
      measured: renditionTraits(v, {}).join(" · "),
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (id: string, patch: Partial<(typeof rows)[number]>) =>
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      for (const row of rows) {
        const was = version.variants.find((v) => v.id === row.id);
        if (!was) continue;
        const name = row.name.trim();
        const input = {
          ...(name && name !== was.name ? { name } : {}),
          ...(video && answerOf(row.subtitled) !== was.subtitled
            ? { subtitled: answerOf(row.subtitled) }
            : {}),
          ...(video && answerOf(row.graded) !== was.graded ? { graded: answerOf(row.graded) } : {}),
        };
        if (Object.keys(input).length > 0)
          await updateVariant.mutateAsync({ id: row.id, ...input });
      }
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={`${video ? "Renditions" : "Variants"} of ${versionLabel(version.number)}`}
      description={
        video
          ? "Each rendition's shape and codec are read from its file; say whether it is subtitled and graded."
          : undefined
      }
      onClose={onClose}
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        {rows.map((row) => (
          <fieldset
            key={row.id}
            className="m-0 flex flex-col gap-2 border-0 border-line p-0 not-first:border-t not-first:pt-4"
          >
            <Field label="Name" hint={row.measured || undefined}>
              <Input
                value={row.name}
                maxLength={80}
                onChange={(e) => change(row.id, { name: e.target.value })}
              />
            </Field>
            {video && (
              <span className="grid grid-cols-2 gap-2">
                <Field label="Subtitles">
                  <Select
                    value={row.subtitled}
                    onChange={(e) => change(row.id, { subtitled: e.target.value as Said })}
                  >
                    <option value="">Not said</option>
                    <option value="yes">Subtitled</option>
                    <option value="no">Clean</option>
                  </Select>
                </Field>
                <Field label="Grade">
                  <Select
                    value={row.graded}
                    onChange={(e) => change(row.id, { graded: e.target.value as Said })}
                  >
                    <option value="">Not said</option>
                    <option value="yes">Graded</option>
                    <option value="no">Ungraded</option>
                  </Select>
                </Field>
              </span>
            )}
          </fieldset>
        ))}
        {error && (
          <p role="alert" className="m-0 text-[12px] text-signal">
            {error}
          </p>
        )}
        <span className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={saving || rows.some((r) => !r.name.trim())}
          >
            Save
          </Button>
        </span>
      </form>
    </Dialog>
  );
}

/**
 * A version's edit decision list given after it was made (#56), or another in its place:
 * uploaded, or one already in the project. The takes view then reads which take each edit
 * comes from.
 */
function EdlDialog({
  track,
  version,
  onClose,
}: {
  track: Track;
  version: Version;
  onClose: () => void;
}) {
  const { words, versionLabel, video } = useItemWords(track.projectId);
  const { setEdl } = useTrackMutations(track.projectId);
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const lists = files.filter((f) => /\.edl$/i.test(f.name) && f.id !== version.edlFileId);
  return (
    <UploadDialog<UploadedFile>
      title={`Edit decision list for ${versionLabel(version.number)}`}
      description={`The list the ${words.version} was cut from, as the editing software exports it (CMX 3600).${video ? "" : " Its edits are matched to the track's takes."}`}
      onClose={onClose}
      width="sm"
      inputLabel="Edit decision list"
      prompt="Drop the list here, or choose it"
      accept=".edl"
      send={(file, onProgress, signal) =>
        uploadFile(file, {
          projectId: track.projectId,
          folderId: track.folderId,
          signal,
          onProgress: (p) => onProgress(p.total ? p.sent / p.total : 0),
        })
      }
      alternatives={
        lists.length > 0
          ? (add) => (
              <Dropdown
                size="sm"
                value="From the project"
                actions={lists.map((f) => ({
                  label: f.name,
                  onSelect: () =>
                    add({
                      key: f.id,
                      name: f.name,
                      size: f.byteSize,
                      result: { id: f.id, name: f.name, kind: f.kind, byteSize: f.byteSize },
                    }),
                }))}
              />
            )
          : undefined
      }
      what={`Kept beside ${versionLabel(version.number)}${
        video ? "" : "; the takes view then reads which take each edit comes from"
      }.`}
      action="Use this list"
      onSubmit={async ([chosen]) => {
        if (!chosen?.result) return;
        await setEdl.mutateAsync({ versionId: version.id, fileId: chosen.result.id });
        onClose();
      }}
    />
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
  const tool = useProjectTool(track.projectId);
  const navigate = useNavigate();
  const { makePrimary, setEdl } = useTrackMutations(track.projectId);
  const { words, versionLabel, video } = useItemWords(track.projectId);
  const label = versionLabel(version.number);
  const previous = [...track.versions]
    .filter((v) => v.number < version.number)
    .sort((x, y) => y.number - x.number)[0];
  const [dialog, setDialog] = useState<"add" | "replace" | "edl" | "describe" | "share" | null>(
    null,
  );
  const pending = version.variants.some((v) => v.streamStatus === "pending");
  const failed = version.variants.some((v) => v.streamStatus === "failed");
  const actions: MenuAction[] = [
    // Two versions side by side, aligned by their audio (#137).
    ...(previous && tool("compare")
      ? [
          {
            label: `Compare with the previous ${words.version}`,
            onSelect: () =>
              void navigate({
                to: "/tracks/$trackId/compare",
                params: { trackId: track.id },
                search: { a: previous.number, b: version.number },
              }),
          },
        ]
      : []),
    // This version alone (#489), where a track's share follows its latest.
    ...(can("request_reviews") ? [{ label: "Share…", onSelect: () => setDialog("share") }] : []),
    ...(can("upload")
      ? [{ label: `Add a ${words.variant}…`, onSelect: () => setDialog("add") }]
      : []),
    ...(can("organise")
      ? [
          { label: "Replace a file…", onSelect: () => setDialog("replace") },
          // A rendition says how it differs (#16); a variant only needs a name.
          {
            label: video ? "Describe the renditions…" : `Rename the ${words.variants}…`,
            onSelect: () => setDialog("describe"),
          },
          {
            label: version.edlFileId
              ? "Replace the edit decision list…"
              : "Import an edit decision list…",
            onSelect: () => setDialog("edl"),
          },
          ...(version.edlFileId
            ? [
                {
                  label: "Take off the edit decision list",
                  onSelect: () => setEdl.mutate({ versionId: version.id, fileId: null }),
                },
              ]
            : []),
          ...version.variants
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
        <span className="tabular text-[15px] font-medium text-ink">{label}</span>
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
            {version.createdByName ??
              (version.sentBy ? `${version.sentBy}, by upload request` : "A former member")}{" "}
            · {whenFormat.format(new Date(version.createdAt))}
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
          {actions.length > 0 && <ActionMenu always label={label} actions={actions} />}
        </span>
      </div>
      {version.notes && <p className="text-[14px] text-ink-2">{version.notes}</p>}
      {failed && (
        <p className="flex items-start gap-2 text-[14px] text-ink-2">
          <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
          <span>
            A file of this {words.version} could not be read. Re-export it and replace the file.
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
        {version.variants.map((v) => {
          const file = files.get(v.fileId);
          const open = file?.openComments ?? 0;
          const facts =
            v.streamStatus === "pending"
              ? "analysing"
              : v.streamStatus === "failed"
                ? "failed"
                : [
                    // A rendition by what sets it apart; anything else by what was measured.
                    v.video
                      ? renditionTraits(v, v).join(" · ")
                      : file
                        ? mediaSummary(file.kind, file.mediaInfo)
                        : "",
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
      {(dialog === "add" || dialog === "replace") && (
        <VariantDialog
          track={track}
          version={version}
          mode={dialog}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "edl" && (
        <EdlDialog track={track} version={version} onClose={() => setDialog(null)} />
      )}
      {dialog === "describe" && (
        <DescribeDialog track={track} version={version} onClose={() => setDialog(null)} />
      )}
      {dialog === "share" && (
        <ShareDialog
          projectId={track.projectId}
          item={{
            kind: "version",
            id: version.id,
            trackId: track.id,
            name: `${track.name} ${label}`,
            what: capital(words.version),
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </li>
  );
}

/** The score beside the track's recordings: a link to it, or choosing one for those who may. */
function ScoreChoice({ track, canEdit }: { track: Track; canEdit: boolean }) {
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const { chooseScore } = useTrackMutations(track.projectId);
  const scores = files.filter((f) => isPdf(f.name, f.contentType));
  const linked = scores.find((f) => f.id === track.scoreFileId);
  const choose = (id: string | null) => chooseScore.mutate({ id: track.id, scoreFileId: id });
  const moved = chooseScore.data?.rehomed;
  if (linked) {
    return (
      <span className="flex flex-wrap items-center gap-1">
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
        <span role="status" className={cn("text-ink-3", !moved && "sr-only")}>
          {moved && swappedSummary(moved)}
        </span>
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
 * variants with the primary marked, and adding the next. The track itself opens in the
 * player on its latest version; this page is one step from there.
 */
/** A track's name, how many versions it has, and a way into the player. */
export function TrackHeading({ track, aside }: { track: Track; aside?: ReactNode }) {
  const latest = track.versions.at(-1);
  const primary = latest && primaryOf(latest);
  const count = track.versions.length;
  const { words, versionLabel } = useItemWords(track.projectId);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-medium tracking-tight text-ink">{track.name}</h1>
        <p className="mt-1 text-[13px] text-ink-3">
          {count} {count === 1 ? words.version : words.versions}
          {latest && primary && (
            <>
              {" · "}
              <Link
                to="/files/$fileId"
                params={{ fileId: primary.fileId }}
                className="text-ink-2 hover:text-ink"
              >
                open {versionLabel(latest.number)} in the player
              </Link>
            </>
          )}
        </p>
      </div>
      {aside}
    </div>
  );
}

export function TrackVersions({
  track,
  project,
  adding,
  dropped,
  onAdding,
  aside,
}: {
  track: Track;
  project: Project;
  adding: boolean;
  /** Files dropped on the page, which open the new version with them chosen. */
  dropped?: Picked[] | undefined;
  onAdding: (adding: boolean) => void;
  /** Beside the heading: the switch to the track's takes. */
  aside?: ReactNode;
}) {
  const can = useProjectCan(track.projectId);
  const { words, video } = useItemWords(track.projectId);
  const { data: files = [] } = useQuery(projectFilesQuery(track.projectId));
  const byId = new Map(files.map((f) => [f.id, f]));
  const newest = [...track.versions].reverse();
  const latest = newest[0];
  const open = track.versions
    .flatMap((v) => v.variants)
    .reduce((n, v) => n + (byId.get(v.fileId)?.openComments ?? 0), 0);
  // The track's own profile, else the project's or the workspace's (#144).
  const { data: customs = [] } = useQuery(customProfilesQuery);
  const { data: workspace } = useQuery(workspaceSettingsQuery);
  const { data: standing } = useQuery(trackStandingQuery(track.id));
  const status = standing?.status ?? standing?.stage;
  const profile = profileFor(
    track.deliveryProfile ?? project.deliveryProfile ?? workspace?.deliveryProfile,
    customs,
  );
  return (
    <div className="flex flex-col gap-6">
      <TrackHeading track={track} aside={aside} />
      {adding && (
        <NewVersion
          track={track}
          project={project}
          initial={dropped}
          onClose={() => onAdding(false)}
        />
      )}
      {newest.length === 0 ? (
        <Empty
          title={`No ${words.versions} yet`}
          text={`Upload the first ${words.version} of this ${words.track}. Each later edit becomes the next ${words.version}, and comments carry across.`}
          action={
            can("upload") ? (
              <Button variant="primary" onClick={() => onAdding(true)}>
                Add {words.version} 1
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
            {/* Where its workflow has it, as the prototype says it. */}
            {status && (
              <span className="flex items-center gap-2 text-ink">
                <ReviewerDot
                  state={
                    standing?.category === "done"
                      ? "approved"
                      : standing?.category === "todo"
                        ? "invited"
                        : "in_review"
                  }
                />
                {status}
                {standing?.status && standing.stage && (
                  <span className="text-ink-3">· {standing.stage}</span>
                )}
              </span>
            )}
            {standing?.next && <span>Next: {standing.next}</span>}
            {/* A score is music's; a video project has none (#16). */}
            {!video && <ScoreChoice track={track} canEdit={can("organise")} />}
            <span>
              {open} open {open === 1 ? "comment" : "comments"}
            </span>
            {profile && <span>Delivery: {profile.label}</span>}
          </div>
          <Card>
            <ul aria-label={capital(words.versions)}>
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
          {/* Its workflow's moves, for whoever may see the workflow (#25). */}
          {can("view_workflows") && <WorkflowHistory trackId={track.id} />}
        </>
      )}
    </div>
  );
}
