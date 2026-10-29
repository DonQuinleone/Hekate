import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";
import { Button } from "./button";
import { Floating, withinOrFloatingFrom } from "./floating";
import { fieldClass } from "./input";

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
      if (!withinOrFloatingFrom(event, box.current)) setOpen(false);
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
  /** A mark before the label: an icon, or a programme's logo. */
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

/**
 * The list itself. Given its anchor it floats from it, over everything; without one (a group
 * inside a larger menu) it sits where it is declared.
 */
export function MenuList({
  actions,
  onClose,
  anchor,
  align = "right",
  side = "bottom",
  className,
  role = "menu",
}: {
  actions: (MenuAction | "divider")[];
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  /** Its right edge on the anchor's, its left edge on the anchor's, or as wide as the anchor. */
  align?: "left" | "right" | "stretch";
  side?: "top" | "bottom";
  className?: string;
  /** "group" when the list sits inside a larger menu. */
  role?: "menu" | "group";
}) {
  const items = actions.map((a, i) =>
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
        {a.icon && (
          <span className="flex min-w-4 shrink-0 justify-center text-ink-2">{a.icon}</span>
        )}
        <span className="flex-1">{a.label}</span>
        {a.hint && <span className="text-ink-3">{a.hint}</span>}
        {a.checked && <Icon name="check" size={14} className="text-ink-2" />}
      </button>
    ),
  );
  const look = "rise-in flex min-w-44 flex-col rounded-panel bg-overlay p-1 shadow-3";
  if (anchor)
    return (
      <Floating
        anchor={anchor}
        align={align === "right" ? "end" : align === "left" ? "start" : "stretch"}
        side={side}
        onClose={onClose}
        data-e2e-overlap
        role={role}
        className={cn(look, className)}
      >
        {items}
      </Floating>
    );
  return (
    <div data-e2e-overlap role={role} className={cn(look, "relative", className)}>
      {items}
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
      {open && <MenuList anchor={box} actions={actions} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * A control that shows its current value and opens a list of choices: quiet in a toolbar,
 * or drawn as a field in a form, where a native select cannot show each choice's mark.
 */
export function Dropdown({
  value,
  actions,
  align = "left",
  size = "md",
  variant = "ghost",
  label,
  above = false,
  className,
}: {
  value: ReactNode;
  actions: (MenuAction | "divider")[];
  align?: "left" | "right";
  size?: "sm" | "md";
  /** Opens upward by preference; either way it opens where there is room. */
  above?: boolean | "wide";
  variant?: "ghost" | "field";
  /** What the control chooses, for a screen reader, where no label is beside it. */
  label?: string;
  className?: string;
}) {
  const [open, setOpen, box] = usePopover();
  const field = variant === "field";
  const id = useId();
  return (
    <div ref={box} className={cn("relative", field && "w-full")}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        // Named by what it chooses and what is chosen, so the choice is heard while it is shut.
        aria-labelledby={label ? `${id}-label ${id}-value` : undefined}
        onClick={() => setOpen(!open)}
        className={cn(
          field
            ? cn(fieldClass, "flex h-9 items-center gap-2 text-left")
            : cn(
                "flex items-center gap-1.5 rounded-control border border-transparent text-ink-2 transition-colors hover:bg-raised hover:text-ink",
                size === "sm" ? "h-7 px-2 text-[13px]" : "h-8 px-2.5 text-[13px]",
                open && "bg-raised text-ink",
              ),
          className,
        )}
      >
        {label && (
          <span id={`${id}-label`} className="sr-only">
            {label}
          </span>
        )}
        <span
          id={`${id}-value`}
          className={cn("flex items-center", field ? "min-w-0 flex-1 gap-2" : "gap-1.5")}
        >
          {value}
        </span>
        <Icon name="chevronDown" size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <MenuList
          anchor={box}
          actions={actions}
          onClose={() => setOpen(false)}
          align={field ? "stretch" : align}
          side={above ? "top" : "bottom"}
        />
      )}
    </div>
  );
}
