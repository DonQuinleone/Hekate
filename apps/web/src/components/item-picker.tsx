import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { type Item, itemsIn } from "~/lib/browser";
import { cn } from "~/lib/cn";
import {
  projectFilesQuery,
  projectFoldersQuery,
  projectTracksQuery,
  type Track,
  useItemWords,
} from "~/lib/queries";
import { coveredKeys, folderTick, keyOf, keysBeneath, WORKSPACE_KEY } from "~/lib/review-scope";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { Card } from "./page";
import { Checkbox } from "./ui/choice";
import { Input } from "./ui/input";

/**
 * What a request asks about, by key: `track:<id>`, `file:<id>`, `folder:<id>` or `workspace`
 * (`~/lib/review-scope`).
 */
export type Chosen = Map<string, { versionId: string | null }>;

/**
 * The project's folders, tracks and loose files as a tree with boxes to tick. A track is
 * asked about at its latest version unless one is chosen; a folder ticked covers everything
 * beneath it, files added later included, and shows a dash while only some of it is ticked
 * (#501). "Everything in this workspace" heads the tree for whoever may ask it. A search
 * lists every match flat.
 */
export function ItemPicker({
  projectId,
  chosen,
  onToggle,
  workspace = null,
}: {
  projectId: string;
  chosen: Chosen;
  onToggle: (key: string) => void;
  /** Whether the whole workspace may be chosen, and of how many projects that is. */
  workspace?: { allowed: boolean; projects: number } | null;
}) {
  const { data: folders = [] } = useQuery(projectFoldersQuery(projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: files = [] } = useQuery(projectFilesQuery(projectId));
  const { words, versionLabel } = useItemWords(projectId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const children = (folderId: string | null) => itemsIn(folders, tracks, files, folderId);
  const nameOf = (item: Item) =>
    item.kind === "folder"
      ? item.folder.name
      : item.kind === "track" || item.kind === "version"
        ? item.track.name
        : item.file.name;
  const needle = query.trim().toLowerCase();
  const matches = (folderId: string | null): Item[] =>
    children(folderId).flatMap((item) =>
      item.kind === "folder"
        ? matches(item.id)
        : nameOf(item).toLowerCase().includes(needle)
          ? [item]
          : [],
    );
  const covered = coveredKeys(chosen, children);
  const all = covered === "all";
  const isCovered = (key: string) => all || covered.has(key);

  const row = (item: Item, depth: number): ReactNode => {
    if (item.kind === "version") return null;
    const key = keyOf(item);
    const name = nameOf(item);
    const folder = item.kind === "folder";
    const expanded = folder && open.has(item.id);
    const latest = item.kind === "track" ? latestOf(item.track) : null;
    const pickable = folder || item.kind === "file" || latest !== null;
    const beneath = folder ? keysBeneath(children, item.id) : [];
    const tick = folder
      ? folderTick(key, chosen, covered, beneath)
      : chosen.has(key) || isCovered(key)
        ? "on"
        : "off";
    const within = folder ? beneath.filter((k) => chosen.has(k)).length : 0;
    return (
      <li key={item.id}>
        <div
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-control pr-2 hover:bg-raised/50",
            chosen.has(key) && "bg-raised/40",
          )}
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          {folder ? (
            <button
              type="button"
              aria-label={`${expanded ? "Close" : "Open"} ${name}`}
              aria-expanded={expanded}
              onClick={() => {
                const next = new Set(open);
                if (expanded) next.delete(item.id);
                else next.add(item.id);
                setOpen(next);
              }}
              className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:text-ink"
            >
              <Icon
                name="chevronRight"
                size={12}
                className={cn("transition-transform", expanded && "rotate-90")}
              />
            </button>
          ) : (
            <span className="size-6 shrink-0" />
          )}
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch has-[:disabled]:cursor-not-allowed">
            <span className="flex size-6 shrink-0 items-center justify-center">
              <Checkbox
                checked={tick === "on"}
                indeterminate={tick === "mixed"}
                // Covered by a folder or the workspace ticked above: let go of that first.
                disabled={!pickable || isCovered(key)}
                onChange={() => onToggle(key)}
              />
            </span>
            <Icon
              name={folder ? "folder" : item.kind === "track" ? "track" : kindIcon[item.file.kind]}
              size={15}
              className="shrink-0 text-ink-3"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[14px]",
                pickable ? "text-ink" : "text-ink-3",
              )}
            >
              {name}
            </span>
          </label>
          {folder && tick !== "off" && (
            <span className="tabular shrink-0 text-[12px] text-ink-3">
              {tick === "on" ? "everything in it" : `${within} of ${beneath.length}`}
            </span>
          )}
          {item.kind === "track" && (
            <span className="tabular shrink-0 text-[12px] text-ink-3">
              {latest ? versionLabel(latest.number) : `no ${words.version} yet`}
            </span>
          )}
        </div>
        {expanded && <ul>{children(item.id).map((child) => row(child, depth + 1))}</ul>}
      </li>
    );
  };

  const listed = needle ? matches(null) : children(null);
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <Icon name="search" size={14} className="shrink-0 text-ink-3" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Find a ${words.track} or file`}
          aria-label={`Find a ${words.track} or file`}
          className="h-8 border-transparent bg-transparent px-1 shadow-none hover:border-transparent focus:border-transparent"
        />
      </div>
      {workspace?.allowed && (
        <label
          className={cn(
            "flex h-10 cursor-pointer items-center gap-2.5 border-b border-line px-3",
            all && "bg-raised/40",
          )}
        >
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Checkbox
              checked={all}
              onChange={() => onToggle(WORKSPACE_KEY)}
              aria-label="Everything in this workspace"
            />
          </span>
          <Icon name="globe" size={15} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
            Everything in this workspace
          </span>
          <span className="tabular hidden shrink-0 text-[12px] text-ink-3 sm:inline">
            {workspace.projects === 1 ? "1 project" : `${workspace.projects} projects`}, and those
            to come
          </span>
        </label>
      )}
      {listed.length === 0 ? (
        <p className="px-4 py-6 text-[13px] text-ink-3">
          {needle ? "Nothing here by that name." : "Nothing in this project yet: upload first."}
        </p>
      ) : (
        <ul className="scroll-quiet max-h-[320px] overflow-auto p-1.5">
          {listed.map((item) => row(item, 0))}
        </ul>
      )}
    </Card>
  );
}

export const latestOf = (track: Track) =>
  track.versions.reduce<Track["versions"][number] | null>(
    (best, v) => (!best || v.number > best.number ? v : best),
    null,
  );
