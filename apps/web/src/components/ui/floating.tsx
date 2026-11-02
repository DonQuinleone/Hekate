import {
  type CSSProperties,
  createContext,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "~/lib/cn";

const FloatingHost = createContext<HTMLElement | null>(null);

/**
 * Where floating things (menus, popovers, panels) are drawn: the app's root, so one opened
 * from the sidebar or the foot of a scrolling list floats over everything instead of being cut
 * off by whatever box declared it. Dialogs have a layer of their own on the pane.
 */
export function FloatingLayer({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setHost} className={className} {...rest}>
      <FloatingHost.Provider value={host}>{children}</FloatingHost.Provider>
    </div>
  );
}

/** Each floating element's anchor, so a click inside one counts as a click on its anchor. */
const anchors = new WeakMap<Element, Element>();

/**
 * True when the event started inside `anchor`, or inside something floating from it, at any
 * remove: a list of suggestions floating from a popover that floats from the anchor counts.
 */
export function withinOrFloatingFrom(event: Event, anchor: Element | null): boolean {
  if (!anchor) return false;
  for (const el of event.composedPath()) {
    if (!(el instanceof Element)) continue;
    let node: Element | null = el;
    while (node) {
      if (node === anchor || anchor.contains(node)) return true;
      const root: Element | null = node.closest("[data-floating]");
      node = root ? (anchors.get(root) ?? null) : null;
    }
  }
  return false;
}

/** A place on the screen to float from, where there is no element: the pointer, say. */
export interface Point {
  x: number;
  y: number;
}
const isPoint = (anchor: FloatingProps["anchor"]): anchor is Point => "x" in anchor;

const MARGIN = 8;

const focusable = (root: HTMLElement) =>
  root.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );

interface FloatingProps extends HTMLAttributes<HTMLDivElement> {
  /** The element it hangs from, or a point in the window (where a context menu opens). */
  anchor: RefObject<HTMLElement | null> | Point;
  /**
   * Below the anchor or above it, or beside it to the right or the left (a menu from a
   * collapsed sidebar's rail); it flips to the other side when the preferred one has no room.
   */
  side?: "bottom" | "top" | "right" | "left";
  /**
   * Above or below: its left edge on the anchor's left edge, its right edge on the anchor's
   * right, or as wide as the anchor. Beside: its top on the anchor's top, or its foot on the
   * anchor's foot.
   */
  align?: "start" | "end" | "stretch";
  gap?: number;
  /** Called when focus leaves it for somewhere other than its anchor. */
  onClose?: () => void;
  children: ReactNode;
}

/** Where a box goes beside its anchor, inside the layer `H`: flipped, and kept in the window. */
export function besidePlace(
  A: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
  H: Pick<DOMRect, "left" | "top" | "width" | "height">,
  box: {
    w: number;
    h: number;
    side: "right" | "left";
    align: "start" | "end" | "stretch";
    gap: number;
  },
): { left: number; top: number; maxHeight?: number; maxWidth: number } {
  const { w, h, side, align, gap } = box;
  const right = A.right - H.left + gap;
  const leftOf = A.left - H.left - gap - w;
  const fitsRight = right + w <= H.width - MARGIN;
  const fitsLeft = leftOf >= MARGIN;
  let left: number;
  if (side === "right") left = fitsRight || !fitsLeft ? right : leftOf;
  else left = fitsLeft || !fitsRight ? leftOf : right;
  left = Math.max(MARGIN, Math.min(left, H.width - w - MARGIN));
  const room = H.height - 2 * MARGIN;
  let top = align === "end" ? A.bottom - H.top - h : A.top - H.top;
  top = Math.max(MARGIN, Math.min(top, H.height - Math.min(h, room) - MARGIN));
  return {
    left,
    top,
    ...(h > room ? { maxHeight: room } : {}),
    maxWidth: H.width - 2 * MARGIN,
  };
}

/**
 * A box positioned from its anchor, drawn in the floating layer: kept inside the window,
 * flipped above when there is no room below, scrolling inside itself when neither fits.
 * Tab from the anchor enters it; Tab out of it closes it. Without a layer (a page outside the
 * app's shell) it sits in place, as an absolutely positioned child would.
 */
export function Floating({
  anchor,
  side = "bottom",
  align = "start",
  gap = 4,
  onClose,
  className,
  style: given,
  children,
  ...rest
}: FloatingProps) {
  const host = useContext(FloatingHost);
  const el = useRef<HTMLDivElement>(null);
  // Out of sight until placed, and already out of the flow: a block in the flow would be as
  // wide as the layer, and the first measurement would place it by that width.
  const [style, setStyle] = useState<CSSProperties>({
    position: "absolute",
    left: 0,
    top: 0,
    visibility: "hidden",
  });
  const close = useRef(onClose);
  close.current = onClose;

  const point = isPoint(anchor) ? anchor : null;
  const element = isPoint(anchor) ? null : anchor;
  useLayoutEffect(() => {
    const a = element?.current ?? null;
    const f = el.current;
    if (!host || !f || (!a && !point)) return;
    if (a) anchors.set(f, a);
    let last = "";
    const place = () => {
      const H = host.getBoundingClientRect();
      const A = a ? a.getBoundingClientRect() : new DOMRect(point?.x ?? 0, point?.y ?? 0, 0, 0);
      const beside = side === "right" || side === "left";
      const w = align === "stretch" && !beside ? A.width : f.offsetWidth;
      // Its height unconstrained: once capped, it scrolls, and measuring the cap would say it
      // fits, lift the cap, and measure again, without end.
      const h = f.scrollHeight + (f.offsetHeight - f.clientHeight);
      if (beside) {
        const next = besidePlace(A, H, { w, h, side, align, gap });
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setStyle({ ...next, position: "absolute", visibility: "visible" });
        }
        return;
      }
      let left = align === "end" ? A.right - H.left - w : A.left - H.left;
      left = Math.max(MARGIN, Math.min(left, H.width - w - MARGIN));
      const below = A.bottom - H.top + gap;
      const above = A.top - H.top - gap - h;
      const roomBelow = H.height - below - MARGIN;
      const fitsBelow = h <= roomBelow;
      const fitsAbove = above >= MARGIN;
      let top = below;
      let maxHeight: number | undefined;
      if (side === "top" ? fitsAbove : fitsBelow) top = side === "top" ? above : below;
      else if (side === "top" ? fitsBelow : fitsAbove) top = side === "top" ? below : above;
      else maxHeight = Math.max(120, roomBelow);
      const next: CSSProperties = {
        position: "absolute",
        left,
        top,
        maxHeight,
        width: align === "stretch" ? w : undefined,
        maxWidth: H.width - 2 * MARGIN,
        visibility: "visible",
      };
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setStyle(next);
      }
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(f);
    if (a) watch.observe(a);
    watch.observe(host);
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    // Tab from the anchor comes in; focus leaving for elsewhere closes it.
    const fromAnchor = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.shiftKey) return;
      const first = focusable(f);
      if (!first) return;
      e.preventDefault();
      first.focus();
    };
    // Into something floating from it (a calendar from a field in it) is not leaving it.
    const within = (to: Node) => {
      let node: Element | null = to instanceof Element ? to : to.parentElement;
      while (node) {
        if (f.contains(node) || a?.contains(node)) return true;
        const root: Element | null = node.closest("[data-floating]");
        node = root && root !== f ? (anchors.get(root) ?? null) : null;
      }
      return false;
    };
    const left = (e: FocusEvent) => {
      const to = e.relatedTarget;
      if (to === null) return;
      if (to instanceof Node && within(to)) return;
      close.current?.();
    };
    a?.addEventListener("keydown", fromAnchor);
    f.addEventListener("focusout", left);
    return () => {
      anchors.delete(f);
      watch.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
      a?.removeEventListener("keydown", fromAnchor);
      f.removeEventListener("focusout", left);
    };
  }, [element, point, host, side, align, gap]);

  if (!host) {
    return (
      <div
        ref={el}
        data-floating
        className={cn(
          point ? "fixed z-30" : "absolute z-30",
          !point &&
            (side === "top"
              ? "bottom-full mb-1"
              : side === "right"
                ? "left-full ml-1"
                : side === "left"
                  ? "right-full mr-1"
                  : "top-full mt-1"),
          !point &&
            (side === "right" || side === "left"
              ? align === "end"
                ? "bottom-0"
                : "top-0"
              : align === "end"
                ? "right-0"
                : "left-0"),
          !point && align === "stretch" && side !== "right" && side !== "left" && "right-0",
          className,
        )}
        style={point ? { ...given, left: point.x, top: point.y } : given}
        {...rest}
      >
        {children}
      </div>
    );
  }
  return createPortal(
    // A layer over the page to the visual suite: what it covers is out of sight.
    <div
      ref={el}
      data-floating
      data-e2e-layer
      className={cn("z-40 overflow-auto", className)}
      style={{ ...given, ...style }}
      {...rest}
    >
      {children}
    </div>,
    host,
  );
}
