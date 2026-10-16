import type { SearchResult } from "@hekate/shared";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import {
  groupStep,
  type Hit,
  type HitGroup,
  matches,
  readRecent,
  rememberRecent,
} from "~/lib/palette";
import { meQuery, projectsQuery, searchQuery, useProjectCan } from "~/lib/queries";
import { BareInput } from "./ui/input";

const kindGroup: Record<SearchResult["kind"], { group: HitGroup; icon: IconName }> = {
  projects: { group: "Projects", icon: "folder" },
  tracks: { group: "Tracks", icon: "track" },
  files: { group: "Files", icon: "file" },
  reviews: { group: "Reviews", icon: "review" },
  people: { group: "People", icon: "user" },
  comments: { group: "Comments", icon: "comment" },
};

/*
 * Muted text on the overlay uses ink-2: ink-3 falls short of 4.5:1 on the overlay's
 * lighter ground at these sizes.
 */

/**
 * One place to go anywhere and do anything: the palette answers a few letters with pages,
 * actions and everything the member may see. Arrow keys move, Enter opens, Escape closes;
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
  const navigate = useNavigate();
  const client = useQueryClient();
  const { pathname } = useLocation();
  const { data: me } = useQuery(meQuery);
  const { data: projects = [] } = useQuery(projectsQuery);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const role = me?.organisations.find((o) => o.id === me.activeOrganisationId)?.role ?? "member";
  const projectId = pathname.match(/^\/projects\/([0-9a-f-]{36})/)?.[1];
  const project = projects.find((p) => p.id === projectId);
  const can = useProjectCan(project?.id);
  const scope = me ? `${me.user.id}:${me.activeOrganisationId}` : "";

  const onlyActions = query.startsWith(">");
  const q = (onlyActions ? query.slice(1) : query).trim();
  // The server is asked once typing settles, and the last answer stays while it thinks.
  const asked = useDeferredValue(onlyActions ? "" : q);
  const { data: found = [] } = useQuery({
    ...searchQuery({ q: asked }),
    enabled: open && asked.length > 0,
    placeholderData: keepPreviousData,
  });

  const pages = useMemo<Hit[]>(
    () => [
      {
        id: "go-home",
        group: "Jump to",
        label: "Home",
        icon: "dashboard",
        link: "/",
        shortcut: "G H",
      },
      {
        id: "go-inbox",
        group: "Jump to",
        label: "Inbox",
        icon: "inbox",
        link: "/inbox",
        shortcut: "G I",
      },
      {
        id: "go-projects",
        group: "Jump to",
        label: "Projects",
        icon: "folder",
        link: "/projects",
        shortcut: "G P",
      },
      {
        id: "go-search",
        group: "Jump to",
        label: "Search",
        icon: "search",
        link: "/search",
      },
      {
        id: "go-members",
        group: "Jump to",
        label: "Members",
        icon: "users",
        link: "/settings/members",
      },
      ...(role !== "member"
        ? [
            {
              id: "go-settings",
              group: "Jump to" as const,
              label: "Workspace settings",
              icon: "settings" as const,
              link: "/settings/general",
            },
          ]
        : []),
      {
        id: "go-account",
        group: "Jump to",
        label: "Your account",
        icon: "user",
        link: "/account/notifications",
      },
    ],
    [role],
  );

  const actions = useMemo<Hit[]>(() => {
    const out: Hit[] = [];
    if (project) {
      // Only what this member's role in the project allows.
      if (can("upload"))
        out.push({
          id: "act-files",
          group: "Actions",
          label: "Upload files",
          hint: project.name,
          icon: "upload",
          link: `/projects/${project.id}/files`,
        });
      if (can("request_reviews"))
        out.push({
          id: "act-reviews",
          group: "Actions",
          label: "Request a review",
          hint: project.name,
          icon: "review",
          link: `/projects/${project.id}/reviews/new`,
        });
      out.push({
        id: "act-people",
        group: "Actions",
        label: "People in this project",
        hint: project.name,
        icon: "users",
        link: `/projects/${project.id}/people`,
      });
    } else {
      out.push({
        id: "act-new-project",
        group: "Actions",
        label: "New project",
        icon: "folderPlus",
        link: "/projects?new=1",
      });
    }
    out.push(
      {
        id: "act-sidebar",
        group: "Actions",
        label: "Show or hide the sidebar",
        icon: "sidebar",
        shortcut: "[",
        run: onToggleSidebar,
      },
      {
        id: "act-notifications",
        group: "Actions",
        label: "All notifications",
        icon: "bell",
        link: "/notifications",
      },
      {
        id: "act-signout",
        group: "Actions",
        label: "Sign out",
        icon: "logout",
        run: () =>
          void authClient.signOut().then(() => {
            client.clear();
            void navigate({ to: "/sign-in" });
          }),
      },
    );
    return out;
  }, [project, can, onToggleSidebar, client, navigate]);

  const [recent, setRecent] = useState<Hit[]>([]);
  const hits = useMemo(() => {
    if (onlyActions) return matches(q, actions, 12);
    if (!q) return [...pages, ...recent, ...actions.slice(0, 3)];
    const results = found.map(
      (r): Hit => ({
        id: `${r.kind}-${r.id}`,
        group: kindGroup[r.kind].group,
        label: r.label,
        hint: r.hint,
        icon: kindGroup[r.kind].icon,
        link: r.link,
      }),
    );
    // The search page takes it further: filters, and searches kept for later.
    const further: Hit = {
      id: "search-page",
      group: "Search",
      label: `Search for “${q}” with filters`,
      icon: "search",
      link: `/search?q=${encodeURIComponent(q)}`,
    };
    return [...matches(q, [...pages, ...actions], 5), ...results, further];
  }, [q, onlyActions, pages, recent, actions, found]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    setRecent(scope ? readRecent(scope) : []);
    requestAnimationFrame(() => input.current?.focus());
  }, [open, scope]);
  // The highlight returns to the top whenever the list changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: hits is the trigger, not a value used.
  useEffect(() => setIndex(0), [hits]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const go = (hit: Hit) => {
    onClose();
    if (scope) rememberRecent(hit, scope);
    if (hit.run) hit.run();
    else if (hit.link) void navigate({ href: hit.link });
  };

  const onKey = (e: KeyboardEvent) => {
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
    <div className="absolute inset-0 z-50 flex items-start justify-center bg-canvas/60 p-3 backdrop-blur-[2px] @3xl/app:p-6 @3xl/app:pt-[12vh]">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search and commands"
        data-e2e-overlap
        className="rise-in relative flex max-h-[min(560px,100%)] w-full max-w-[620px] flex-col overflow-hidden rounded-panel-lg border border-line bg-overlay shadow-4"
        onKeyDown={onKey}
      >
        <div className="flex h-13 items-center gap-3 border-b border-line px-4">
          <Icon name="search" size={18} className="shrink-0 text-ink-3" />
          <BareInput
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              project ? `Search, or type a command in ${project.name}` : "Search, or type a command"
            }
            aria-label="Search and commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={hits[index] ? `palette-${hits[index].id}` : undefined}
            className="h-full flex-1 text-[16px]"
          />
          <Kbd>esc</Kbd>
        </div>
        <div
          ref={list}
          id="palette-results"
          role="listbox"
          aria-label="Results"
          className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-2"
        >
          {hits.length === 0 ? (
            <p className="m-0 px-3 py-8 text-center text-[13px] text-ink-2">
              Nothing matches “{q}” in what you may see.
            </p>
          ) : (
            hits.map((hit, i) => {
              const head = hit.group !== lastGroup;
              lastGroup = hit.group;
              return (
                <div key={`${hit.group}-${hit.id}`} role="presentation">
                  {head && (
                    <div
                      role="presentation"
                      className={cn(
                        "eyebrow px-3 pb-1 text-[11px] text-ink-2",
                        i === 0 ? "pt-1.5" : "pt-3",
                      )}
                    >
                      {hit.group}
                    </div>
                  )}
                  <div
                    id={`palette-${hit.id}`}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === index}
                    data-index={i}
                    onClick={() => go(hit)}
                    onKeyDown={() => undefined}
                    onPointerMove={() => setIndex(i)}
                    className={cn(
                      "flex h-10 w-full cursor-pointer items-center gap-3 rounded-control px-3 text-left transition-colors",
                      i === index ? "bg-raised text-ink" : "text-ink-2",
                    )}
                  >
                    <Icon
                      name={hit.icon}
                      size={16}
                      className={cn("shrink-0", i === index ? "text-ink" : "text-ink-3")}
                    />
                    <span className="min-w-0 flex-1 truncate text-[14px]">{hit.label}</span>
                    {hit.hint && (
                      <span className="hidden max-w-[40%] truncate text-[12px] text-ink-2 @3xl/app:inline">
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
                  </div>
                </div>
              );
            })
          )}
        </div>
        <div className="flex h-9 items-center gap-4 border-t border-line px-4 text-[12px] text-ink-2">
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
