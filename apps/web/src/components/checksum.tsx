import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/** How long "Copied" stays before the button offers a copy again. */
const COPIED_FOR = 2500;

/**
 * A file's SHA-256 as the details and the QA format panel show it: its first and last
 * characters, the whole in its title, and a button that puts the whole on the clipboard and
 * says "Copied" for a moment. Where the browser keeps the clipboard from the page, the whole is
 * shown to copy by hand. Nothing to copy while it is still being worked out.
 */
export function Checksum({ sha256 }: { sha256: string | null }) {
  const [state, setState] = useState<"copied" | "failed" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!sha256) return <span className="text-ink-3">Being worked out</span>;
  const copy = () => {
    void navigator.clipboard
      .writeText(sha256)
      .then(() => setState("copied"))
      .catch(() => setState("failed"));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState(null), COPIED_FOR);
  };
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1">
      <span
        className={
          state === "failed" ? "tabular break-all text-ink-2" : "tabular truncate text-ink-2"
        }
        title={sha256}
      >
        {state === "failed" ? sha256 : `SHA-256 · ${sha256.slice(0, 4)}…${sha256.slice(-4)}`}
      </span>
      <Button
        size="iconSm"
        variant="quiet"
        aria-label="Copy the checksum"
        title="Copy the checksum"
        onClick={copy}
        className="-my-1 shrink-0"
      >
        <Icon name={state === "copied" ? "check" : "copy"} size={13} />
      </Button>
      <span role="status" className="shrink-0 text-[12px] text-ink-3">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : ""}
      </span>
    </span>
  );
}
