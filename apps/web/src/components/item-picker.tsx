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
import { kindIcon } from "./files";
import { Icon } from "./icons";
import { Card } from "./page";
import { Checkbox } from "./ui/choice";
import { Input } from "./ui/input";

/** What a request asks about, by key: `track:<id>` or `file:<id>`. */
export type Chosen = Map<string, { versionId: string | null }>;

/**
 * The project's folders, tracks and loose files as a tree with boxes to tick. A track is
 * asked about at its latest version unless one is chosen; a search lists every match flat.
 */
export function ItemPicker({
  projectId,
  chosen,
  onToggle,
}: {
  projectId: string;
  chosen: Chosen;
  onToggle: (key: string) => void;
}) {
  const { data: folders = [] } = useQuery(projectFoldersQuery(projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: files = [] } = useQuery(projectFilesQuery(projectId));
  const { words, versionLabel } = useItemWords(projectId);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const children = (folderId: string | null) => itemsIn(folders, tracks, files, folderId);
  const keyOf = (item: Item) => `${item.kind}:${item.id}`;
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

  const row = (item: Item, depth: number): ReactNode => {
    if (item.kind === "version") return null;
    const name = nameOf(item);
    const folder = item.kind === "folder";
    const expanded = folder && open.has(item.id);
    const latest = item.kind === "track" ? latestOf(item.track) : null;
    const pickable = item.kind === "file" || (item.kind === "track" && latest !== null);
    return (
      <li key={item.id}>
        <div
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-control pr-2 hover:bg-raised/50",
            chosen.has(keyOf(item)) && "bg-raised/40",
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
          ) : null}
          {folder ? (
            <>
              <Icon name="folder" size={15} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>
            </>
          ) : (
            <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch has-[:disabled]:cursor-not-allowed">
              <span className="flex size-6 shrink-0 items-center justify-center">
                <Checkbox
                  checked={chosen.has(keyOf(item))}
                  disabled={!pickable}
                  onChange={() => onToggle(keyOf(item))}
                />
              </span>
              <Icon
                name={item.kind === "track" ? "track" : kindIcon[item.file.kind]}
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
