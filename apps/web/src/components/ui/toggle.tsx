import { cn } from "~/lib/cn";

/** A labelled on and off switch. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    // A button is a labelable element, so clicking the words flips the switch.
    // biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is the control.
    <label className="flex cursor-pointer items-center justify-between gap-6 text-[14px] text-ink">
      <span>
        {label}
        {hint && <span className="block text-[13px] text-ink-3">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Fixed where it is, such as a setting that cannot be turned off. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-signal" : "bg-edge enabled:hover:bg-edge-strong",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[2px] size-4 rounded-full bg-ink shadow-[0_1px_2px_rgb(0_0_0/0.4)] transition-[left] duration-200 ease-out",
          checked ? "left-[18px]" : "left-[2px]",
        )}
      />
    </button>
  );
}
