import { type KeyboardEvent, useId, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { emailPattern } from "~/lib/shares";
import { Avatar } from "./avatar";
import { Icon } from "./icons";
import { Floating } from "./ui/floating";
import { Input } from "./ui/input";

/** Someone the picker can offer: a member, a group, or a guest the project already knows. */
export interface Person {
  /** `member:<user id>`, `group:<id>` or `guest:<email>`. */
  key: string;
  name: string;
  /** Under the name in the list: an email, a label, how many a group holds. */
  hint?: string;
  kind: "member" | "group" | "guest";
}

const emailOf = (person: Person) =>
  person.kind === "guest" ? person.key.slice("guest:".length) : null;

/**
 * People, groups and guests in one field (#489): those chosen sit in it as chips, and the
 * rest are offered as you type, floated under it as a menu is. An email address no one
 * answers to is offered as a new guest. Enter takes the offer in hand, the arrows move it,
 * Backspace on an empty field lets the last one go. Where the chosen are listed beneath the
 * field instead (a step of a review, #500), `chips` is off: the field only adds.
 */
export function PeoplePicker({
  id,
  label,
  people,
  chosen,
  onChange,
  placeholder = "Names, groups or email addresses",
  autoFocus = false,
  chips = true,
  size = "md",
}: {
  id?: string;
  /** What the field asks, for a screen reader: its visible label is beside it. */
  label: string;
  people: Person[];
  chosen: Person[];
  onChange: (next: Person[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Whether the chosen sit in the field; off, the field adds and Backspace removes nobody. */
  chips?: boolean;
  /** Quiet, without a box of its own, where the field sits inside a card's row. */
  size?: "md" | "quiet";
}) {
  const own = useId();
  const listId = `${id ?? own}-list`;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  // Everyone is offered on a click or ArrowDown; typing offers who matches. The field opens
  // with the sheet, and a list opening with it would cover the fields under it.
  const [asked, setAsked] = useState(false);
  const [index, setIndex] = useState(0);

  const taken = new Set(chosen.map((p) => p.key));
  const needle = query.trim().toLowerCase();
  const matches = people
    .filter((p) => !taken.has(p.key))
    .filter(
      (p) =>
        needle === "" ||
        p.name.toLowerCase().includes(needle) ||
        (p.hint ?? "").toLowerCase().includes(needle) ||
        (emailOf(p) ?? "").includes(needle),
    )
    .slice(0, 7);
  // An address no one here answers to becomes a guest, named from it until they are renamed.
  const typedEmail =
    emailPattern.test(needle) &&
    !people.some((p) => emailOf(p) === needle || p.hint?.toLowerCase() === needle) &&
    !taken.has(`guest:${needle}`)
      ? needle
      : null;
  const offered: Person[] = [
    ...matches,
    ...(typedEmail
      ? [
          {
            key: `guest:${typedEmail}`,
            name: typedEmail,
            hint: "New guest",
            kind: "guest" as const,
          },
        ]
      : []),
  ];
  const open = focused && offered.length > 0 && (needle !== "" || asked);
  const current = Math.min(index, Math.max(0, offered.length - 1));

  const pick = (person: Person) => {
    onChange([...chosen, person]);
    setQuery("");
    setIndex(0);
    setAsked(false);
    input.current?.focus();
  };
  const drop = (key: string) => onChange(chosen.filter((p) => p.key !== key));
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!open && event.key === "ArrowDown") {
      event.preventDefault();
      setAsked(true);
    } else if (open && event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current + 1) % offered.length);
    } else if (open && event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current - 1 + offered.length) % offered.length);
    } else if (open && event.key === "Enter") {
      event.preventDefault();
      const person = offered[current];
      if (person) pick(person);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setFocused(false);
    } else if (chips && event.key === "Backspace" && query === "" && chosen.length > 0) {
      drop(chosen[chosen.length - 1]?.key ?? "");
    }
  };

  return (
    <div className="relative">
      <div
        ref={box}
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-control px-1.5 py-1 transition-colors",
          size === "md" && "border border-line-strong bg-ground/70 shadow-1 hover:border-edge",
          size === "md" && focused && "border-edge-strong",
          size === "quiet" && "border border-transparent hover:bg-raised/40",
          size === "quiet" && focused && "bg-raised/40",
        )}
      >
        {chips &&
          chosen.map((person) => (
            <span
              key={person.key}
              className="flex h-7 max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised/50 pr-0.5 pl-1 text-[13px] text-ink"
            >
              {person.kind === "group" ? (
                <Icon name="users" size={13} className="mx-1 shrink-0 text-ink-3" />
              ) : (
                <Avatar id={person.key} name={person.name} size={18} />
              )}
              <span className="min-w-0 truncate">{person.name}</span>
              <button
                type="button"
                aria-label={`Remove ${person.name}`}
                onClick={() => drop(person.key)}
                className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        {size === "quiet" && <Icon name="plus" size={13} className="ml-1 shrink-0 text-ink-3" />}
        <Input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setFocused(true);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setAsked(false);
          }}
          onClick={() => setAsked(true)}
          onKeyDown={onKeyDown}
          placeholder={!chips || chosen.length === 0 ? placeholder : undefined}
          // The box around it is the field: the control inside draws no edge of its own.
          className="h-7 w-auto min-w-32 flex-1 border-0 bg-transparent px-1.5 shadow-none hover:border-0 focus:border-0"
        />
      </div>
      {open && (
        <Floating
          anchor={box}
          align="stretch"
          id={listId}
          role="listbox"
          aria-label={label}
          data-e2e-overlap
          className="rise-in flex flex-col gap-0.5 rounded-panel bg-overlay p-1 shadow-3"
        >
          {offered.map((person, i) => (
            <div
              key={person.key}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === current}
              // Picked before the field loses focus, so the list is still there to pick from.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(person);
              }}
              onKeyDown={() => undefined}
              onPointerMove={() => setIndex(i)}
              className={cn(
                "flex h-9 cursor-pointer items-center gap-2.5 rounded-control px-2 text-[13px]",
                i === current ? "bg-raised text-ink" : "text-ink-2",
              )}
            >
              {person.kind === "group" ? (
                <span className="flex size-5 items-center justify-center text-ink-3">
                  <Icon name="users" size={14} />
                </span>
              ) : (
                <Avatar id={person.key} name={person.name} size={20} />
              )}
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              {person.hint && (
                <span className="min-w-0 shrink truncate text-[12px] text-ink-3">
                  {person.hint}
                </span>
              )}
            </div>
          ))}
        </Floating>
      )}
    </div>
  );
}
