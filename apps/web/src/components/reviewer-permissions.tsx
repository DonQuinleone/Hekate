import {
  type CommentScope,
  type DownloadLevel,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerTool,
  type ReviewKind,
  reviewerTools,
} from "@hekate/shared";
import { type FormEvent, useId, useState } from "react";
import { cn } from "~/lib/cn";
import { fromLocalInput, toLocalInput } from "~/lib/permissions";
import { Button } from "./ui/button";
import { Choice } from "./ui/choice";
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
  compare: "Compare",
  qa: "QA",
  score: "Score",
};

const chip = "h-7 cursor-pointer rounded-chip border px-2.5 text-xs";
const on = "border-edge bg-raised text-ink";
const off = "border-transparent bg-transparent text-ink-3 hover:text-ink";

/**
 * What one reviewer may do in this review, edited in place: whose comments they see,
 * whether they comment and decide, which tools they have, and when they have access.
 */
const downloadChoices: { value: DownloadLevel; label: string }[] = [
  { value: "none", label: "No download" },
  { value: "proxy", label: "Proxy" },
  { value: "original", label: "Original" },
];

export function ReviewerPermissionsEditor({
  name,
  kind,
  guest,
  initial,
  items,
  standing = false,
  pending,
  error,
  onSave,
  onCancel,
}: {
  name: string;
  kind: ReviewKind;
  /** A guest gets exactly this; a member's comments and tools follow their project role. */
  guest: boolean;
  initial: ReviewerPermissions;
  /** The review's items, to choose which a guest sees; left out before the review exists. */
  items?: { id: string; name: string }[];
  /** What holds in every review of a project (#55): no dates, which belong to one review. */
  standing?: boolean;
  pending: boolean;
  error: string | null;
  onSave: (change: ReviewerPermissionsChange) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState(initial);
  // A share's people only listen and look (#138): no comments, decisions or invitations.
  const share = kind === "share";
  const [from, setFrom] = useState(toLocalInput(initial.startsAt));
  const [until, setUntil] = useState(toLocalInput(initial.expiresAt));
  const [plays, setPlays] = useState(initial.maxPlays ? String(initial.maxPlays) : "");
  const shown = p.items ?? null;
  const toggleItem = (item: string) => {
    const all = (items ?? []).map((i) => i.id);
    const current = shown ?? all;
    const next = current.includes(item) ? current.filter((i) => i !== item) : [...current, item];
    // Every item chosen is the same as no choice: new items join them too.
    setP({ ...p, items: next.length === all.length ? null : next });
  };
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
      invite: p.invite ?? false,
      comments: p.comments,
      tools: reviewerTools.filter((t) => p.tools.includes(t)),
      ...(guest
        ? {
            download: p.download ?? "none",
            history: p.history ?? false,
            items: shown,
            maxPlays: plays.trim() ? Math.max(1, Math.round(Number(plays))) : null,
          }
        : {}),
      ...(standing ? {} : { startsAt: fromLocalInput(from), expiresAt: fromLocalInput(until) }),
    });
  };
  return (
    <form
      onSubmit={submit}
      aria-label={`What ${name} may do`}
      className="mt-1 flex flex-col gap-4 rounded-panel border border-hairline bg-surface p-4"
    >
      {guest && !share && (
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
        {guest && !share && (
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
        {!share && (
          <Toggle
            label="Invite others"
            checked={p.invite ?? false}
            onChange={(invite) => setP({ ...p, invite })}
          />
        )}
        {guest && (
          <Toggle
            label="Earlier versions"
            checked={p.history ?? false}
            onChange={(history) => setP({ ...p, history })}
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
      {guest && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Download</legend>
          <div className="flex flex-wrap gap-1">
            {downloadChoices.map((d) => (
              <button
                key={d.value}
                type="button"
                aria-pressed={(p.download ?? "none") === d.value}
                onClick={() => setP({ ...p, download: d.value })}
                className={cn(chip, (p.download ?? "none") === d.value ? on : off)}
              >
                {d.label}
              </button>
            ))}
          </div>
          {(p.download ?? "none") !== "none" && (
            <span className="text-xs text-ink-3">
              Made for them, marked where the file allows, and logged.
            </span>
          )}
        </fieldset>
      )}
      {guest && items && items.length > 1 && (
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Items they see</legend>
          {items.map((item) => (
            <Choice
              key={item.id}
              checked={shown === null || shown.includes(item.id)}
              // At least one: a reviewer with nothing to review is no reviewer.
              disabled={shown !== null && shown.length === 1 && shown.includes(item.id)}
              onChange={() => toggleItem(item.id)}
            >
              {item.name}
            </Choice>
          ))}
        </fieldset>
      )}
      {(!standing || guest) && (
        <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2">
          <legend className="label mb-2">Access</legend>
          {!standing && (
            <>
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
            </>
          )}
          {guest && (
            <span className="flex flex-col gap-1">
              <label htmlFor={`${id}-plays`} className="text-xs text-ink-3">
                Plays of each file, at most
              </label>
              <Input
                id={`${id}-plays`}
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                placeholder="No limit"
                value={plays}
                onChange={(e) => setPlays(e.target.value)}
              />
            </span>
          )}
        </fieldset>
      )}
      <p className="m-0 text-xs text-ink-3">
        {standing
          ? "For every review of this project that asks them; a review can still change it for itself."
          : "Left empty, access runs from now until the review ends."}
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
