/** A labelled on and off switch. */
export function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6 text-[13px] text-ink-2">
      {label}
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="relative h-[18px] w-8 shrink-0 rounded-full border border-edge bg-ground transition-colors peer-checked:border-signal peer-checked:bg-signal/80 peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:outline-signal after:absolute after:top-[2px] after:left-[2px] after:size-3 after:rounded-full after:bg-ink-2 after:transition-transform peer-checked:after:translate-x-[14px] peer-checked:after:bg-ground"
      />
    </label>
  );
}
