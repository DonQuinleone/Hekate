/**
 * The app renders inside a shadow root, so events heard on `window` are retargeted to the
 * host element. These read the element the event really came from.
 */
export function targetOf(event: Event): HTMLElement | null {
  const first = event.composedPath()[0];
  return first instanceof HTMLElement ? first : null;
}

/** True when the event started in something that takes typing. */
export function inField(event: Event): boolean {
  return Boolean(targetOf(event)?.closest("input, textarea, select, [contenteditable=true]"));
}

/** True when the event started inside `el`. */
export function within(event: Event, el: Element | null): boolean {
  return Boolean(el && event.composedPath().includes(el));
}

/** The app's own root for queries, since document.querySelector cannot see into the shadow. */
export function appRoot(): ParentNode {
  return document.getElementById("root")?.shadowRoot ?? document;
}
