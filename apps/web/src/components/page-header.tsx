import {
  cloneElement,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "~/components/icons";
import { fitTrail, type TrailPlan, trailPlans } from "~/lib/trail";
import { Button } from "./ui/button";
import { Floating } from "./ui/floating";
import { usePopover } from "./ui/menu";

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

/** A crumb as the bar draws it: whole, never cut, with its separator after it. */
function CrumbItem({ crumb }: { crumb: Crumb }) {
  return (
    <span data-crumb="" className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <span className="rounded-chip px-1 py-0.5 text-ink-3 transition-colors hover:bg-raised [&_a]:text-ink-3 [&_a:hover]:text-ink">
        {crumb.link}
      </span>
      <span aria-hidden="true" className="text-edge">
        /
      </span>
    </span>
  );
}

/** The crumbs folded out of the bar (#547), in a menu from one "…" button. */
function Folded({ crumbs }: { crumbs: Crumb[] }) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="iconSm"
        aria-label={`${crumbs.length} more ${crumbs.length === 1 ? "step" : "steps"} up`}
        aria-expanded={open}
        aria-haspopup="true"
        className="h-6 w-7 text-ink-3"
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" size={14} />
      </Button>
      <span aria-hidden="true" className="text-edge">
        /
      </span>
      {open && (
        <Floating
          anchor={box}
          onClose={() => setOpen(false)}
          className="flex min-w-48 flex-col rounded-panel border border-line bg-overlay p-1 text-[13px] shadow-3"
        >
          {/* Clicking a step goes there, and the menu closes behind it. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the links inside take the click and the keys. */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
          <div className="flex flex-col" onClick={() => setOpen(false)}>
            {crumbs.map((c) => (
              <span
                key={c.key}
                className="flex min-h-8 items-center rounded-control px-2 hover:bg-raised [&_a]:min-w-0 [&_a]:flex-1 [&_a]:truncate [&_a]:text-ink-2 [&_a:hover]:text-ink"
              >
                {c.link}
              </span>
            ))}
          </div>
        </Floating>
      )}
    </div>
  );
}

const GAP = 6;

/** What a crumb's link carries, to draw it again as the phone's way back. */
interface LinkProps {
  children?: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/** A crumb's words, for the name of the arrow that stands for it. */
const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join("")
      : "the page above";

function Trail({ crumbs, title, meta }: { crumbs: Crumb[]; title: ReactNode; meta?: ReactNode }) {
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [plan, setPlan] = useState<TrailPlan>(() => trailPlans(crumbs.length)[0] as TrailPlan);
  // On a phone only the way back shows, and only while it fits whole beside the page's name.
  const [backWhole, setBackWhole] = useState(true);
  useLayoutEffect(() => {
    const n = nav.current;
    const m = measure.current;
    if (!n || !m) return;
    const run = () => {
      const width = (el: Element | null) => el?.getBoundingClientRect().width ?? 0;
      const widths = {
        available: n.clientWidth,
        crumbs: [...m.querySelectorAll("[data-crumb]")].map(width),
        title: width(m.querySelector("[data-title]")) + GAP + width(m.querySelector("[data-meta]")),
        more: width(m.querySelector("[data-more]")),
        gap: GAP,
      };
      setPlan(fitTrail(widths));
      const back = width(m.querySelector("[data-back]"));
      setBackWhole(back + GAP + width(m.querySelector("[data-title]")) <= n.clientWidth);
    };
    run();
    const watch = new ResizeObserver(run);
    watch.observe(n);
    watch.observe(m);
    return () => watch.disconnect();
    // The measure is redrawn as the crumbs change, and the observer sees it.
  }, []);
  const last = crumbs.at(-1);
  const back = last && isValidElement<LinkProps>(last.link) ? last.link : null;
  return (
    <nav
      ref={nav}
      aria-label="Breadcrumb"
      className="relative flex min-w-0 flex-1 items-center gap-1.5 text-[13px]"
    >
      {/* Every part at its natural width, out of sight and out of the page's width, to measure what fits. */}
      <div
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 left-0 size-0 overflow-hidden"
      >
        <div
          ref={measure}
          className="absolute top-0 left-0 flex items-center gap-1.5 whitespace-nowrap"
        >
          {crumbs.map((c) => (
            <CrumbItem key={c.key} crumb={c} />
          ))}
          <span data-more="" className="flex shrink-0 items-center gap-1.5">
            <span className="w-7" />
            <span className="text-edge">/</span>
          </span>
          <span data-title="" className="px-1 font-medium">
            {title}
          </span>
          {meta && (
            <span data-meta="" className="tabular text-[12px]">
              {meta}
            </span>
          )}
          {last && (
            <span data-back="" className="flex items-center gap-1">
              <span className="w-3.5" />
              {last.link}
              <span className="text-edge">/</span>
            </span>
          )}
        </div>
      </div>
      {/* On a phone the trail shrinks to its last step, as the way back: whole beside the
          page's name, or the arrow alone when it would not fit. */}
      {back && (
        <span className="flex shrink-0 items-center gap-1 text-ink-3 @3xl/app:hidden [&_a]:text-ink-3 [&_a:hover]:text-ink">
          {cloneElement(back, {
            className: "inline-flex min-h-6 min-w-6 items-center gap-1 whitespace-nowrap",
            "aria-label": backWhole ? undefined : `Back to ${textOf(back.props.children)}`,
            children: (
              <>
                <Icon name="chevronLeft" size={14} className="shrink-0" />
                {backWhole && back.props.children}
              </>
            ),
          })}
          {backWhole && (
            <span aria-hidden="true" className="text-edge">
              /
            </span>
          )}
        </span>
      )}
      {plan.shown.slice(0, 1).map((i) => {
        const c = crumbs[i];
        return c ? (
          <span key={c.key} className="hidden @3xl/app:flex">
            <CrumbItem crumb={c} />
          </span>
        ) : null;
      })}
      {plan.folded.length > 0 && (
        <span className="hidden @3xl/app:flex">
          <Folded crumbs={plan.folded.flatMap((i) => crumbs[i] ?? [])} />
        </span>
      )}
      {plan.shown.slice(1).map((i) => {
        const c = crumbs[i];
        return c ? (
          <span key={c.key} className="hidden @3xl/app:flex">
            <CrumbItem crumb={c} />
          </span>
        ) : null;
      })}
      <h1
        className="m-0 min-w-0 truncate px-1 text-[13px] font-medium text-ink"
        title={typeof title === "string" ? title : undefined}
      >
        {title}
      </h1>
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
