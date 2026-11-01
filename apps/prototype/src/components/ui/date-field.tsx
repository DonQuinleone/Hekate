import { useState } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";
import { Floating } from "./floating";
import { Input } from "./input";
import { usePopover } from "./menu";

/*
 * Dates and times are typed in the workspace's format, never the browser's own (#541). The
 * prototype's workspace keeps the default: ISO 8601 and the 24-hour clock.
 */

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const monthTitle = new Intl.DateTimeFormat("en-GB", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** The days of a month, Monday first, padded with nulls to whole weeks. */
function monthGrid(year: number, month: number): (string | null)[][] {
  const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, i) => `${year}-${pad(month)}-${pad(i + 1)}`),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** A calendar day, typed or picked from the calendar at its end, written as ISO 8601. */
export function DateField({
  defaultValue = "",
  value: given,
  onChange,
  className,
  "aria-label": label,
}: {
  defaultValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const [own, setOwn] = useState(defaultValue);
  const value = given ?? own;
  const set = (v: string) => {
    setOwn(v);
    onChange?.(v);
  };
  const [open, setOpen, box] = usePopover();
  const start = value || "2026-10-14";
  const [shown, setShown] = useState({
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)),
  });
  const step = (by: number) => {
    const at = shown.year * 12 + (shown.month - 1) + by;
    setShown({ year: Math.floor(at / 12), month: (at % 12) + 1 });
  };
  return (
    <span ref={box} className={cn("relative inline-flex w-full min-w-0", className)}>
      <Input
        value={value}
        aria-label={label}
        placeholder="YYYY-MM-DD"
        onChange={(e) => set(e.target.value)}
        className="tabular pr-10"
      />
      <button
        type="button"
        data-e2e-overlap
        aria-label="Choose a day"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink"
      >
        <Icon name="calendar" size={14} />
      </button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          onClose={() => setOpen(false)}
          className="rise-in rounded-panel-lg bg-overlay p-3 shadow-3"
        >
          <div className="flex w-[244px] flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="pl-1 text-[13px] font-medium text-ink">
                {monthTitle.format(Date.UTC(shown.year, shown.month - 1, 1))}
              </span>
              <span className="flex">
                {(
                  [
                    [-1, "chevronLeft", "The month before"],
                    [1, "chevronRight", "The month after"],
                  ] as const
                ).map(([by, icon, words]) => (
                  <button
                    key={icon}
                    type="button"
                    aria-label={words}
                    onClick={() => step(by)}
                    className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
                  >
                    <Icon name={icon} size={14} />
                  </button>
                ))}
              </span>
            </div>
            <table className="w-full border-collapse text-center">
              <thead>
                <tr>
                  {WEEKDAYS.map((d) => (
                    <th key={d} scope="col" className="pb-1 text-[11px] font-normal text-ink-3">
                      {d}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthGrid(shown.year, shown.month).map((week) => (
                  <tr key={week.find(Boolean)}>
                    {week.map((day, i) => (
                      <td key={day ?? `empty-${i}`} className="p-0">
                        {day && (
                          <button
                            type="button"
                            aria-pressed={day === value}
                            onClick={() => {
                              set(day);
                              setOpen(false);
                            }}
                            className={cn(
                              "tabular mx-auto flex size-8 items-center justify-center rounded-control text-[13px] transition-colors",
                              day === value
                                ? "bg-ink font-medium text-ground"
                                : "text-ink-2 hover:bg-raised hover:text-ink",
                            )}
                          >
                            {Number(day.slice(8))}
                          </button>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Floating>
      )}
    </span>
  );
}

/** A time of day on the 24-hour clock. */
export function TimeField({
  defaultValue = "",
  className,
  "aria-label": label,
}: {
  defaultValue?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Input
      defaultValue={defaultValue}
      aria-label={label}
      placeholder="HH:MM"
      className={cn("tabular", className)}
    />
  );
}

/** A day and a time beside it. */
export function DateTimeField({
  defaultValue = "",
  className,
}: {
  defaultValue?: string;
  className?: string;
}) {
  const [day = "", time = ""] = defaultValue.split("T");
  return (
    <span className={cn("flex w-full min-w-0 gap-2", className)}>
      <DateField defaultValue={day} className="min-w-0 flex-1" />
      <TimeField defaultValue={time} className="w-24 shrink-0" />
    </span>
  );
}
