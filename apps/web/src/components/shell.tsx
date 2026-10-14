import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Lockup } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import {
  healthQuery,
  meQuery,
  myReviewsQuery,
  projectsQuery,
  useSwitchOrganisation,
} from "~/lib/queries";

function NavItem({
  to,
  icon,
  label,
  collapsed,
  count,
  exact = false,
}: {
  to: string;
  icon: IconName;
  label: string;
  collapsed: boolean;
  /** Something waiting, such as reviews it is your turn on. */
  count?: number;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? (count ? `${label}, ${count} waiting` : label) : undefined}
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-2.5 rounded-control px-2 text-[13px] text-ink-2 no-underline hover:bg-raised hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink",
        collapsed && "sm:justify-center sm:px-0",
      )}
    >
      <Icon name={icon} />
      <span className={cn("truncate", collapsed && "sm:hidden")}>{label}</span>
      {count ? (
        <span
          className={cn(
            "tabular ml-auto rounded-chip bg-signal/15 px-1.5 text-[11px] leading-[18px] text-signal",
            collapsed &&
              "sm:absolute sm:top-0.5 sm:right-0.5 sm:size-2 sm:p-0 sm:text-[0px] sm:bg-signal",
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

/** A few of the organisation's projects, under Projects, for moving between them. */
function ProjectLinks() {
  const { data: projects } = useQuery(projectsQuery);
  if (!projects || projects.length === 0) return null;
  return (
    <ul className="m-0 hidden list-none flex-col gap-px p-0 pl-[26px] sm:flex">
      {projects.slice(0, 8).map((p) => (
        <li key={p.id}>
          <Link
            to="/projects/$projectId"
            params={{ projectId: p.id }}
            className="flex h-7 items-center truncate rounded-control px-2 text-[13px] text-ink-3 no-underline hover:bg-raised hover:text-ink data-[status=active]:text-ink"
          >
            <span className="truncate">{p.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const SIDEBAR_KEY = "hekate.sidebar";

/** The sidebar's width, remembered per browser; storage can be missing or refuse. */
function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  }, []);
  return [collapsed, set];
}

function Account() {
  const { data: me } = useQuery(meQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
  const switchTo = useSwitchOrganisation();
  if (!me) return null;
  const organisation = me.organisations.find((o) => o.id === me.activeOrganisationId);
  const initials = me.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({ to: "/sign-in" });
  };
  return (
    <div className="flex items-center gap-3">
      <div className="hidden flex-col items-end leading-tight sm:flex">
        <span className="text-[13px] text-ink">{me.user.name}</span>
        {me.organisations.length > 1 ? (
          <label className="flex">
            <span className="sr-only">Organisation</span>
            <select
              value={me.activeOrganisationId ?? ""}
              onChange={(e) => switchTo.mutate(e.target.value)}
              className="cursor-pointer appearance-none border-0 bg-transparent p-0 text-right text-[11px] text-ink-3 hover:text-ink"
            >
              {me.organisations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="text-[11px] text-ink-3">{organisation?.name}</span>
        )}
      </div>
      <span
        aria-hidden="true"
        className="tabular inline-flex size-7 items-center justify-center rounded-full border border-edge bg-raised text-[10px] text-ink-2"
      >
        {initials}
      </span>
      <Button variant="ghost" size="sm" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}

function Health({ collapsed }: { collapsed: boolean }) {
  const { data, isError } = useQuery(healthQuery);
  const ok = data?.status === "ok" && !isError;
  if (collapsed) {
    return (
      <div className="flex justify-center" title={ok ? "Connected" : "Not connected"}>
        <span
          aria-hidden="true"
          className={ok ? "size-[7px] rounded-full bg-ink-3" : "size-[7px] rounded-full bg-signal"}
        />
        <span className="sr-only">{ok ? "Connected" : "Not connected"}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 px-2 text-xs text-ink-3">
      <span
        aria-hidden="true"
        className={ok ? "size-[7px] rounded-full bg-ink" : "size-[7px] rounded-full bg-signal"}
      />
      <span>
        {ok
          ? "Connected"
          : isError
            ? "API unreachable"
            : data
              ? "Database unreachable"
              : "Connecting"}
      </span>
      {data && <span className="tabular ml-auto text-[11px]">v{data.version}</span>}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useCollapsed();
  const { data: reviews } = useQuery(myReviewsQuery);
  const waiting = reviews?.filter((r) => r.yourTurn).length ?? 0;

  // "[" shows or hides the labels, as in Linear; never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      setCollapsed(!collapsed);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, setCollapsed]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-5 border-b border-hairline px-4">
        <Link to="/" className="no-underline" aria-label="Hekate home">
          <Lockup size={18} />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon" aria-label="Search">
            <Icon name="search" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Notifications">
            <Icon name="bell" />
          </Button>
          <span className="mx-2 h-5 w-px bg-hairline" aria-hidden="true" />
          <Account />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Main"
          className={cn(
            "flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-hairline p-2 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:transition-[width] sm:duration-150",
            collapsed ? "sm:w-14" : "sm:w-56",
          )}
        >
          <NavItem
            to="/reviews"
            icon="review"
            label="Reviews"
            collapsed={collapsed}
            count={waiting}
          />
          <NavItem to="/" icon="folder" label="Projects" collapsed={collapsed} exact />
          {!collapsed && <ProjectLinks />}
          <NavItem to="/members" icon="users" label="Members" collapsed={collapsed} />
          <div className="mt-auto hidden flex-col gap-2 border-t border-hairline pt-2 sm:flex">
            <Health collapsed={collapsed} />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCollapsed(!collapsed)}
              aria-label={collapsed ? "Show labels" : "Show icons only"}
              title={`${collapsed ? "Show labels" : "Show icons only"} ([)`}
              className={cn("justify-start text-ink-3", collapsed && "justify-center px-0")}
            >
              <Icon name="sidebar" />
              {!collapsed && <span>Icons only</span>}
            </Button>
          </div>
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
