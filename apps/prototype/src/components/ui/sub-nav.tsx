import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";

/** Which edges of a strip have more beyond them. */
export interface Edges {
  start: boolean;
  end: boolean;
}

/** Whether a strip scrolled to `left` has more before it and after it (#542). */
export function edgesOf(left: number, width: number, scrollWidth: number): Edges {
  return { start: left > 1, end: left + width < scrollWidth - 1 };
}

/** Where to scroll a strip so its current item stands whole in view, as near the middle as it can. */
export function scrollFor(
  item: { left: number; width: number },
  width: number,
  scrollWidth: number,
) {
  const centred = item.left - (width - item.width) / 2;
  return Math.max(0, Math.min(centred, scrollWidth - width));
}

const FADE = "24px";

/**
 * A strip of sections that scrolls sideways on a phone (#542): the current item
 * (`aria-current`) is scrolled into view as it opens, and an edge fades on whichever side has
 * more, so it is plain where you are and that there is more. Its links are its children.
 */
export function SubNav({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const strip = useRef<HTMLElement>(null);
  const [edges, setEdges] = useState<Edges>({ start: false, end: false });
  // The current item is brought into view when it opens or changes, never while someone scrolls.
  const shown = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = strip.current;
    const current = el?.querySelector<HTMLElement>("[aria-current]");
    const key = current?.getAttribute("href") ?? current?.textContent ?? null;
    if (!el || !current || key === shown.current) return;
    shown.current = key;
    const box = el.getBoundingClientRect();
    const at = current.getBoundingClientRect();
    el.scrollLeft = scrollFor(
      { left: at.left - box.left + el.scrollLeft, width: at.width },
      el.clientWidth,
      el.scrollWidth,
    );
    setEdges(edgesOf(el.scrollLeft, el.clientWidth, el.scrollWidth));
  });
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const update = () => setEdges(edgesOf(el.scrollLeft, el.clientWidth, el.scrollWidth));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const watch = new ResizeObserver(update);
    watch.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      watch.disconnect();
    };
  }, []);
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${edges.end ? "transparent" : "black"})`
      : undefined;
  return (
    <nav
      ref={strip}
      aria-label={label}
      data-fade-start={edges.start || undefined}
      data-fade-end={edges.end || undefined}
      className={cn("scroll-quiet flex overflow-x-auto", className)}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {children}
    </nav>
  );
}
