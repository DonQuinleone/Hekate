import type { RecorderEvent, RecorderPosition, RecorderStatus } from "@hekate/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultRecorderOptions, type RecorderAdapter, type RecorderOptions } from "./adapter";
import { recorderDefinition } from "./registry";

/**
 * The recorder this tab reads (decision 240), across its pages: the take log drives takes
 * from it, and the player can follow its position. One connection a tab, so the take log and
 * the file page beside it never open the same MIDI port or audio input twice. What was last
 * chosen is remembered in this browser for next time, never sent anywhere.
 */

const CHOICE_KEY = "hekate.recorder";

export interface RecorderChoice {
  kind: string;
  options: RecorderOptions;
}

export interface Recorder {
  /** The recorder connected or connecting; null for none. */
  kind: string | null;
  options: RecorderOptions;
  status: RecorderStatus;
  /** Where it is, a few times a second while it rolls. */
  position: RecorderPosition | null;
  /** What was chosen last in this browser, to offer again. */
  remembered: RecorderChoice | null;
  /** Connects (asking the browser), replacing any connection; false when it failed. */
  connect(kind: string, options: RecorderOptions): Promise<boolean>;
  disconnect(): void;
  /** Every event the connected recorder sends, whichever it is. */
  subscribe(listener: (event: RecorderEvent) => void): () => void;
}

const Context = createContext<Recorder | null>(null);

function rememberedChoice(): RecorderChoice | null {
  try {
    const raw = localStorage.getItem(CHOICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RecorderChoice>;
    if (typeof parsed.kind !== "string" || !recorderDefinition(parsed.kind)) return null;
    return { kind: parsed.kind, options: { ...defaultRecorderOptions, ...parsed.options } };
  } catch {
    return null;
  }
}

function remember(choice: RecorderChoice) {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // Not remembered: the choice is offered afresh next time.
  }
}

/** Positions reach the page at most this often; the clocks play on between them. */
const POSITION_EVERY_MS = 100;

export function RecorderProvider({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<string | null>(null);
  const [options, setOptions] = useState<RecorderOptions>(defaultRecorderOptions);
  const [status, setStatus] = useState<RecorderStatus>({ state: "idle" });
  const [position, setPosition] = useState<RecorderPosition | null>(null);
  const [remembered, setRemembered] = useState<RecorderChoice | null>(rememberedChoice);
  const adapter = useRef<RecorderAdapter | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);
  const listeners = useRef(new Set<(event: RecorderEvent) => void>());
  const lastPosition = useRef(0);

  const close = useCallback(() => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    adapter.current?.disconnect();
    adapter.current = null;
  }, []);

  const connect = useCallback(
    async (next: string, chosen: RecorderOptions) => {
      close();
      const definition = recorderDefinition(next);
      if (!definition) return false;
      const made = definition.create(chosen);
      adapter.current = made;
      setKind(next);
      setOptions(chosen);
      setPosition(null);
      const choice = { kind: next, options: chosen };
      remember(choice);
      setRemembered(choice);
      unsubscribe.current = made.subscribe((event) => {
        if (adapter.current !== made) return;
        if (event.type === "status") setStatus(event.status);
        if (event.type === "position") {
          const now = Date.now();
          // A change of rolling is shown at once; a position moving on, every tenth of a second.
          if (now - lastPosition.current >= POSITION_EVERY_MS || !event.position.rolling) {
            lastPosition.current = now;
            setPosition(event.position);
          }
        }
        for (const listener of [...listeners.current]) listener(event);
      });
      try {
        await made.connect();
      } catch {
        // Its status says why, where the recorder is chosen.
        return false;
      }
      // Replaced or closed while the browser asked: nothing may be left listening for it.
      if (adapter.current !== made) {
        made.disconnect();
        return false;
      }
      return true;
    },
    [close],
  );

  const disconnect = useCallback(() => {
    close();
    setKind(null);
    setStatus({ state: "idle" });
    setPosition(null);
  }, [close]);

  useEffect(() => close, [close]);

  const subscribe = useCallback((listener: (event: RecorderEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<Recorder>(
    () => ({ kind, options, status, position, remembered, connect, disconnect, subscribe }),
    [kind, options, status, position, remembered, connect, disconnect, subscribe],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The tab's recorder; null outside the provider (a test rendering a page alone). */
export const useRecorder = () => useContext(Context);
