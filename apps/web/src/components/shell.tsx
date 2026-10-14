import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Lockup } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth";
import { healthQuery, meQuery, useSwitchOrganisation } from "~/lib/queries";

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

function Account() {
  const { data: me } = useQuery(meQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
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
        <span className="text-[11px] text-ink-3">{organisation?.name}</span>
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

function OrganisationLabel() {
  const { data: me } = useQuery(meQuery);
  const switchTo = useSwitchOrganisation();
  if (!me) return null;
  const name = me.organisations.find((o) => o.id === me.activeOrganisationId)?.name ?? "";
  if (me.organisations.length < 2) {
    return <div className="label hidden truncate px-2 pt-2 pb-1 sm:block">{name}</div>;
  }
  return (
    <label className="hidden flex-col gap-1 px-2 pt-2 pb-1 sm:flex">
      <span className="sr-only">Organisation</span>
      <select
        value={me.activeOrganisationId}
        onChange={(e) => switchTo.mutate(e.target.value)}
        className="label cursor-pointer appearance-none truncate border-0 bg-transparent p-0 text-ink-2 hover:text-ink"
      >
        {me.organisations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
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
          <span className="mx-2 h-5 w-px bg-hairline" aria-hidden="true" />
          <Account />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label="Main"
          className="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-hairline p-2 sm:w-60 sm:flex-col sm:border-r sm:border-b-0"
        >
          <OrganisationLabel />
          <NavItem to="/" icon="folder">
            Projects
          </NavItem>
          <NavItem to="/members" icon="users">
            Members
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
