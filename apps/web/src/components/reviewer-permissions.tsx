import {
  type CommentScope,
  type DownloadLevel,
  itemWords,
  type ProjectProfile,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerTool,
  type ReviewKind,
  reviewerTools,
} from "@hekate/shared";
import { type FormEvent, useId, useState } from "react";
import { fromLocalInput, toLocalInput } from "~/lib/permissions";
import { Button } from "./ui/button";
import { ToggleChip } from "./ui/chip";
import { Choice } from "./ui/choice";
import { DateTimeField } from "./ui/date-field";
import { Input } from "./ui/input";
import { Segmented } from "./ui/segmented";
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

/**
 * What one reviewer may do in this review, edited in place: whose comments they see,
 * whether they comment and decide, which tools they have, and when they have access.
 */
const downloadChoices: { value: DownloadLevel; label: string }[] = [
  { value: "none", label: "No download" },
  { value: "proxy", label: "Review copy" },
  { value: "original", label: "Original" },
];

export function ReviewerPermissionsEditor({
  name,
  kind,
  guest,
  initial,
  items,
  standing = false,
  profile = null,
  pending,
  error,
  onSave,
  onCancel,
  formId,
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
  /** The project's profile, for its words (#670): a video project's earlier cuts. */
  profile?: ProjectProfile | null;
  pending: boolean;
  error: string | null;
  onSave: (change: ReviewerPermissionsChange) => void;
  onCancel: () => void;
  /**
   * Inside a dialog that draws its own footer: the form takes this id for the footer's Save
   * (`form={formId}`), and draws neither its card nor its buttons.
   */
  formId?: string;
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
      id={formId}
      onSubmit={submit}
      aria-label={`What ${name} may do`}
      className="flex flex-col gap-4"
    >
      {guest && !share && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Comments they see</legend>
          <Segmented
            label="Comments they see"
            value={p.comments}
            options={scopes}
            onChange={(comments) => setP({ ...p, comments })}
            className="self-start"
          />
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
            label={`Earlier ${itemWords(profile).versions}`}
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
              <ToggleChip key={t} pressed={p.tools.includes(t)} onClick={() => toggleTool(t)}>
                {toolLabels[t]}
              </ToggleChip>
            ))}
          </div>
        </fieldset>
      )}
      {guest && (
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label mb-2">Download</legend>
          <Segmented
            label="Download"
            value={p.download ?? "none"}
            options={downloadChoices}
            onChange={(download) => setP({ ...p, download })}
            className="self-start"
          />
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
                <DateTimeField id={`${id}-from`} value={from} onChange={setFrom} />
              </span>
              <span className="flex flex-col gap-1">
                <label htmlFor={`${id}-until`} className="text-xs text-ink-3">
                  Until
                </label>
                <DateTimeField id={`${id}-until`} value={until} onChange={setUntil} />
              </span>
              {/* Under the fields it is about (#670), not under the plays beside them. */}
              <span className="text-xs text-ink-3 sm:col-span-2">
                Left empty, access runs from now until the review ends.
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
      {(standing || !guest) && (
        <p className="m-0 text-xs text-ink-3">
          {[
            standing
              ? "For every review of this project that asks them; a review can still change it for itself."
              : "",
            guest ? "" : "Their comments and tools follow their role in the project.",
          ]
            .filter(Boolean)
            .join(" ")}
        </p>
      )}
      {error && <p className="m-0 text-xs text-signal">{error}</p>}
      {!formId && (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={pending}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
