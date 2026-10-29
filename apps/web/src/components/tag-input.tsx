import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { tagSuggestions } from "~/lib/browser";
import { cn } from "~/lib/cn";
import type { Tag } from "~/lib/queries";
import { Icon } from "./icons";
import { Floating } from "./ui/floating";
import { BareInput } from "./ui/input";

/** One line of the suggestions: a tag the workspace has, or the typed name as a new one. */
type Suggestion = { kind: "tag"; tag: Tag } | { kind: "create"; name: string };

/**
 * Tags edited where they are shown, as Linear's labels and Notion's multi-selects are: each
 * tag a pill that a click takes off, and a field after them that offers the workspace's tags
 * as one types (most used first), or makes a new one from what was typed. Every change is
 * kept at once; there is no Save. Enter adds the highlighted suggestion, Backspace on an empty
 * field takes the last tag off, Escape closes the suggestions and then leaves.
 */
export function TagInput({
  tags,
  value: given,
  mixed = [],
  onChange,
  onCreate,
  label,
  autoFocus = false,
  onDone,
  disabled = false,
  className,
}: {
  /** The workspace's tags. */
  tags: Tag[];
  /** The ids on the thing (on every one, when there are several). */
  value: string[];
  /** When several things are tagged at once: the ids on some of them but not all. */
  mixed?: string[];
  onChange: (tagIds: string[]) => void;
  onCreate: (name: string) => Promise<Tag>;
  /** What is being tagged, for a screen reader: "Tags on Maple Leaf Rag - Score.pdf". */
  label: string;
  autoFocus?: boolean;
  /** Escape with nothing typed, or focus leaving: the editor may close. */
  onDone?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const box = useRef<HTMLFieldSetElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [making, setMaking] = useState(false);
  // What is chosen, ahead of the server: two tags added before the first save comes back
  // both stay, and each save sends the whole list as it stands here.
  const [value, setValue] = useState(given);
  const seen = useRef(given);
  if (seen.current !== given) {
    seen.current = given;
    setValue(given);
  }
  const change = (next: string[]) => {
    setValue(next);
    onChange(next);
  };
  // On the next frame, once a popover it sits in has been placed: it starts out of sight, and
  // focus cannot land on what is hidden.
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const byId = new Map(tags.map((t) => [t.id, t]));
  const { matches, create } = tagSuggestions(tags, [...value, ...mixed], typed);
  const options: Suggestion[] = [
    ...matches.map((tag): Suggestion => ({ kind: "tag", tag })),
    ...(create ? [{ kind: "create" as const, name: create }] : []),
  ];
  const highlighted = Math.min(active, Math.max(0, options.length - 1));

  const add = (tagId: string) => {
    if (!value.includes(tagId)) change([...value, tagId]);
    setTyped("");
    setActive(0);
    input.current?.focus();
  };
  const pick = async (option: Suggestion) => {
    if (option.kind === "tag") return add(option.tag.id);
    setMaking(true);
    const tag = await onCreate(option.name).catch(() => null);
    setMaking(false);
    if (tag) add(tag.id);
    else input.current?.focus();
  };
  const remove = (tagId: string) => {
    change(value.filter((t) => t !== tagId));
    input.current?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return setOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((highlighted + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[highlighted];
      if (open && chosen) void pick(chosen);
      else if (typed.trim() && chosen) void pick(chosen);
    } else if (event.key === "Backspace" && typed === "" && value.length > 0) {
      event.preventDefault();
      const last = value.at(-1);
      if (last) remove(last);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (typed || open) {
        setTyped("");
        setOpen(false);
      } else onDone?.();
    }
  };

  return (
    <fieldset
      ref={box}
      onBlur={(event) => {
        const to = event.relatedTarget;
        if (to instanceof Node && event.currentTarget.contains(to)) return;
        setOpen(false);
        setTyped("");
        onDone?.();
      }}
      className={cn(
        "m-0 flex min-w-0 flex-wrap items-center gap-1.5 rounded-control border border-line-strong bg-ground/70 px-1.5 py-1 shadow-1 transition-colors focus-within:border-edge-strong",
        disabled && "opacity-60",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {[...value, ...mixed].map((tagId) => {
        const name = byId.get(tagId)?.name;
        if (!name) return null;
        const some = mixed.includes(tagId);
        return (
          <button
            key={tagId}
            type="button"
            disabled={disabled}
            aria-label={
              some ? `${name}, on some of these: put it on all` : `Remove the tag ${name}`
            }
            title={some ? "On some of these. Click to put it on all." : undefined}
            onClick={() => (some ? add(tagId) : remove(tagId))}
            className={cn(
              "flex h-6 max-w-40 items-center gap-1 rounded-full border pr-1.5 pl-2 text-[12px] transition-colors",
              some
                ? "border-dashed border-edge text-ink-3 hover:border-edge-strong hover:text-ink"
                : "border-line bg-raised/40 text-ink-2 hover:border-edge hover:text-ink",
            )}
          >
            <span className="truncate">{name}</span>
            <Icon name={some ? "plus" : "close"} size={10} className="shrink-0" />
          </button>
        );
      })}
      <BareInput
        ref={input}
        role="combobox"
        aria-label={value.length ? "Add a tag" : label}
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open && options[highlighted] ? `${id}-${highlighted}` : undefined}
        aria-autocomplete="list"
        disabled={disabled || making}
        maxLength={40}
        placeholder={value.length ? "Add…" : "Add a tag"}
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className="h-6 min-w-20 flex-1 text-[13px]"
      />
      {open && (
        <Floating
          anchor={box}
          align="start"
          onClose={() => setOpen(false)}
          data-e2e-overlap
          className="rise-in max-h-60 w-64 rounded-panel bg-overlay p-1 shadow-3"
        >
          <div role="listbox" id={`${id}-list`} aria-label={`${label}: suggestions`}>
            {options.map((option, i) => (
              // Chosen with a pointer, or by the arrows and Enter from the field, which keeps
              // focus (aria-activedescendant): the option itself is never focused.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field's keys choose it.
              <div
                key={option.kind === "tag" ? option.tag.id : "create"}
                id={`${id}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === highlighted}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => setActive(i)}
                onClick={() => void pick(option)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2.5 rounded-control px-2 text-[13px] text-ink",
                  i === highlighted && "bg-raised",
                )}
              >
                <Icon
                  name={option.kind === "tag" ? "tag" : "plus"}
                  size={13}
                  className="shrink-0 text-ink-3"
                />
                <span className="min-w-0 flex-1 truncate">
                  {option.kind === "tag" ? option.tag.name : `Create “${option.name}”`}
                </span>
                {option.kind === "tag" && option.tag.files > 0 && (
                  <span className="tabular text-[12px] text-ink-3">{option.tag.files}</span>
                )}
              </div>
            ))}
            {options.length === 0 && (
              <p className="m-0 px-2 py-1.5 text-[12px] text-ink-3">
                {tags.length === 0 ? "Type a name to make the first tag." : "Every tag is on it."}
              </p>
            )}
          </div>
        </Floating>
      )}
    </fieldset>
  );
}
