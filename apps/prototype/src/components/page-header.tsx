import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";

export interface Crumb {
  label: string;
  to?: string;
}

export interface PageHeaderSpec {
  crumbs?: Crumb[];
  title: string;
  /** A short fact beside the title, such as a file's format. */
  meta?: string;
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

/** A page declares its header: the trail back up, ending in its own name, and its actions. */
export function usePageHeader(spec: PageHeaderSpec) {
  const ctx = useContext(Ctx);
  const set = ctx?.set;
  const key = JSON.stringify({
    c: spec.crumbs,
    t: spec.title,
    m: spec.meta,
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

/** The trail and the title, inside whichever bar holds them. */
export function Trail({ spec, compact = false }: { spec: PageHeaderSpec; compact?: boolean }) {
  const crumbs = compact ? spec.crumbs?.slice(-1) : spec.crumbs;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
      {crumbs?.map((c) => (
        <span key={c.label + c.to} className="flex min-w-0 shrink items-center gap-2">
          {c.to ? (
            <Link to={c.to} className="min-w-0 truncate text-ink-3 no-underline hover:text-ink">
              {c.label}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-ink-3">{c.label}</span>
          )}
          <span aria-hidden="true" className="text-edge">
            /
          </span>
        </span>
      ))}
      <h1 className="m-0 min-w-0 truncate text-[14px] font-medium text-ink">{spec.title}</h1>
      {spec.meta && (
        <span className="tabular hidden shrink-0 text-xs text-ink-3 @3xl/app:inline">
          {spec.meta}
        </span>
      )}
    </nav>
  );
}
