import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";

/** A step back up the trail: a link, made by the page so it can be typed for its route. */
export interface Crumb {
  key: string;
  link: ReactNode;
}

interface Slots {
  trail: HTMLElement | null;
  actions: HTMLElement | null;
}

const SlotContext = createContext<Slots | null>(null);

/**
 * The shell's top bar holds the page's trail and actions (decision 038): the page says what
 * they are, and they are drawn into the bar's slots. This provides the slots.
 */
export function useHeaderSlots(): [
  Slots,
  (el: HTMLElement | null) => void,
  (el: HTMLElement | null) => void,
] {
  const [trail, setTrail] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return [{ trail, actions }, setTrail, setActions];
}

export function HeaderSlotsProvider({ slots, children }: { slots: Slots; children: ReactNode }) {
  return <SlotContext.Provider value={slots}>{children}</SlotContext.Provider>;
}

function Trail({ crumbs, title, meta }: { crumbs: Crumb[]; title: ReactNode; meta?: ReactNode }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
      {crumbs.map((c) => (
        <span key={c.key} className="hidden min-w-0 shrink items-center gap-1.5 @3xl/app:flex">
          <span className="min-w-0 truncate rounded-chip px-1 py-0.5 text-ink-3 transition-colors hover:bg-raised [&_a]:text-ink-3 [&_a:hover]:text-ink">
            {c.link}
          </span>
          <span aria-hidden="true" className="text-edge">
            /
          </span>
        </span>
      ))}
      <h1 className="m-0 min-w-0 truncate px-1 text-[13px] font-medium text-ink">{title}</h1>
      {meta && (
        <span className="tabular hidden shrink-0 text-[12px] text-ink-3 @3xl/app:inline">
          {meta}
        </span>
      )}
    </nav>
  );
}

/**
 * Where you are (the trail, ending in this page's name, which is the page's only title) and
 * what you can do here. One per page, so every page reads the same way. Inside the shell it
 * is drawn into the top bar; anywhere else it stands at the top of the page.
 */
export function PageHeader({
  crumbs = [],
  title,
  meta,
  actions,
}: {
  crumbs?: Crumb[];
  title: ReactNode;
  /** A short fact beside the title, such as a file's format. */
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const slots = useContext(SlotContext);
  if (slots?.trail) {
    return (
      <>
        {createPortal(<Trail crumbs={crumbs} title={title} meta={meta} />, slots.trail)}
        {actions && slots.actions && createPortal(actions, slots.actions)}
      </>
    );
  }
  return (
    <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2 @3xl/app:px-6">
      <Trail crumbs={crumbs} title={title} meta={meta} />
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
