import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";
import { Button } from "./button";

/**
 * A row's less frequent actions behind "…", revealed when the row (a `group`) is hovered
 * or the button has focus, and always on touch screens.
 */
export function ActionMenu({
  label,
  actions,
}: {
  label: string;
  actions: { label: string; danger?: boolean; onSelect: () => void }[];
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          open && "opacity-100",
        )}
      >
        <Icon name="more" size={16} strokeWidth={2.5} />
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 flex min-w-36 flex-col rounded-control border border-edge bg-raised p-1 shadow-none"
        >
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                a.onSelect();
              }}
              className={cn(
                "cursor-pointer whitespace-nowrap rounded-[4px] border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] hover:bg-surface",
                a.danger ? "text-signal" : "text-ink",
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
