import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { cn } from "~/lib/cn";
import {
  dayPlaceholder,
  isDay,
  joinDayTime,
  monthGrid,
  readDay,
  readTime,
  showDay,
  showTime,
  splitDayTime,
  timePlaceholder,
} from "~/lib/date-field";
import { dateFormats, dayHere, formatDates } from "~/lib/locale";
import { Icon } from "../icons";
import { Floating } from "./floating";
import { type ControlSize, Input } from "./input";
import { usePopover } from "./menu";

interface FieldProps {
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** Shown as wrong (a border, and to a screen reader), as a field given a problem is. */
  invalid?: boolean;
  /** Small in a dense panel (a task's details), as an input is. */
  size?: ControlSize;
  className?: string;
}

const monthTitle = formatDates({ month: "long", year: "numeric", timeZone: "UTC" });
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/**
 * Typed words that follow their value, read as they are typed: `value` is what the parent holds
 * underneath, `show` writes it, `read` reads what was typed (null where it is not one). Typing
 * sets the value whenever the words read; on leaving, the words are written again the
 * workspace's way. What does not read is left as typed, marked wrong, the value unchanged.
 */
function useTyped(value: string, show: (v: string) => string, read: (t: string) => string | null) {
  const [text, setText] = useState(() => show(value));
  const [focused, setFocused] = useState(false);
  const shown = show(value);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const wrong = text.trim() !== "" && read(text) === null;
  return { text, setText, wrong, setFocused, shown };
}

/**
 * A calendar day, typed or picked, written in the workspace's date format (#541) rather than
 * the browser's: `2026-10-12`, `12 Oct 2026` or `Oct 12, 2026`, whichever it chose. Its value
 * is the day as ISO 8601 (`2026-10-12`), or "" for none, as a native date field's is. What is
 * typed is read in the same format, ISO 8601 and month names always; the calendar at its end
 * picks a day, Monday first.
 */
export function DateField({
  value,
  onChange,
  min,
  max,
  onLeave = false,
  size = "md",
  className,
  invalid,
  ...rest
}: FieldProps & {
  value: string;
  onChange: (value: string) => void;
  /** The first and last days that may be chosen, as ISO 8601. */
  min?: string;
  max?: string;
  /**
   * Set the value only as the field is left, Enter is pressed or a day is picked, never while
   * typing: for a field that saves as it changes (a deadline), so no day typed on the way is
   * saved.
   */
  onLeave?: boolean;
}) {
  const { dateFormat } = dateFormats();
  const read = (t: string) => {
    const day = readDay(t, dateFormat);
    return day && (!min || day >= min) && (!max || day <= max) ? day : null;
  };
  const typed = useTyped(value, (v) => showDay(v, dateFormat), read);
  const [open, setOpen, box] = usePopover();
  /** What was typed, set as the value where it reads and differs, and written again. */
  const commit = (text: string) => {
    const day = text.trim() ? read(text) : "";
    if (day === null) return;
    if (day !== value) onChange(day);
    typed.setText(showDay(day, dateFormat));
  };
  return (
    <span ref={box} className={cn("relative inline-flex w-full min-w-0", className)}>
      <Input
        {...rest}
        value={typed.text}
        size={size}
        placeholder={dayPlaceholder(dateFormat)}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || typed.wrong || undefined}
        className={size === "sm" ? "tabular pr-8" : "tabular pr-10"}
        onFocus={() => typed.setFocused(true)}
        onBlur={() => {
          typed.setFocused(false);
          if (onLeave) commit(typed.text);
          else if (!typed.wrong) typed.setText(typed.shown);
        }}
        onChange={(e) => {
          typed.setText(e.target.value);
          if (onLeave) return;
          if (!e.target.value.trim()) return onChange("");
          // Only once the year is whole: "12 Oct 20" is on its way to 2026, not 2020.
          const day = /\d{4}/.test(e.target.value) ? read(e.target.value) : null;
          if (day) onChange(day);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onLeave) commit(typed.text);
          if (e.key === "ArrowDown" && e.altKey) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      />
      <button
        type="button"
        data-e2e-overlap
        aria-label={rest["aria-label"] ? `${rest["aria-label"]}: choose a day` : "Choose a day"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={rest.disabled}
        onClick={() => setOpen(!open)}
        className={cn(
          "absolute top-1/2 right-1 flex -translate-y-1/2 items-center justify-center rounded-control text-ink-3 transition-colors enabled:hover:bg-raised enabled:hover:text-ink disabled:opacity-60",
          size === "sm" ? "right-0.5 size-6" : "size-7",
        )}
      >
        <Icon name="calendar" size={size === "sm" ? 13 : 14} />
      </button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Calendar"
          className="rise-in rounded-panel-lg bg-overlay p-3 shadow-3"
        >
          <Calendar
            value={isDay(value) ? value : ""}
            min={min}
            max={max}
            onPick={(day) => {
              onChange(day);
              typed.setText(showDay(day, dateFormat));
              setOpen(false);
            }}
          />
        </Floating>
      )}
    </span>
  );
}

/** A month of days to pick one from, opened on the chosen day's month or today's. */
export function Calendar({
  value,
  min,
  max,
  onPick,
}: {
  value: string;
  min?: string;
  max?: string;
  onPick: (day: string) => void;
}) {
  const today = dayHere();
  const start = value || today;
  const [shown, setShown] = useState({
    year: Number(start.slice(0, 4)),
    month: Number(start.slice(5, 7)),
  });
  const label = useId();
  const step = (by: number) => {
    const at = shown.year * 12 + (shown.month - 1) + by;
    setShown({ year: Math.floor(at / 12), month: (at % 12) + 1 });
  };
  const allowed = (day: string) => (!min || day >= min) && (!max || day <= max);
  const focusDay = (from: HTMLElement, day: string) => {
    const grid = from.closest("table");
    const target = grid?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);
    if (target) target.focus();
    else {
      setShown({ year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) });
      requestAnimationFrame(() =>
        grid?.querySelector<HTMLButtonElement>(`[data-day="${day}"]`)?.focus(),
      );
    }
  };
  // The arrows move a day or a week, as in every date picker; Home and End go to the week's ends.
  const keys = (e: KeyboardEvent<HTMLButtonElement>, day: string) => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const by = moves[e.key];
    if (by === undefined) return;
    e.preventDefault();
    const next = new Date(`${day}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + by);
    focusDay(e.currentTarget, next.toISOString().slice(0, 10));
  };
  const weeks = monthGrid(shown.year, shown.month);
  const focusable =
    value && value.slice(0, 7) === `${shown.year}-${String(shown.month).padStart(2, "0")}`
      ? value
      : (weeks.flat().find((d) => d === today) ?? weeks.flat().find(Boolean));
  return (
    <div className="flex w-[244px] flex-col gap-2">
      <div className="flex items-center justify-between">
        <span id={label} className="pl-1 text-[13px] font-medium text-ink">
          {monthTitle.format(Date.UTC(shown.year, shown.month - 1, 1))}
        </span>
        <span className="flex">
          <button
            type="button"
            aria-label="The month before"
            onClick={() => step(-1)}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            aria-label="The month after"
            onClick={() => step(1)}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="chevronRight" size={14} />
          </button>
        </span>
      </div>
      <table aria-labelledby={label} className="w-full border-collapse text-center">
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
          {weeks.map((week) => (
            <tr key={week.find(Boolean)}>
              {week.map((day, i) => (
                <td key={day ?? `empty-${i}`} className="p-0">
                  {day && (
                    <button
                      type="button"
                      data-day={day}
                      tabIndex={day === focusable ? 0 : -1}
                      aria-pressed={day === value}
                      aria-current={day === today ? "date" : undefined}
                      disabled={!allowed(day)}
                      onClick={() => onPick(day)}
                      onKeyDown={(e) => keys(e, day)}
                      className={cn(
                        "tabular mx-auto flex size-8 items-center justify-center rounded-control text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                        day === value
                          ? "bg-ink font-medium text-ground"
                          : "text-ink-2 enabled:hover:bg-raised enabled:hover:text-ink",
                        day === today &&
                          day !== value &&
                          "font-medium text-ink underline underline-offset-4",
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
  );
}

/**
 * A time of day, typed on the workspace's clock (#541): `13:05`, or `1:05 pm`. Its value is
 * `HH:MM` on the 24-hour clock, or "" for none, as a native time field's is. Either clock is
 * read, however it is typed: `1305`, `9.30`, `1pm`.
 */
export function TimeField({
  value,
  onChange,
  size = "md",
  className,
  invalid,
  ...rest
}: FieldProps & { value: string; onChange: (value: string) => void }) {
  const { timeFormat } = dateFormats();
  const typed = useTyped(value, (v) => showTime(v, timeFormat), readTime);
  return (
    <Input
      {...rest}
      value={typed.text}
      size={size}
      placeholder={timePlaceholder(timeFormat)}
      autoComplete="off"
      spellCheck={false}
      inputMode="text"
      aria-invalid={invalid || typed.wrong || undefined}
      className={cn("tabular", className)}
      onFocus={() => typed.setFocused(true)}
      onBlur={() => {
        typed.setFocused(false);
        if (!typed.wrong) typed.setText(typed.shown);
      }}
      onChange={(e) => {
        typed.setText(e.target.value);
        if (!e.target.value.trim()) return onChange("");
        const time = readTime(e.target.value);
        if (time) onChange(time);
      }}
    />
  );
}

/**
 * A day and a time beside it, each written the workspace's way (#541). Its value is local
 * `YYYY-MM-DDTHH:MM`, or "" for none, as a native date and time field's is; a day with no time
 * is its midnight.
 */
export function DateTimeField({
  value,
  onChange,
  min,
  max,
  className,
  ...rest
}: FieldProps & {
  value: string;
  onChange: (value: string) => void;
  /** The first and last days that may be chosen, as the value is written. */
  min?: string;
  max?: string;
}) {
  const { day, time } = splitDayTime(value);
  const label = rest["aria-label"];
  return (
    <span className={cn("flex w-full min-w-0 gap-2", className)}>
      <DateField
        {...rest}
        aria-label={label ? `${label}: day` : undefined}
        value={day}
        min={min ? splitDayTime(min).day : undefined}
        max={max ? splitDayTime(max).day : undefined}
        onChange={(d) => onChange(joinDayTime(d, time))}
        className="min-w-0 flex-1"
      />
      <TimeField
        aria-label={label ? `${label}: time` : "Time"}
        disabled={rest.disabled}
        value={time}
        onChange={(t) => onChange(joinDayTime(day, t))}
        className="w-24 shrink-0"
      />
    </span>
  );
}
