import { useState } from "react";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Chip } from "~/components/permissions";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Textarea } from "~/components/ui/input";
import { Switch } from "~/components/ui/toggle";
import { groups, latestVersion, type Project, personById, tracks } from "~/data";
import { cn } from "~/lib/cn";

/**
 * Sharing is not reviewing: a share gives someone a way to listen or look, with the same
 * protections, and asks nothing of them. One dialog, no steps.
 */
export function ShareDialog({
  project,
  itemId,
  onClose,
}: {
  project: Project;
  itemId?: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"people" | "link">("people");
  const [items, setItems] = useState<Set<string>>(new Set(itemId ? [itemId] : []));
  const [download, setDownload] = useState<"none" | "proxy" | "original">("none");
  const [expires, setExpires] = useState(true);
  const [created, setCreated] = useState(false);
  const candidates = tracks.filter((t) => t.projectId === project.id && latestVersion(t));
  const toggle = (id: string) => {
    const next = new Set(items);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setItems(next);
  };
  return (
    <Dialog
      title="Share"
      description="For someone who only needs to listen or look. Nothing is asked of them, and what they open is logged."
      onClose={onClose}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setCreated(true)} disabled={items.size === 0}>
            {mode === "link" ? "Create the link" : "Send"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label>What</Label>
          <ul className="flex flex-col divide-y divide-line rounded-panel border border-line">
            {candidates.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[14px] text-ink">
                  <input type="checkbox" checked={items.has(t.id)} onChange={() => toggle(t.id)} />
                  <Icon name="track" size={15} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{t.name}</span>
                  <span className="tabular text-[12px] text-ink-3">
                    V{latestVersion(t)?.number}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <Label>With</Label>
          <div className="flex gap-1">
            <Chip active={mode === "people"} onClick={() => setMode("people")}>
              Named people
            </Chip>
            <Chip active={mode === "link"} onClick={() => setMode("link")}>
              A link
            </Chip>
          </div>
          {mode === "people" ? (
            <div className="flex flex-col gap-2">
              <Input placeholder="Names or email addresses" />
              <div className="flex flex-wrap gap-1.5">
                {[
                  ...project.members.map((m) => personById(m.personId).name),
                  ...groups.filter((g) => g.projectId === project.id).map((g) => `${g.name} group`),
                ].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className="h-7 rounded-chip border border-line px-2.5 text-[13px] text-ink-2 hover:border-edge hover:text-ink"
                  >
                    {n}
                  </button>
                ))}
              </div>
              <Textarea rows={2} placeholder="A line to go with it (optional)" />
            </div>
          ) : (
            <p className="text-[13px] text-ink-3">
              Anyone with the link, after entering their email: each visit is logged and each page
              watermarked for them.
            </p>
          )}
        </div>
        <div className="grid gap-4 @md/app:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label>Download</Label>
            <div className="flex gap-1">
              <Chip active={download === "none"} onClick={() => setDownload("none")}>
                None
              </Chip>
              <Chip active={download === "proxy"} onClick={() => setDownload("proxy")}>
                Proxy
              </Chip>
              <Chip active={download === "original"} onClick={() => setDownload("original")}>
                Original
              </Chip>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Expires</Label>
            <div className="flex items-center gap-3">
              <Switch label="Expires" checked={expires} onChange={setExpires} />
              <Input
                type="date"
                defaultValue="2026-10-31"
                className={cn("h-8 w-40", !expires && "opacity-40")}
                disabled={!expires}
              />
            </div>
          </div>
        </div>
        {created && (
          <div className="rise-in flex items-center gap-2 rounded-panel border border-line bg-raised/40 px-3 py-2 text-[13px]">
            <Icon name="link" size={14} className="text-ink-3" />
            <span className="min-w-0 flex-1 truncate text-ink-2">
              https://review.endlesshall.example/s/4k9x-maple
            </span>
            <button type="button" className="text-ink-3 hover:text-ink">
              Copy
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
