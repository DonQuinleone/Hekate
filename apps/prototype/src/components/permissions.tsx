import { useState } from "react";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Seg } from "~/components/player/transport";
import { Button } from "~/components/ui/button";
import { DateTimeField } from "~/components/ui/date-field";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { personById, type Tool } from "~/data";
import { cn } from "~/lib/cn";

export const toolNames: Record<Tool, string> = {
  qa: "QA",
  meters: "Meters",
  spectrogram: "Spectrogram",
  score: "Score",
  takes: "Takes",
  compare: "Compare",
  loops: "Loops",
  normalise: "Normalisation toggle",
  download: "Download",
  production: "Production",
};

export function Chip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-chip border px-2.5 text-[13px] transition-colors",
        active
          ? "border-edge-strong bg-raised pl-1.5 text-ink"
          : "border-line text-ink-3 hover:border-edge hover:text-ink",
      )}
    >
      {active && <Icon name="check" size={13} className="shrink-0" />}
      {children}
    </button>
  );
}

/** One person's permission set: what they see, what they can do, how long for. */
export function Permissions({
  guest,
  compact = false,
  video = false,
}: {
  guest: boolean;
  compact?: boolean;
  /** A video project's words (#670): its earlier cuts, not versions. */
  video?: boolean;
}) {
  const [scope, setScope] = useState<"all" | "own_and_replies" | "own">(
    guest ? "own_and_replies" : "all",
  );
  const [tools, setTools] = useState<Set<Tool>>(
    new Set<Tool>(guest ? ["loops", "score"] : ["loops", "compare", "score", "meters"]),
  );
  const [download, setDownload] = useState<"none" | "proxy" | "original">("none");
  const toggleTool = (t: Tool) => {
    const next = new Set(tools);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    setTools(next);
  };
  return (
    <div
      className={cn(
        "grid gap-5 text-[14px]",
        compact ? "" : "rounded-panel border border-line bg-ground/60 p-4",
        "@3xl/app:grid-cols-2",
      )}
    >
      <div className="flex flex-col gap-1.5">
        <Label>Comments they see</Label>
        <div className="flex">
          <Seg
            size="md"
            label="Comments they see"
            value={scope}
            onChange={setScope}
            options={[
              { id: "all", label: "Everyone's" },
              { id: "own_and_replies", label: "Theirs and replies" },
              { id: "own", label: "Only theirs" },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Actions</Label>
        <div className="flex flex-wrap gap-4 text-ink-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked /> Comment
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked /> Record a decision
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" /> Invite others
          </label>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Tools</Label>
        <div className="flex flex-wrap gap-1">
          {(
            [
              "loops",
              "compare",
              "score",
              "meters",
              "spectrogram",
              "qa",
              "takes",
              "normalise",
            ] as Tool[]
          ).map((t) => (
            <Chip key={t} active={tools.has(t)} onClick={() => toggleTool(t)}>
              {toolNames[t]}
            </Chip>
          ))}
        </div>
        {!guest && (
          <span className="text-[13px] text-ink-3">
            A member keeps the tools of their role; a review can only take away.
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>History and download</Label>
        <div className="flex flex-wrap items-center gap-4 text-ink-2">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" defaultChecked={!guest} /> Earlier {video ? "cuts" : "versions"}
          </label>
          <Seg
            size="md"
            label="Download"
            value={download}
            onChange={setDownload}
            options={[
              { id: "none", label: "No download" },
              { id: "proxy", label: "Proxy" },
              { id: "original", label: "Original" },
            ]}
          />
        </div>
        {download !== "none" && (
          <span className="text-[13px] text-ink-3">Watermarked per recipient and logged.</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 @3xl/app:col-span-2">
        <Label>Access window</Label>
        <div className="flex flex-wrap items-center gap-3 text-ink-2">
          <label className="flex items-center gap-2">
            From <DateTimeField className="w-72" />
          </label>
          <label className="flex items-center gap-2">
            Until <DateTimeField defaultValue={guest ? "2026-10-31T23:59" : ""} className="w-72" />
          </label>
          <label className="flex items-center gap-2">
            At most <Input type="number" placeholder="∞" className="h-8 w-16" /> plays
          </label>
        </div>
      </div>
    </div>
  );
}

/** A person's permissions in the project, or their override for one review. */
export function PermissionsDialog({
  personId,
  guest,
  reviewTitle,
  video = false,
  onClose,
}: {
  personId: string;
  guest: boolean;
  reviewTitle?: string;
  video?: boolean;
  onClose: () => void;
}) {
  const person = personById(personId);
  return (
    <Dialog
      title={reviewTitle ? `${person.name} in ${reviewTitle}` : `${person.name}'s permissions`}
      description={
        reviewTitle
          ? "An override for this review only. Their usual permissions are set from People."
          : guest
            ? "What this reviewer sees and may do in every review they are invited to here. A review can override it."
            : "What a review grants this member on top of their role. A review can only take away."
      }
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onClose}>
            Save
          </Button>
        </>
      }
    >
      <Permissions guest={guest} compact video={video} />
    </Dialog>
  );
}
