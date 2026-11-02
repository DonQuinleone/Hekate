import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Seg } from "~/components/player/transport";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Floating } from "~/components/ui/floating";
import { Input } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { type FileKind, groups, guests, type Project, personById } from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";

/** What the sheet is opened from: one item, named and known by kind. */
export interface ShareItem {
  kind: "file" | "track" | "folder" | "version";
  name: string;
  /** A folder's contents, under its name; nothing else says more than its name (#578). */
  what?: string;
}

/** A file's kind, as the sheet names it under the file's name. */
export const fileKindWords: Record<FileKind, string> = {
  audio: "Audio",
  video: "Video",
  document: "Document",
  image: "Image",
  other: "File",
};

type Access = "view" | "comment";
const accessCopy: Record<Access, { label: string; hint: string }> = {
  view: { label: "Can view", hint: "They listen or look. Nothing is asked of them." },
  comment: { label: "Can comment", hint: "They are asked for feedback, without sign-off." },
};

/** What they may download (#578): nothing unless chosen, the review copy before the original. */
type Download = "none" | "proxy" | "original";
const downloadCopy: Record<Download, { label: string; hint: string | null }> = {
  none: { label: "No download", hint: null },
  proxy: {
    label: "Review copy",
    hint: "A review copy, made and marked for each of them. Every download is logged.",
  },
  original: {
    label: "Original",
    hint: "The original file, watermarked for each of them. Every download is logged.",
  },
};

/** When the recipients' access ends; null is until it is withdrawn. */
type Life = 7 | 14 | 30 | null;
const lives: Life[] = [7, 14, 30, null];
const lifeWords = (life: Life) => (life === null ? "When withdrawn" : `In ${life} days`);

export interface Person {
  key: string;
  name: string;
  hint?: string;
  kind: "member" | "group" | "guest";
  personId?: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * People, groups and guests in one field: those chosen sit in it as chips, the rest are
 * offered as you type, floated under it as a menu is; an address no one answers to is
 * offered as a new guest.
 */
export function PeopleField({
  people,
  chosen,
  onChange,
  placeholder = "Names, groups or email addresses",
  label = "Who",
}: {
  people: Person[];
  chosen: Person[];
  onChange: (next: Person[]) => void;
  placeholder?: string;
  label?: string;
}) {
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  // Everyone is offered on a click or ArrowDown; typing offers who matches.
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
        (p.hint ?? "").toLowerCase().includes(needle),
    )
    .slice(0, 7);
  const typed =
    emailPattern.test(needle) && !people.some((p) => p.hint?.toLowerCase() === needle)
      ? needle
      : null;
  const offered: Person[] = [
    ...matches,
    ...(typed
      ? [{ key: `guest:${typed}`, name: typed, hint: "New guest", kind: "guest" as const }]
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
    } else if (event.key === "Backspace" && query === "" && chosen.length > 0) {
      drop(chosen[chosen.length - 1]?.key ?? "");
    }
  };
  return (
    <div className="relative">
      <div
        ref={box}
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-control border border-line-strong bg-ground/70 px-1.5 py-1 shadow-1 transition-colors hover:border-edge",
          focused && "border-edge-strong",
        )}
      >
        {chosen.map((person) => (
          <span
            key={person.key}
            className="flex h-7 max-w-full items-center gap-1.5 rounded-chip border border-line bg-raised/50 pr-0.5 pl-1 text-[13px] text-ink"
          >
            {person.personId ? (
              <Avatar personId={person.personId} size={18} />
            ) : (
              <Icon
                name={person.kind === "group" ? "users" : "mail"}
                size={13}
                className="mx-1 shrink-0 text-ink-3"
              />
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
        <Input
          ref={input}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
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
          placeholder={chosen.length === 0 ? placeholder : undefined}
          className="h-7 w-auto min-w-32 flex-1 border-0 bg-transparent px-1.5 shadow-none"
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
              {person.personId ? (
                <Avatar personId={person.personId} size={20} />
              ) : (
                <span className="flex size-5 items-center justify-center text-ink-3">
                  <Icon name={person.kind === "group" ? "users" : "mail"} size={14} />
                </span>
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

/**
 * Sharing one item, as a share sheet does it: who, how, and a link, then Send. The item is
 * the title, so nothing asks what to share. Viewing is a share (sharing is not reviewing:
 * the same protections, nothing asked of them); commenting, and downloading with it, a
 * feedback review. "More options" carries the choices into the full request page, for
 * stages, an order or a deadline. The same sheet opens from a row in the file browser, the
 * player's header and a track's versions.
 */
export function ShareDialog({
  project,
  item: first,
  alternative,
  onClose,
}: {
  project: Project;
  item: ShareItem;
  /** Another thing it could share instead (#578): from a track's file, the file alone. */
  alternative?: ShareItem;
  onClose: () => void;
}) {
  const [alone, setAlone] = useState(false);
  const item = alone && alternative ? alternative : first;
  const viewer = useViewer();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<Person[]>([]);
  const [access, setAccess] = useState<Access>("view");
  const [download, setDownload] = useState<Download>("none");
  const [life, setLife] = useState<Life>(7);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const people: Person[] = [
    ...project.members
      .filter((m) => m.personId !== viewer.personId)
      .map((m): Person => {
        const person = personById(m.personId);
        return {
          key: `member:${m.personId}`,
          name: person.name,
          hint: person.email,
          kind: "member",
          personId: m.personId,
        };
      }),
    ...groups
      .filter((g) => g.projectId === project.id)
      .map(
        (g): Person => ({
          key: `group:${g.id}`,
          name: g.name,
          hint: `${g.personIds.length} people`,
          kind: "group",
        }),
      ),
    ...guests.map((g): Person => {
      const person = personById(g.personId);
      return {
        key: `guest:${g.personId}`,
        name: person.name,
        hint: g.label,
        kind: "guest",
        personId: g.personId,
      };
    }),
  ];
  // Only a folder's contents are worth a line under its name (#578); "Audio" says nothing.
  const what = item.kind === "folder" ? item.what : undefined;
  const link = sent
    ? "review.endlesshall.example/reviews/r-share-4k9x"
    : `review.endlesshall.example/${item.kind === "folder" ? "projects/p-album/files" : item.kind === "file" ? "files/f-dry" : "tracks/t-maple"}`;
  const copy = () => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const more = () => {
    onClose();
    navigate({
      to: "/reviews/new",
      search: { project: project.id, kind: access === "view" ? undefined : "feedback" },
    });
  };
  // For members who may open it already: never expires, opens nothing for anyone else.
  const linkRow = (
    <div className="flex min-w-0 items-center gap-2 text-[13px] text-ink-3">
      <Icon name="link" size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{link}</span>
      <Button variant="ghost" size="sm" onClick={copy} aria-live="polite">
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
  if (sent) {
    const names = chosen.map((p) => p.name);
    const who =
      names.length <= 2
        ? names.join(" and ")
        : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
    return (
      <Dialog
        title={`Share ${item.name}`}
        description={what}
        onClose={onClose}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {access === "view" ? "See who opens it" : "See the review"}
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 flex items-start gap-2 text-[14px] text-ink">
            <Icon name="check" size={15} className="mt-0.5 shrink-0 text-ink-2" />
            <span>
              {access === "view"
                ? `Shared with ${who}.`
                : `${who} ${chosen.length === 1 ? "is" : "are"} asked for feedback, without sign-off.`}{" "}
              Their access ends {life === null ? "when you withdraw it" : `in ${life} days`}. Guests
              get a link of their own by email.
            </span>
          </p>
          <div className="flex flex-col gap-1.5">
            <Label>Link for members with access</Label>
            {linkRow}
          </div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={`Share ${item.name}`}
      description={what}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={more} className="mr-auto">
            More options
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => setSent(true)} disabled={chosen.length === 0}>
            {access === "view" ? "Share" : "Ask for feedback"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {alternative && (
          <Seg
            size="md"
            label="What to share"
            value={alone ? "alone" : "whole"}
            onChange={(v) => setAlone(v === "alone")}
            options={[
              { id: "whole", label: first.name },
              { id: "alone", label: "This file only" },
            ]}
          />
        )}
        <div className="flex flex-col gap-1.5">
          <Label>Who</Label>
          <PeopleField people={people} chosen={chosen} onChange={setChosen} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>How</Label>
          <Seg
            size="md"
            label="How"
            value={access}
            onChange={setAccess}
            options={(["view", "comment"] as const).map((a) => ({
              id: a,
              label: accessCopy[a].label,
            }))}
          />
          <p className="m-0 text-[13px] text-ink-3">{accessCopy[access].hint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Download</Label>
          <Seg
            size="md"
            label="Download"
            value={download}
            onChange={setDownload}
            options={(["none", "proxy", "original"] as const).map((d) => ({
              id: d,
              label: downloadCopy[d].label,
            }))}
          />
          {downloadCopy[download].hint && (
            <p className="m-0 text-[13px] text-ink-3">{downloadCopy[download].hint}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Label>Access ends</Label>
          <Dropdown
            size="sm"
            label="Access ends"
            value={lifeWords(life)}
            actions={lives.map((choice) => ({
              label: lifeWords(choice),
              checked: choice === life,
              onSelect: () => setLife(choice),
            }))}
          />
        </div>
        <div className="flex flex-col gap-1.5 border-t border-line pt-4">
          <Label>Link for members with access</Label>
          {linkRow}
        </div>
      </div>
    </Dialog>
  );
}
