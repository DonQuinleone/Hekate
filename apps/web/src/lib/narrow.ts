import { useLayoutEffect, useState } from "react";

/**
 * Whether an element is narrower than `px`, kept up to date as it resizes: for the few places
 * where a narrow layout needs a different order in the document, not only on screen, so that
 * focus and screen readers follow what is seen. Give the returned ref to the element.
 */
export function useNarrow(px: number): [(el: HTMLElement | null) => void, boolean] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setNarrow(el.getBoundingClientRect().width < px);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, px]);
  return [setEl, narrow];
}
