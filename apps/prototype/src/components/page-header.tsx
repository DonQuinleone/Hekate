import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";
import { Icon } from "~/components/icons";

export interface Crumb {
  label: string;
  to?: string;
}

export interface PageHeaderSpec {
  /** The way up, ending in this page's name. */
  crumbs?: Crumb[];
  title: string;
  /** Whether the title is the last crumb in the bar (lists) or a heading in the page (one thing). */
  heading?: "bar" | "page";
  actions?: ReactNode;
  /** Where "back" goes on a phone. */
  back?: string;
  /** Anything the actions depend on that the text parts do not say, so they are refreshed. */
  revision?: string;
}

const Ctx = createContext<{
  spec: PageHeaderSpec | null;
  set: (s: PageHeaderSpec | null) => void;
} | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [spec, set] = useState<PageHeaderSpec | null>(null);
  return <Ctx.Provider value={{ spec, set }}>{children}</Ctx.Provider>;
}

/** A page declares its header: the trail back up, its name, and its actions. */
export function usePageHeader(spec: PageHeaderSpec) {
  const ctx = useContext(Ctx);
  const set = ctx?.set;
  const key = JSON.stringify({
    c: spec.crumbs,
    t: spec.title,
    h: spec.heading,
    b: spec.back,
    r: spec.revision,
  });
  // The actions node changes identity every render; the header updates when the text parts, or the revision, change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: spec is captured through its key on purpose.
  useLayoutEffect(() => {
    set?.(spec);
    return () => set?.(null);
  }, [key, set]);
}

export function useCurrentHeader() {
  return useContext(Ctx)?.spec ?? null;
}

/** The trail, inside whichever bar holds it. */
export function Trail({ spec, compact = false }: { spec: PageHeaderSpec; compact?: boolean }) {
  const crumbs = compact ? spec.crumbs?.slice(-1) : spec.crumbs;
  const back = spec.back ?? spec.crumbs?.at(-1)?.to;
  const inBar = spec.heading !== "page";
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
      {back && (
        <Link
          to={back}
          aria-label="Back"
          className="-ml-2 flex size-8 shrink-0 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink @3xl/app:hidden"
        >
          <Icon name="chevronLeft" size={16} />
        </Link>
      )}
      {crumbs?.map((c, i) => (
        <span
          key={c.label + c.to}
          className="hidden min-w-0 shrink items-center gap-1.5 @3xl/app:flex"
        >
          {c.to ? (
            <Link
              to={c.to}
              className="min-w-0 truncate rounded-chip px-1 py-0.5 text-ink-3 transition-colors hover:bg-raised hover:text-ink"
            >
              {c.label}
            </Link>
          ) : (
            <span className="min-w-0 truncate px-1 text-ink-3">{c.label}</span>
          )}
          {(inBar || i < (crumbs?.length ?? 0) - 1) && (
            <span aria-hidden="true" className="text-edge">
              /
            </span>
          )}
        </span>
      ))}
      {inBar ? (
        <h1 className="m-0 min-w-0 truncate px-1 text-[13px] font-medium text-ink">{spec.title}</h1>
      ) : (
        <span className="min-w-0 truncate px-1 text-[13px] text-ink @3xl/app:hidden">
          {spec.title}
        </span>
      )}
    </nav>
  );
}

/** The page's own heading, when it is one thing rather than a list. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={className ? `title ${className}` : "title"}>{children}</h1>;
}
