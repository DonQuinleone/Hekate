import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/label";
import { Thumb } from "~/components/thumb";
import { projectById } from "~/data";
import { cn } from "~/lib/cn";
import { everything, groupStep, type Hit, type HitGroup, matches, recent } from "~/lib/search";
import { useViewer } from "~/viewer/context";

/** Ctrl or ⌘ K, whichever the keyboard has. */
export const paletteKey = navigator.platform.startsWith("Mac") ? "⌘K" : "Ctrl K";

/**
 * One place to go anywhere and do anything: the palette answers a few letters with pages, actions and
 * everything the viewer may see. Arrow keys move, Tab jumps a group, Enter opens, Escape closes;
 * `>` narrows to actions.
 */
export function CommandPalette({
  open,
  onClose,
  onToggleSidebar,
}: {
  open: boolean;
  onClose: () => void;
  onToggleSidebar: () => void;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const projectId = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const project = projectId ? projectById(projectId) : undefined;
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  const owner = viewer.persona.organisationRole === "owner";

  const pages = useMemo<Hit[]>(
    () =>
      [
        { id: "go-home", label: "Home", icon: "dashboard" as const, to: "/", shortcut: "G H" },
        { id: "go-inbox", label: "Inbox", icon: "inbox" as const, to: "/inbox", shortcut: "G I" },
        {
          id: "go-projects",
          label: "Projects",
          icon: "folder" as const,
          to: "/projects",
          shortcut: "G P",
        },
        { id: "go-members", label: "Members", icon: "users" as const, to: "/settings/members" },
        ...(elevated
          ? [
              {
                id: "go-settings",
                label: "Workspace settings",
                icon: "settings" as const,
                to: "/settings",
              },
            ]
          : []),
        { id: "go-account", label: "Your account", icon: "user" as const, to: "/account" },
        ...(owner
          ? [
              {
                id: "go-instance",
                label: "Instance management",
                icon: "fingerprint" as const,
                to: "/instance",
              },
            ]
          : []),
      ].map((p) => ({
        id: p.id,
        group: "Jump to" as HitGroup,
        label: p.label,
        icon: p.icon,
        shortcut: p.shortcut,
        destination: { to: p.to },
      })),
    [elevated, owner],
  );

  const actions = useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    if (project) {
      const inProject = (view: string, search?: Record<string, string>) => ({
        to: "/projects/$projectId/$view",
        params: { projectId: project.id, view },
        search,
      });
      if (viewer.can(project.id, "upload"))
        out.push({
          id: "act-upload",
          group: "Actions",
          label: "Upload files",
          hint: project.name,
          icon: "upload",
          destination: inProject("files"),
        });
      if (viewer.can(project.id, "request_reviews"))
        out.push({
          id: "act-review",
          group: "Actions",
          label: "Request a review",
          hint: project.name,
          icon: "review",
          destination: { to: "/reviews/new", search: { project: project.id } },
        });
      out.push({
        id: "act-task",
        group: "Actions",
        label: "New task",
        hint: project.name,
        icon: "task",
        destination: inProject("tasks", { new: "1" }),
      });
      if (viewer.can(project.id, "manage_roles"))
        out.push({
          id: "act-project-settings",
          group: "Actions",
          label: "Project settings",
          hint: project.name,
          icon: "sliders",
          destination: inProject("settings"),
        });
    } else {
      out.push({
        id: "act-new-project",
        group: "Actions",
        label: "New project",
        icon: "folderPlus",
        destination: { to: "/projects", search: { new: "1" } },
      });
      out.push({
        id: "act-review",
        group: "Actions",
        label: "Request a review",
        icon: "review",
        destination: { to: "/reviews/new" },
      });
    }
    out.push({
      id: "act-sidebar",
      group: "Actions",
      label: "Toggle the sidebar",
      icon: "sidebar",
      shortcut: "[",
      run: onToggleSidebar,
    });
    out.push({
      id: "act-notifications",
      group: "Actions",
      label: "All notifications",
      icon: "bell",
      destination: { to: "/notifications" },
    });
    out.push({
      id: "act-search",
      group: "Actions",
      label: "Search with filters",
      hint: "Type, length, size, tags, who uploaded",
      icon: "filter",
      destination: { to: "/search", search: query.trim() ? { q: query.trim() } : undefined },
    });
    out.push({
      id: "act-signout",
      group: "Actions",
      label: "Sign out",
      icon: "logout",
      destination: { to: "/sign-in" },
    });
    return out;
  }, [project, viewer, onToggleSidebar, query]);

  const all = useMemo(() => everything(viewer), [viewer]);
  const recents = useMemo(() => recent(viewer), [viewer]);

  const onlyActions = query.startsWith(">");
  const q = onlyActions ? query.slice(1) : query;
  const hits = useMemo(() => {
    if (onlyActions) return matches(q, actions, 12);
    if (!q.trim()) return [...pages, ...recents, ...actions.slice(0, 4)];
    return matches(q, [...pages, ...actions, ...all], 5);
  }, [q, onlyActions, pages, recents, actions, all]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight returns to the top when the list changes.
  useEffect(() => setIndex(0), [q]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const go = (hit: Hit) => {
    onClose();
    if (hit.run) hit.run();
    else if (hit.destination)
      navigate({
        to: hit.destination.to,
        params: hit.destination.params ?? {},
        search: hit.destination.search ?? {},
      });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Tab") {
      // Tab moves between groups, keeping focus in the field.
      e.preventDefault();
      setIndex((i) => groupStep(hits, i, e.shiftKey));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[index];
      if (hit) go(hit);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  let lastGroup: HitGroup | null = null;
  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-canvas/60 p-3 pt-3 backdrop-blur-[2px] @3xl/app:p-6 @3xl/app:pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-label="Search and commands"
        className="rise-in relative flex max-h-[min(560px,100%)] w-full max-w-[620px] flex-col overflow-hidden rounded-panel-lg border border-line bg-overlay shadow-4"
        onKeyDown={onKey}
      >
        <div className="flex h-13 items-center gap-3 border-b border-line px-4">
          <Icon name="search" size={18} className="shrink-0 text-ink-3" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              project ? `Search ${project.name}, or type a command` : "Search, or type a command"
            }
            aria-label="Search and commands"
            aria-activedescendant={hits[index] ? `palette-${hits[index].id}` : undefined}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-ink placeholder:text-ink-3 focus:outline-none focus-visible:shadow-none"
          />
          <Kbd>esc</Kbd>
        </div>
        <div ref={list} className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-2">
          {hits.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-ink-3">
              Nothing matches “{q.trim()}” in what you may see.
            </p>
          ) : (
            hits.map((hit, i) => {
              const head = hit.group !== lastGroup;
              lastGroup = hit.group;
              return (
                <div key={`${hit.group}-${hit.id}`}>
                  {head && (
                    <div
                      className={cn("eyebrow px-3 pb-1 text-[11px]", i === 0 ? "pt-1.5" : "pt-3")}
                    >
                      {hit.group}
                    </div>
                  )}
                  <ResultRow
                    hit={hit}
                    index={i}
                    active={i === index}
                    onSelect={go}
                    onHover={setIndex}
                  />
                </div>
              );
            })
          )}
        </div>
        <div className="flex h-9 items-center gap-4 border-t border-line px-4 text-[12px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>↵</Kbd> open
          </span>
          <span className="hidden items-center gap-1.5 @3xl/app:flex">
            <Kbd>tab</Kbd> next group
          </span>
          <span className="hidden items-center gap-1.5 @3xl/app:flex">
            <Kbd>{">"}</Kbd> commands only
          </span>
          <span className="ml-auto hidden @3xl/app:inline">Only what you may see</span>
        </div>
      </div>
    </div>
  );
}

/** One hit: what it is at the left, where it lives at the right. The search page lists the same rows. */
export function ResultRow({
  hit,
  index = 0,
  active = false,
  onSelect,
  onHover,
}: {
  hit: Hit;
  index?: number;
  active?: boolean;
  onSelect: (hit: Hit) => void;
  onHover?: (index: number) => void;
}) {
  return (
    <button
      type="button"
      id={`palette-${hit.id}`}
      data-index={index}
      onClick={() => onSelect(hit)}
      onPointerMove={() => onHover?.(index)}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-control px-3 text-left transition-colors",
        active ? "bg-raised text-ink" : "text-ink-2",
        !onHover && "hover:bg-raised/60 hover:text-ink",
      )}
    >
      <span className="flex w-7 shrink-0 items-center justify-center">
        {hit.file ? (
          <Thumb file={hit.file} width={28} height={18} />
        ) : hit.personId ? (
          <Avatar personId={hit.personId} size={20} />
        ) : (
          <Icon
            name={hit.icon ?? "arrowRight"}
            size={16}
            className={active ? "text-ink" : "text-ink-3"}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[14px]">{hit.label}</span>
      {hit.hint && (
        <span className="hidden max-w-[40%] truncate text-[12px] text-ink-3 @3xl/app:inline">
          {hit.hint}
        </span>
      )}
      {hit.shortcut && (
        <span className="hidden shrink-0 items-center gap-1 @3xl/app:flex">
          {hit.shortcut.split(" ").map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
    </button>
  );
}
