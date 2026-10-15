/**
 * The element an event really came from, read from its composed path so that it also works
 * when the app is mounted in a shadow root (as the prototype is).
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
