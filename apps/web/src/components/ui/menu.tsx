import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { within } from "~/lib/dom";
import { Icon } from "../icons";
import { Button } from "./button";

/** Opens on its control, closes on a click elsewhere or Escape. */
export function usePopover(): [
  boolean,
  (open: boolean) => void,
  React.RefObject<HTMLDivElement | null>,
] {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!within(event, box.current)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", onEscape);
    };
  }, [open]);
  return [open, setOpen, box];
}

export interface MenuAction {
  label: string;
  hint?: string;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/** The floating list itself. */
export function MenuList({
  actions,
  onClose,
  align = "right",
  className,
  role = "menu",
}: {
  actions: (MenuAction | "divider")[];
  onClose: () => void;
  align?: "left" | "right";
  className?: string;
  /** "group" when the list sits inside a larger menu. */
  role?: "menu" | "group";
}) {
  return (
    <div
      role={role}
      className={cn(
        "rise-in absolute z-30 mt-1 flex min-w-44 flex-col rounded-panel bg-overlay p-1 shadow-3",
        align === "right" ? "right-0" : "left-0",
        className,
      )}
    >
      {actions.map((a, i) =>
        a === "divider" ? (
          <div key={`d-${String(i)}`} className="mx-2 my-1 h-px bg-line" />
        ) : (
          <button
            key={a.label}
            type="button"
            {...(a.checked === undefined
              ? { role: "menuitem" }
              : { role: "menuitemradio", "aria-checked": a.checked })}
            onClick={() => {
              onClose();
              a.onSelect();
            }}
            className={cn(
              "flex cursor-pointer items-center gap-3 whitespace-nowrap rounded-control border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-raised",
              a.danger ? "text-signal" : "text-ink",
            )}
          >
            <span className="flex-1">{a.label}</span>
            {a.hint && <span className="text-ink-3">{a.hint}</span>}
            {a.checked && <Icon name="check" size={14} className="text-ink-2" />}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * A row's less frequent actions behind "…", revealed when the row (a `group`) is hovered
 * or the button has focus, and always on touch screens.
 */
export function ActionMenu({
  label,
  actions,
  always = false,
}: {
  label: string;
  actions: (MenuAction | "divider")[];
  always?: boolean;
}) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="iconSm"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          !always &&
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          open && "opacity-100",
        )}
      >
        <Icon name="more" size={16} strokeWidth={2.5} />
      </Button>
      {open && <MenuList actions={actions} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** A control that shows its current value and opens a list of choices. */
export function Dropdown({
  value,
  actions,
  align = "left",
  size = "md",
  className,
}: {
  value: ReactNode;
  actions: (MenuAction | "divider")[];
  align?: "left" | "right";
  size?: "sm" | "md";
  className?: string;
}) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5 rounded-control border border-transparent text-ink-2 transition-colors hover:bg-raised hover:text-ink",
          size === "sm" ? "h-7 px-2 text-[13px]" : "h-8 px-2.5 text-[13px]",
          open && "bg-raised text-ink",
          className,
        )}
      >
        {value}
        <Icon name="chevronDown" size={12} className="text-ink-3" />
      </button>
      {open && <MenuList actions={actions} onClose={() => setOpen(false)} align={align} />}
    </div>
  );
}
