import { type InputHTMLAttributes, type ReactNode, useEffect, useRef } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";

type BoxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size">;

/**
 * A checkbox for picking things inside a form or a list; a setting that takes effect at once
 * is a Switch. The box is drawn on the tokens, checked in the signal colour as the switch is;
 * the native input stays underneath for focus,
 * keyboard and forms.
 */
export function Checkbox({
  className,
  indeterminate = false,
  ...props
}: BoxProps & {
  /** Partly on: a folder with some of its contents ticked. Shown as a dash, read as mixed. */
  indeterminate?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <input
        ref={ref}
        type="checkbox"
        aria-checked={indeterminate ? "mixed" : undefined}
        className="peer size-4 cursor-pointer appearance-none rounded-[4px] border border-edge-strong bg-ground/70 transition-colors checked:border-signal checked:bg-signal indeterminate:border-signal indeterminate:bg-signal hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <Icon
        name="check"
        size={12}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-auto text-ground opacity-0 peer-checked:opacity-100"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-auto h-0.5 w-2 rounded-full bg-ground opacity-0 peer-indeterminate:opacity-100"
      />
    </span>
  );
}

/** One of a few choices that exclude each other, in a form. */
export function Radio({ className, ...props }: BoxProps) {
  return (
    <span className={cn("relative inline-flex size-4 shrink-0", className)}>
      <input
        type="radio"
        className="peer size-4 cursor-pointer appearance-none rounded-full border border-edge-strong bg-ground/70 transition-colors checked:border-signal hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-auto size-2 rounded-full bg-signal opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

/** A checkbox or radio with its words beside it; clicking the words picks it. */
export function Choice({
  children,
  hint,
  className,
  ...props
}: BoxProps & { type?: "checkbox" | "radio"; children: ReactNode; hint?: ReactNode }) {
  const { type = "checkbox", ...rest } = props;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox or radio inside is the control.
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 text-[14px] text-ink has-[:disabled]:cursor-not-allowed has-[:disabled]:text-ink-3",
        className,
      )}
    >
      <span className="flex h-5 items-center">
        {type === "radio" ? <Radio {...rest} /> : <Checkbox {...rest} />}
      </span>
      <span className="min-w-0">
        {children}
        {hint && <span className="block text-[13px] text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * One of a few larger choices, each a card with a title and a line (a project's profile):
 * a radio underneath for the keyboard, the card itself showing which is chosen.
 */
export function ChoiceCard({
  title,
  hint,
  className,
  ...props
}: Omit<BoxProps, "children" | "title"> & { title: ReactNode; hint?: ReactNode }) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-panel border border-line p-3 text-[14px] text-ink-2 transition-colors hover:border-edge has-[:checked]:border-signal/60 has-[:checked]:bg-signal/10 has-[:checked]:text-ink has-[:focus-visible]:border-edge-strong",
        className,
      )}
    >
      <input type="radio" className="sr-only" {...props} />
      <span className="flex items-center gap-2 font-medium">{title}</span>
      {hint && <span className="text-[13px] text-ink-2">{hint}</span>}
    </label>
  );
}
