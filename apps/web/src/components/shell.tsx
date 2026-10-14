import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Lockup } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { healthQuery } from "~/lib/queries";

function NavItem({ to, icon, children }: { to: string; icon: IconName; children: ReactNode }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/" }}
      className="flex h-[34px] items-center gap-2.5 rounded-control px-2 text-ink-2 no-underline hover:bg-raised hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink"
    >
      <Icon name={icon} />
      {children}
    </Link>
  );
}

function Health() {
  const { data, isError } = useQuery(healthQuery);
  const ok = data?.status === "ok" && !isError;
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
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Main"
          className="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-hairline p-2 sm:w-60 sm:flex-col sm:border-r sm:border-b-0"
        >
          <div className="label hidden px-2 pt-2 pb-1 sm:block">Studio</div>
          <NavItem to="/" icon="folder">
            Projects
          </NavItem>
          <NavItem to="/settings" icon="settings">
            Settings
          </NavItem>
          <div className="mt-auto hidden border-t border-hairline pt-3 pb-1 sm:block">
            <Health />
          </div>
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
