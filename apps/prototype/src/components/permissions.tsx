import { useState } from "react";
import { Label } from "~/components/label";
import { Button } from "~/components/ui/button";
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
        "h-7 rounded-chip border px-2.5 text-[13px] transition-colors",
        active
          ? "border-edge bg-raised text-ink shadow-1"
          : "border-transparent text-ink-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** One person's permission set: what they see, what they can do, how long for. */
export function Permissions({ guest, compact = false }: { guest: boolean; compact?: boolean }) {
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
        <div className="flex flex-wrap gap-1">
          <Chip active={scope === "all"} onClick={() => setScope("all")}>
            Everyone's
          </Chip>
          <Chip active={scope === "own_and_replies"} onClick={() => setScope("own_and_replies")}>
            Theirs and replies
          </Chip>
          <Chip active={scope === "own"} onClick={() => setScope("own")}>
            Only theirs
          </Chip>
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
            <input type="checkbox" defaultChecked={!guest} /> Earlier versions
          </label>
          <span className="flex items-center gap-1">
            <Chip active={download === "none"} onClick={() => setDownload("none")}>
              No download
            </Chip>
            <Chip active={download === "proxy"} onClick={() => setDownload("proxy")}>
              Proxy
            </Chip>
            <Chip active={download === "original"} onClick={() => setDownload("original")}>
              Original
            </Chip>
          </span>
        </div>
        {download !== "none" && (
          <span className="text-[13px] text-ink-3">Watermarked per recipient and logged.</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5 @3xl/app:col-span-2">
        <Label>Access window</Label>
        <div className="flex flex-wrap items-center gap-3 text-ink-2">
          <label className="flex items-center gap-2">
            From <Input type="datetime-local" className="h-8 w-44" />
          </label>
          <label className="flex items-center gap-2">
            Until{" "}
            <Input
              type="datetime-local"
              defaultValue={guest ? "2026-10-31T23:59" : ""}
              className="h-8 w-44"
            />
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
  onClose,
}: {
  personId: string;
  guest: boolean;
  reviewTitle?: string;
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
      <Permissions guest={guest} compact />
    </Dialog>
  );
}
