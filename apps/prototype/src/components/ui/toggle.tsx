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
        // Neutral when on: the signal is kept for the one thing on a surface that needs it.
        checked ? "bg-ink" : "bg-edge enabled:hover:bg-edge-strong",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[2px] size-4 rounded-full shadow-[0_1px_2px_rgb(0_0_0/0.4)] transition-[left,background-color] duration-200 ease-out",
          checked ? "left-[18px] bg-ground" : "left-[2px] bg-ink",
        )}
      />
    </button>
  );
}
