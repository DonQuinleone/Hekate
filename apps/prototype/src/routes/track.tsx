import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import {
  comments,
  fileById,
  personById,
  projectById,
  reviews,
  trackById,
  type Version,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { openCommentCount, qaSummary } from "~/lib/files";
import { formatDateTime, plural } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, StateGate, useScreenState } from "~/viewer/state-gate";

function NewVersion({
  next,
  onClose,
  hasScore,
}: {
  next: number;
  onClose: () => void;
  hasScore: boolean;
}) {
  const state = useScreenState();
  const refused = state === "failed";
  return (
    <form
      className="flex flex-col gap-5 rounded-panel-lg border border-line bg-raised/40 p-5 shadow-1"
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[16px] font-medium">Version {next}</h2>
        <span className="text-[13px] text-ink-3">
          A new edit is a new version, never a replacement.
        </span>
      </div>
      <div className="flex flex-col gap-2 rounded-panel border border-edge border-dashed p-4">
        <p className="text-[14px] text-ink-2">
          Drop the files of this version here, or choose them. One file per variation.
        </p>
        <ul className="flex list-none flex-col gap-1 p-0">
          {[
            { name: "Maple Leaf Rag - V3 dry.wav", variation: "Dry", primary: true },
            { name: "Maple Leaf Rag - V3 wet.wav", variation: "Wet", primary: false },
          ].map((f) => (
            <li
              key={f.name}
              className="grid grid-cols-[auto_minmax(0,1fr)_120px_auto] items-center gap-3 rounded-control bg-ground px-3 py-2"
            >
              <Icon name="music" className="text-ink-3" />
              <span className="truncate text-[14px] text-ink">{f.name}</span>
              <Input defaultValue={f.variation} aria-label="Variation name" className="h-7" />
              <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                <input type="radio" name="primary" defaultChecked={f.primary} /> Primary
              </label>
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="self-start">
          Choose files
        </Button>
      </div>
      {refused && (
        <p className="flex items-start gap-2 rounded-panel border border-signal/50 bg-signal/10 px-3 py-2 text-[14px] text-ink">
          <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
          <span>
            The upload workflow refused Maple Leaf Rag - V3 dry.wav: true peak +0.2 dBTP is over the
            −1.0 dBTP ceiling of Apple Digital Masters. Fix the export and upload again, or ask a
            producer to let it through.
          </span>
        </p>
      )}
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        What changed
        <textarea
          rows={2}
          placeholder="Pedal noise cleaned at bar 5; tighter join at 17."
          className="rounded-control border border-edge bg-ground px-3 py-2 text-[14px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
        />
      </label>
      <div className="grid gap-4 @3xl/app:grid-cols-2">
        <label className="flex items-start gap-2 text-[14px] text-ink-2">
          <input type="checkbox" defaultChecked className="mt-1" />
          <span>
            Carry over the 4 open comments from V{next - 1}
            <span className="block text-[13px] text-ink-3">
              Their anchors follow the music once the versions are aligned; you can move any by
              hand.
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
          Edit decision list
          <span className="flex items-center gap-2">
            <Button variant="secondary" size="sm">
              Attach EDL
            </Button>
            <span className="text-[13px] text-ink-3">
              CMX 3600, Pyramix or Sequoia. Optional here.
            </span>
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
          Restart the workflow from
          <select
            defaultValue="st-conductor-2"
            className="h-8 rounded-control border border-edge bg-ground px-2 text-[14px] text-ink"
          >
            <option value="none">Keep the current stage</option>
            <option value="st-conductor-1">Conductor, round one</option>
            <option value="st-triage">Producer triages</option>
            <option value="st-conductor-2">Conductor, round two</option>
            <option value="st-approve">Label approval</option>
          </select>
        </label>
        {hasScore && (
          <label className="flex items-start gap-2 text-[14px] text-ink-2">
            <input type="checkbox" defaultChecked className="mt-1" />
            <span>
              Keep the score beside this version
              <span className="block text-[13px] text-ink-3">Maple Leaf Rag - Score.pdf</span>
            </span>
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit">
          Add version {next}
        </Button>
      </div>
    </form>
  );
}

function VersionRow({
  version,
  trackId,
  projectId,
  latest,
}: {
  version: Version;
  trackId: string;
  projectId: string;
  latest: boolean;
}) {
  const viewer = useViewer();
  const canOrganise = viewer.can(projectId, "organise");
  const review = reviews.find(
    (r) =>
      r.status === "open" &&
      r.items.some(
        (i) =>
          i.trackId === trackId &&
          (i.versionNumber === version.number || (i.versionNumber === "latest" && latest)),
      ),
  );
  return (
    <li className="flex flex-col gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular text-[15px] font-medium text-ink">V{version.number}</span>
        {latest && <Label>latest</Label>}
        <span className="flex items-center gap-2 text-[13px] text-ink-2">
          <Dot
            state={
              version.status === "Approved"
                ? "approved"
                : version.state === "failed"
                  ? "changes_requested"
                  : "in_review"
            }
          />
          {version.state === "pending"
            ? "Analysing"
            : version.state === "failed"
              ? "Could not be analysed"
              : version.status}
        </span>
        {review && (
          <Link
            to="/reviews/$reviewId"
            params={{ reviewId: review.id }}
            className="text-[13px] text-ink-3 no-underline hover:text-ink"
          >
            in {review.title}
          </Link>
        )}
        <span className="ml-auto flex items-center gap-2 text-[13px] text-ink-3">
          <Avatar personId={version.uploadedBy} size={18} />
          {personById(version.uploadedBy).name} · {formatDateTime(version.uploadedAt)}
          {version.editDecisionList && (
            <span className="rounded-chip border border-line px-1.5 text-[12px]">EDL</span>
          )}
          {canOrganise && (
            <ActionMenu
              label={`V${version.number}`}
              actions={[
                { label: "Add a variation…", onSelect: () => {} },
                { label: "Replace a file…", onSelect: () => {} },
                { label: "Import an edit decision list…", onSelect: () => {} },
                { label: "Compare with the previous version", onSelect: () => {} },
                ...(viewer.can(projectId, "delete")
                  ? [{ label: "Delete version…", danger: true, onSelect: () => {} }]
                  : []),
              ]}
            />
          )}
        </span>
      </div>
      {version.note && <p className="text-[14px] text-ink-2">{version.note}</p>}
      {version.state === "failed" && (
        <p className="flex items-start gap-2 text-[14px] text-ink-2">
          <Icon name="warning" className="mt-0.5 shrink-0 text-signal" />
          <span>
            The file could not be read: the container says 96 kHz but holds 44.1 kHz frames.
            Re-export it and replace the file.
            {canOrganise && (
              <button type="button" className="ml-2 text-ink hover:text-signal">
                Replace file
              </button>
            )}
          </span>
        </p>
      )}
      <ul className="flex list-none flex-wrap gap-2 p-0">
        {version.variations.map((v) => {
          const file = fileById(v.fileId);
          const qa = qaSummary(v.fileId);
          const open = openCommentCount(v.fileId);
          const pending = file?.state === "pending" || version.state === "pending";
          return (
            <li key={v.id}>
              <Link
                to="/files/$fileId"
                params={{ fileId: v.fileId }}
                className={cn(
                  "flex items-center gap-3 rounded-panel border px-3 py-2 no-underline hover:border-edge",
                  v.primary ? "border-edge bg-raised shadow-1" : "border-line bg-ground",
                )}
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-ink text-ground">
                  <Icon name="play" size={12} />
                </span>
                <span className="flex flex-col">
                  <span className="text-[14px] text-ink">
                    {v.name}
                    {v.primary && <span className="text-ink-3"> · primary</span>}
                  </span>
                  <span className="tabular text-[12px] text-ink-3">
                    {pending
                      ? "analysing"
                      : file?.state === "failed"
                        ? "failed"
                        : [
                            file?.media.layout,
                            qa?.loudness !== null && qa?.loudness !== undefined
                              ? `${qa.loudness.toFixed(1)} LUFS`
                              : "",
                            qa && qa.issues > 0 ? plural(qa.issues, "issue") : "",
                            open > 0 ? plural(open, "comment") : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function TrackPage({ trackId }: { trackId: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const track = trackById(trackId);
  const project = track ? projectById(track.projectId) : undefined;
  const visible = track && project && viewer.canSee(project.id);
  const [adding, setAdding] = useState(false);
  const state = useScreenState();
  const versions = track ? [...track.versions].sort((a, b) => b.number - a.number) : [];
  const latest = versions[0];
  usePageHeader({
    crumbs: [
      { label: "Projects", to: "/projects" },
      ...(project && visible ? [{ label: project.name, to: `/projects/${project.id}` }] : []),
    ],
    title: track && visible ? track.name : "Not found",
    actions: visible ? (
      <>
        {viewer.can(project.id, "request_reviews") && latest && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              navigate({ to: "/reviews/new", search: { project: project.id, item: track.id } })
            }
          >
            Request a review
          </Button>
        )}
        {viewer.can(project.id, "upload") && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <Icon name="upload" size={14} />
            Add version
          </Button>
        )}
      </>
    ) : undefined,
  });
  if (!track || !project || !visible) return <Refused />;
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const stage = workflow?.stages.find((s) => s.status === latest?.status);
  const next = workflow?.stages.find((s) => s.after.includes(stage?.id ?? ""));
  const score = track.scoreFileId ? fileById(track.scoreFileId) : undefined;
  const openComments = track.versions
    .flatMap((v) => v.variations)
    .reduce(
      (n, v) =>
        n + comments.filter((c) => c.fileId === v.fileId && !c.parentId && !c.resolved).length,
      0,
    );
  const empty = state === "empty" || versions.length === 0;
  return (
    <div className="fade-in mx-auto flex max-w-[1000px] flex-col gap-6 px-4 py-6 @3xl/app:px-8">
      {adding && (
        <NewVersion
          next={(latest?.number ?? 0) + 1}
          onClose={() => setAdding(false)}
          hasScore={Boolean(score)}
        />
      )}
      <StateGate
        empty={
          <Empty
            title="No versions yet"
            text="Upload the first version of this track. Each later edit becomes the next version, and comments carry across."
            action={
              viewer.can(project.id, "upload") ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add version 1
                </Button>
              ) : undefined
            }
          />
        }
      >
        {empty ? (
          <Empty
            title="No versions yet"
            text="Upload the first version of this track. Each later edit becomes the next version, and comments carry across."
            action={
              viewer.can(project.id, "upload") ? (
                <Button variant="primary" onClick={() => setAdding(true)}>
                  Add version 1
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
              <span className="flex items-center gap-2 text-ink">
                <Dot state={latest?.status === "Approved" ? "approved" : "in_review"} />
                {latest?.status}
                {stage && <span className="text-ink-3">· {stage.name}</span>}
              </span>
              {next && <span>Next: {next.name}</span>}
              {score ? (
                <Link
                  to="/files/$fileId"
                  params={{ fileId: score.id }}
                  className="flex items-center gap-1.5 text-ink-2 hover:text-ink"
                >
                  <Icon name="score" size={14} />
                  {score.name}
                </Link>
              ) : viewer.can(project.id, "organise") ? (
                <button type="button" className="flex items-center gap-1.5 hover:text-ink">
                  <Icon name="plus" size={12} /> Link a score
                </button>
              ) : null}
              <span>{plural(openComments, "open comment")}</span>
              {track.deliveryProfile && <span>Delivery: {track.deliveryProfile}</span>}
            </div>
            <ul className="list-none rounded-panel-lg border border-line bg-raised/40 p-0 shadow-1">
              {versions.map((v) => (
                <VersionRow
                  key={v.id}
                  version={v}
                  trackId={track.id}
                  projectId={project.id}
                  latest={v.id === latest?.id}
                />
              ))}
            </ul>
          </>
        )}
      </StateGate>
    </div>
  );
}
