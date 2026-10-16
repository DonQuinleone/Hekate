import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { targetOf } from "./dom";
import { isMac, matchBinding, SEQUENCE_MS } from "./keys";

/**
 * One registry of keyboard shortcuts. What is on the page registers its own while it is
 * there, so the "?" map lists exactly what works now. One listener runs them: never while
 * someone types in a field, never behind an open dialog.
 */

export interface Shortcut {
  /** Each binding that does it, as in lib/keys: "k", "Space", "Mod+K", "g h". */
  keys: string[];
  label: string;
  /** What it does; left out when the place it belongs to handles the key itself. */
  run?: (event: KeyboardEvent) => void;
  /** Where it works, when not everywhere on the page: "In the file list". */
  where?: string;
  /** Also while typing in a field or inside a dialog, such as Mod+K for the palette. */
  anywhere?: boolean;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  shortcuts: Shortcut[];
}

type Store = {
  groups: Map<string, ShortcutGroup>;
  listeners: Set<() => void>;
  snapshot: ShortcutGroup[];
};

const Context = createContext<{ store: Store; announce: (text: string) => void } | null>(null);

function publish(store: Store) {
  store.snapshot = [...store.groups.values()];
  for (const listener of store.listeners) listener();
}

/** Keys that act on whatever has focus, which a shortcut must leave to it. */
const activates = new Set(["Space", " ", "Enter"]);
const interactive =
  "button, a[href], summary, [role=button], [role=switch], [role=tab], [role=checkbox], [role=menuitem], [role=option]";
/** Arrow keys move within these controls, so a shortcut must leave them alone there. */
const arrows = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const composite =
  "[role=tab], [role=tablist], [role=menu], [role=menubar], [role=listbox], [role=radiogroup], [role=slider], [role=grid], [role=tree]";

/** Whether the key belongs to the focused element rather than to the page. */
export function ownedByTarget(key: string, target: Element | null): boolean {
  if (!target) return false;
  if (activates.has(key) && target.closest(interactive)) return true;
  return arrows.has(key) && Boolean(target.closest(composite));
}

/** Whether the target takes typing: a range input takes the arrows, but not Space. */
export function typingIn(key: string, target: Element | null): boolean {
  if (!target?.closest("input, textarea, select, [contenteditable=true]")) return false;
  const range = target instanceof HTMLInputElement && target.type === "range";
  return !(range && (key === " " || key === "Space"));
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const store = useMemo<Store>(
    () => ({ groups: new Map(), listeners: new Set(), snapshot: [] }),
    [],
  );
  const [message, setMessage] = useState("");
  const announce = useCallback((text: string) => {
    // Cleared first, so the same words twice are read twice.
    setMessage("");
    requestAnimationFrame(() => setMessage(text));
  }, []);

  useEffect(() => {
    const mac = isMac();
    let waiting: { stroke: string; at: number } | null = null;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = targetOf(event);
      // Typing, and an open dialog, keep keys for themselves: the page's wait behind them.
      const held =
        typingIn(event.key, target) || Boolean(document.querySelector("[aria-modal=true]"));
      if (ownedByTarget(event.key, target)) return;
      const pending = waiting && Date.now() - waiting.at < SEQUENCE_MS ? waiting.stroke : null;
      waiting = null;
      // The most recently mounted group first: the innermost place wins.
      const groups = [...store.groups.values()].reverse();
      for (const group of groups) {
        for (const shortcut of group.shortcuts) {
          if (!shortcut.run || (held && !shortcut.anywhere)) continue;
          for (const binding of shortcut.keys) {
            const match = matchBinding(binding, event, pending, mac);
            if (match === "match") {
              event.preventDefault();
              shortcut.run(event);
              return;
            }
            if (match === "first")
              waiting = { stroke: binding.split(" ")[0] ?? "", at: Date.now() };
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);

  const value = useMemo(() => ({ store, announce }), [store, announce]);
  return (
    <Context.Provider value={value}>
      {children}
      <div aria-live="polite" className="sr-only">
        {message}
      </div>
    </Context.Provider>
  );
}

/**
 * Register a group of shortcuts while the calling component is on the page. Handlers may
 * change on every render; the registration follows the latest without churning.
 */
export function useShortcuts(id: string, title: string, shortcuts: Shortcut[], enabled = true) {
  const context = useContext(Context);
  const latest = useRef(shortcuts);
  latest.current = shortcuts;
  // Re-registered only when what the map shows changes.
  const shape = JSON.stringify(shortcuts.map((s) => [s.keys, s.label, s.where, Boolean(s.run)]));
  useEffect(() => {
    if (!context || !enabled) return;
    const { store } = context;
    const parsed = JSON.parse(shape) as [string[], string, string | undefined, boolean][];
    store.groups.set(id, {
      id,
      title,
      shortcuts: parsed.map(([keys, label, where, runs], i) => ({
        keys,
        label,
        ...(where ? { where } : {}),
        ...(latest.current[i]?.anywhere ? { anywhere: true } : {}),
        ...(runs ? { run: (event: KeyboardEvent) => latest.current[i]?.run?.(event) } : {}),
      })),
    });
    publish(store);
    return () => {
      store.groups.delete(id);
      publish(store);
    };
  }, [context, enabled, id, title, shape]);
}

/** The groups registered now, for the map. */
export function useShortcutGroups(): ShortcutGroup[] {
  const context = useContext(Context);
  return useSyncExternalStore(
    (listener) => {
      if (!context) return () => {};
      context.store.listeners.add(listener);
      return () => context.store.listeners.delete(listener);
    },
    () => context?.store.snapshot ?? empty,
    () => empty,
  );
}
const empty: ShortcutGroup[] = [];

/** Say a change out loud to assistive technology: "Playing", "Loop on". */
export function useAnnounce() {
  return useContext(Context)?.announce ?? noop;
}
const noop = () => {};
