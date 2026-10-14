import {
  type CommentScope,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerTool,
  reviewerTools,
} from "@hekate/shared";
import { type FormEvent, useId, useState } from "react";
import { cn } from "~/lib/cn";
import { fromLocalInput, toLocalInput } from "~/lib/permissions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Toggle } from "./ui/toggle";

const scopes: { value: CommentScope; label: string }[] = [
  { value: "all", label: "Everyone's" },
  { value: "own_and_replies", label: "Theirs and replies" },
  { value: "own", label: "Only theirs" },
];

const toolLabels: Record<ReviewerTool, string> = {
  spectrogram: "Spectrogram",
  meters: "Meters",
  loops: "Loops",
};

const chip = "h-7 cursor-pointer rounded-chip border px-2.5 text-xs";
const on = "border-edge bg-raised text-ink";
const off = "border-transparent bg-transparent text-ink-3 hover:text-ink";

/**
 * What one reviewer may do in this review, edited in place: whose comments they see,
 * whether they comment and decide, which tools they have, and when they have access.
 */
export function ReviewerPermissionsEditor({
  name,
  kind,
  guest,
  initial,
  pending,
  error,
  onSave,
  onCancel,
}: {
  name: string;
  kind: "approval" | "feedback";
  /** A guest gets exactly this; a member's comments and tools follow their project role. */
  guest: boolean;
  initial: ReviewerPermissions;
  pending: boolean;
  error: string | null;
  onSave: (change: ReviewerPermissionsChange) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState(initial);
  const [from, setFrom] = useState(toLocalInput(initial.startsAt));
  const [until, setUntil] = useState(toLocalInput(initial.expiresAt));
  const id = useId();
  const toggleTool = (tool: ReviewerTool) =>
    setP((x) => ({
      ...x,
      tools: x.tools.includes(tool) ? x.tools.filter((t) => t !== tool) : [...x.tools, tool],
    }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({
      comment: p.comment,
      decide: p.decide,
      comments: p.comments,
      tools: reviewerTools.filter((t) => p.tools.includes(t)),
      startsAt: fromLocalInput(from),
      expiresAt: fromLocalInput(until),
    });
  };
  return (
    <form
      onSubmit={submit}
      aria-label={`What ${name} may do`}
      className="mt-1 flex flex-col gap-4 rounded-panel border border-hairline bg-surface p-4"
    >
      {guest && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Comments they see</legend>
          <div className="flex flex-wrap gap-1">
            {scopes.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={p.comments === s.value}
                onClick={() => setP({ ...p, comments: s.value })}
                className={cn(chip, p.comments === s.value ? on : off)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex max-w-72 flex-col gap-2.5">
        {guest && (
          <Toggle
            label="Comment"
            checked={p.comment}
            onChange={(comment) => setP({ ...p, comment })}
          />
        )}
        {kind === "approval" && (
          <Toggle
            label="Record a decision"
            checked={p.decide}
            onChange={(decide) => setP({ ...p, decide })}
          />
        )}
      </div>
      {guest && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Tools</legend>
          <div className="flex flex-wrap gap-1">
            {reviewerTools.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={p.tools.includes(t)}
                onClick={() => toggleTool(t)}
                className={cn(chip, p.tools.includes(t) ? on : off)}
              >
                {toolLabels[t]}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="m-0 grid grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="label mb-2">Access</legend>
        <span className="flex flex-col gap-1">
          <label htmlFor={`${id}-from`} className="text-xs text-ink-3">
            From
          </label>
          <Input
            id={`${id}-from`}
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </span>
        <span className="flex flex-col gap-1">
          <label htmlFor={`${id}-until`} className="text-xs text-ink-3">
            Until
          </label>
          <Input
            id={`${id}-until`}
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </span>
      </fieldset>
      <p className="m-0 text-xs text-ink-3">
        Left empty, access runs from now until the review ends.
        {guest ? "" : " Their comments and tools follow their role in the project."}
      </p>
      {error && <p className="m-0 text-xs text-signal">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={pending}>
          Save
        </Button>
      </div>
    </form>
  );
}
