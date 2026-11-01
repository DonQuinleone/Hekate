import {
  CROOM_MAX_BYTES,
  type CroomConflict,
  type CroomConflictChoice,
  type CroomImported,
  type CroomPreview,
  type CroomReport,
  croomConflictWords,
  croomKindWords,
  croomReportEmpty,
} from "@hekate/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, useRef, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionBody } from "~/components/production-nav";
import { FoldingSection } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { FileInput, Select } from "~/components/ui/input";
import { Refused } from "~/components/ui/states";
import { StatusDot } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { reportLines } from "~/lib/croom";
import { json, useProjectCan } from "~/lib/queries";
import { ProjectFrame } from "./project";

/**
 * Production › Import (#57, decision 242), as the prototype draws it: a ControlRoom project file
 * chosen or dropped, what it will bring shown before anything changes, and one button to import.
 * The file is sent again to import it, so nothing of it waits on the server in between.
 */
export function CroomImportPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  return (
    <ProjectFrame projectId={projectId} title="Import">
      {(project) => (
        <ProductionBody projectId={projectId} current="import" can={can}>
          {!can("edit_project") ? (
            <Refused
              title="Not among what your role allows"
              text="Importing a ControlRoom project needs the permission to edit the project. Ask whoever runs it."
            />
          ) : project.archivedAt ? (
            <Empty
              title="This project is archived"
              text="Unarchive it in its settings to import into it."
            />
          ) : (
            <CroomImport projectId={projectId} />
          )}
        </ProductionBody>
      )}
    </ProjectFrame>
  );
}

const send = async <T,>(projectId: string, step: string, file: File, conflicts: string) =>
  json<T>(
    await fetch(`/api/projects/${projectId}/croom/${step}?conflicts=${conflicts}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    }),
  );

function CroomImport({ projectId }: { projectId: string }) {
  const client = useQueryClient();
  const chooser = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [choice, setChoice] = useState<CroomConflictChoice>("merge");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const preview = useMutation({
    mutationFn: ({ chosen, conflicts }: { chosen: File; conflicts: CroomConflictChoice }) =>
      send<{ preview: CroomPreview }>(projectId, "preview", chosen, conflicts),
  });
  const imported = useMutation({
    mutationFn: (chosen: File) =>
      send<{ imported: CroomImported }>(projectId, "import", chosen, choice),
    // Everything in the project may have changed.
    onSuccess: () => client.invalidateQueries(),
  });

  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    if (chosen.size > CROOM_MAX_BYTES) {
      setRefusal("A ControlRoom file can be at most 200 MB.");
      return;
    }
    setRefusal(null);
    setFile(chosen);
    imported.reset();
    preview.mutate({ chosen, conflicts: choice });
  };
  const rechoose = (next: CroomConflictChoice) => {
    setChoice(next);
    if (file) preview.mutate({ chosen: file, conflicts: next });
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    choose(e.dataTransfer.files[0]);
  };

  const shown = preview.data?.preview;
  const done = imported.data?.imported;
  return (
    <section
      aria-label="Import a ControlRoom project"
      className="mx-auto flex w-full max-w-[640px] flex-col gap-4"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <p className="m-0 text-[14px] text-ink-2">
        Bring a ControlRoom project (.croom) into this one. Everything it holds becomes the
        project's: works and scores, the schedule, personnel, takes and to-dos, marks, stage plans,
        the patch list and attached files.
      </p>
      <FileInput
        ref={chooser}
        accept=".croom"
        aria-label="ControlRoom project file"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {!file && (
        <button
          type="button"
          onClick={() => chooser.current?.click()}
          className={cn(
            "flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink",
            dragging && "border-edge-strong bg-raised/40",
          )}
        >
          <Icon name="upload" size={20} className="text-ink-3" />
          <span className="text-[14px] text-ink">Drop the .croom file here</span>
          <span className="text-[13px] text-ink-3">Nothing changes until you confirm.</span>
        </button>
      )}
      {refusal && <p className="m-0 text-[13px] text-signal">{refusal}</p>}
      {file && (
        <div className="flex min-w-0 items-center gap-2 text-[13px]">
          <Icon name="file" size={14} className="shrink-0 text-ink-3" />
          <span className="min-w-0 truncate text-ink">{file.name}</span>
          {!done && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0"
              disabled={imported.isPending}
              onClick={() => chooser.current?.click()}
            >
              Choose another
            </Button>
          )}
        </div>
      )}
      {file && preview.isPending && <p className="m-0 text-[13px] text-ink-3">Reading the file</p>}
      {file && preview.error && (
        <p className="m-0 flex items-start gap-2 text-[13px] text-signal">
          <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
          {preview.error.message}
        </p>
      )}
      {file && shown && !preview.isPending && (
        <>
          {/* Once imported, what the import itself wrote: it plans again against the project
              as it then stands, so it can leave out more than the preview said. */}
          <Counts preview={done ? { ...shown, counts: done.counts } : shown} />
          {!done && shown.conflicts.length > 0 && <Conflicts conflicts={shown.conflicts} />}
          <Report report={done ? done.report : shown.report} />
          {!done && (
            <div className="flex flex-wrap items-center gap-2">
              {shown.conflicts.length > 0 && (
                <Select
                  aria-label="What is already in the project"
                  value={choice}
                  className="w-56"
                  disabled={imported.isPending}
                  onChange={(e) => rechoose(e.target.value as CroomConflictChoice)}
                >
                  <option value="merge">Merge into what is there</option>
                  <option value="new">Import beside it</option>
                </Select>
              )}
              <Button
                variant="primary"
                className="ml-auto"
                disabled={imported.isPending || shown.counts.length === 0}
                onClick={() => imported.mutate(file)}
              >
                {imported.isPending ? "Importing" : "Import"}
              </Button>
            </div>
          )}
          {imported.error && (
            <p className="m-0 flex items-start gap-2 text-[13px] text-signal">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              {imported.error.message}
            </p>
          )}
          {done && (
            <p className="m-0 flex items-center gap-2 text-[13px] text-ink-2">
              <StatusDot state="approved" />
              <span>
                Imported as listed above: start with the{" "}
                <Link
                  to="/projects/$projectId/repertoire"
                  params={{ projectId }}
                  className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink"
                >
                  repertoire
                </Link>
                .
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function Counts({ preview }: { preview: CroomPreview }) {
  if (preview.counts.length === 0)
    return <p className="m-0 text-[13px] text-ink-2">The file holds nothing to import.</p>;
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 p-0">
      {preview.counts.map((c) => {
        const total = c.create + c.merge;
        const [one, many] = croomKindWords[c.kind];
        const names = preview.names.find((n) => n.kind === c.kind)?.names ?? [];
        return (
          <li key={c.kind} className="flex items-baseline gap-3 px-4 py-2 text-[14px]">
            <span className="shrink-0 text-ink">{total === 1 ? one : many}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">
              {names.join(", ")}
            </span>
            {c.merge > 0 && (
              <span className="shrink-0 text-[13px] text-ink-3">{c.merge} merged</span>
            )}
            <span className="tabular shrink-0 text-ink-2">{total}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Conflicts({ conflicts }: { conflicts: CroomConflict[] }) {
  const listed = conflicts.map(croomConflictWords);
  const shown =
    listed.length > 6
      ? `${listed.slice(0, 6).join(", ")} and ${listed.length - 6} more`
      : listed.length > 1
        ? `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`
        : (listed[0] ?? "");
  return (
    <p className="m-0 flex items-start gap-2 text-[13px] text-ink-2">
      <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-ink-3" />
      <span>Already in this project: {shown}. Merge into them, or import beside them.</span>
    </p>
  );
}

/**
 * What to look over, and what the file held that is not brought over, in people's words
 * (#551): one quiet warning colour for the lines, the signal for the count alone, and the
 * file's own ids only under Details for support, for whoever helps.
 */
function Report({ report }: { report: CroomReport }) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState(false);
  if (croomReportEmpty(report)) return null;
  const { lookOver, notBrought, support } = reportLines(report);
  const total = notBrought.reduce((n, s) => n + s.count, 0);
  return (
    <div className="flex flex-col gap-4">
      {lookOver.length > 0 && (
        <section aria-label="To look over" className="flex flex-col gap-2">
          <h2 className="m-0 flex items-baseline gap-2 text-[16px] font-medium text-ink">
            To look over
            <span className="tabular text-[13px] text-signal">{lookOver.length}</span>
          </h2>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {lookOver.map((p) => (
              <li key={p} className="flex items-start gap-2 text-[13px] text-ink-2">
                <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-warn" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{p}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {notBrought.length > 0 && (
        <FoldingSection
          id="croom-not-brought"
          title="Not brought over"
          summary={`${total} ${total === 1 ? "thing" : "things"} the file holds that Hekate has no place for`}
          open={open}
          onToggle={() => setOpen(!open)}
        >
          {notBrought.map((s) => (
            <div key={s.what} className="flex items-baseline gap-3 px-4 py-2 text-[13px]">
              <span className="min-w-0 flex-1 text-ink-2 [overflow-wrap:anywhere]">{s.what}</span>
              <span className="tabular shrink-0 text-ink-3">{s.count}</span>
            </div>
          ))}
          <div className="flex flex-col gap-2 px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              aria-expanded={details}
              aria-controls="croom-support"
              onClick={() => setDetails(!details)}
            >
              Details for support
              <Icon
                name="chevronDown"
                size={12}
                className={cn("text-ink-3 transition-transform", details && "rotate-180")}
              />
            </Button>
            {details && (
              <ul id="croom-support" className="m-0 flex list-none flex-col gap-1 p-0">
                {support.map((s) => (
                  <li key={s.what} className="flex items-baseline gap-3 text-[12px] text-ink-3">
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{s.what}</span>
                    <span className="tabular shrink-0">{s.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </FoldingSection>
      )}
    </div>
  );
}
