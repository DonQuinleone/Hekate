import type { DotState } from "~/components/status";
import {
  latestVersion,
  type Project,
  type Review,
  reviews,
  type Stage,
  type Track,
  type Version,
  type Workflow,
  workflows,
} from "~/data";

export interface TrackState {
  version: Version | undefined;
  /** What the row says: the status, or what processing is doing. */
  label: string;
  dot: DotState;
  stage: Stage | undefined;
  next: Stage | undefined;
  review: Review | undefined;
  /** Who the track waits on now: reviewers yet to respond, or the people of a task stage. */
  waitingOn: string[];
  workflow: Workflow | undefined;
}

const roleOf = (participants: string, project: Project) => {
  const name = participants.split(/[,(]/)[0]?.trim().toLowerCase() ?? "";
  const role = project.roles.find((r) => r.name.toLowerCase() === name);
  return role ? project.members.filter((m) => m.roleId === role.id).map((m) => m.personId) : [];
};

/** Where a track stands in its project's workflow, and who holds it up. */
export function trackState(track: Track, project: Project): TrackState {
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const version = latestVersion(track);
  const stage = workflow?.stages.find((s) => s.status === version?.status);
  const next = workflow?.stages.find((s) => s.after.includes(stage?.id ?? ""));
  const review = reviews.find(
    (r) =>
      r.projectId === project.id &&
      r.status === "open" &&
      r.items.some((i) => i.trackId === track.id),
  );
  const waitingOn = review
    ? review.reviewers
        .filter((r) => r.state !== "submitted" && r.state !== "observing" && r.state !== "waiting")
        .map((r) => r.personId)
    : stage?.kind === "task"
      ? roleOf(stage.participants, project)
      : [];
  const label = !version
    ? "No version"
    : version.state === "pending"
      ? "Analysing"
      : version.state === "failed"
        ? "Failed"
        : version.status;
  const dot: DotState = !version
    ? "invited"
    : version.status === "Approved"
      ? "approved"
      : version.state === "failed"
        ? "changes_requested"
        : version.state === "pending"
          ? "working"
          : "in_review";
  return { version, label, dot, stage, next, review, waitingOn, workflow };
}
