import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/** How long the tick stays before the button offers a copy again. */
const COPIED_FOR = 2500;

/**
 * Puts a value people copy (a key, an address, a URI) on the clipboard, beside where it is
 * shown, and ticks for a moment once it has. Where the browser keeps the clipboard from the
 * page it says so, and the value beside it can be selected by hand.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = () => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => setState("copied"))
      .catch(() => setState("failed"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), COPIED_FOR);
  };
  const words = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : label;
  return (
    <Button
      size="iconSm"
      variant="ghost"
      aria-label={words}
      title={words}
      onClick={copy}
      className="shrink-0"
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={13} />
    </Button>
  );
}
