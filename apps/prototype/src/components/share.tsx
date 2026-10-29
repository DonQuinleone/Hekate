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
  /** What it is, under the name: "Recording", "Track", "V3". The kind, when left out. */
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

const kindWords: Record<ShareItem["kind"], string> = {
  file: "File",
  track: "Track",
  folder: "Folder",
  version: "Version",
};

type Access = "view" | "comment" | "download";
const accessCopy: Record<Access, { label: string; hint: string }> = {
  view: { label: "Can view", hint: "They listen or look. Nothing is asked of them." },
  comment: { label: "Can comment", hint: "They leave comments on it. No sign-off is asked." },
  download: {
    label: "Can download",
    hint: "They comment, and download the original, watermarked for them.",
  },
};

type Life = 7 | 14 | 30 | null;
const lives: Life[] = [7, 14, 30, null];
const lifeWords = (life: Life) =>
  life === null ? "Link works until withdrawn" : `Link works for ${life} days`;

interface Person {
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
function PeopleField({
  people,
  chosen,
  onChange,
}: {
  people: Person[];
  chosen: Person[];
  onChange: (next: Person[]) => void;
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
          aria-label="Who"
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
          placeholder={chosen.length === 0 ? "Names, groups or email addresses" : undefined}
          className="h-7 w-auto min-w-32 flex-1 border-0 bg-transparent px-1.5 shadow-none"
        />
      </div>
      {open && (
        <Floating
          anchor={box}
          align="stretch"
          id={listId}
          role="listbox"
          aria-label="Who"
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
  item,
  onClose,
}: {
  project: Project;
  item: ShareItem;
  onClose: () => void;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<Person[]>([]);
  const [access, setAccess] = useState<Access>("view");
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
  const what = item.what ?? kindWords[item.kind];
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
  const linkRow = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex h-9 min-w-0 flex-1 basis-56 items-center gap-2 rounded-control border border-line bg-ground/70 pr-1 pl-3">
        <Icon name="link" size={14} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{link}</span>
        <Button variant="ghost" size="sm" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {sent ? (
        <span className="text-[13px] text-ink-2">{lifeWords(life)}</span>
      ) : (
        <Dropdown
          size="sm"
          label="How long the link works"
          value={lifeWords(life)}
          actions={lives.map((choice) => ({
            label: choice === null ? "Until withdrawn" : `${choice} days`,
            checked: choice === life,
            onSelect: () => setLife(choice),
          }))}
        />
      )}
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
          <p className="m-0 flex items-center gap-2 text-[14px] text-ink">
            <Icon name="check" size={15} className="shrink-0 text-ink-2" />
            Sent to {who}. Guests get a link of their own by email.
          </p>
          {linkRow}
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
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
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
            options={(["view", "comment", "download"] as const).map((a) => ({
              id: a,
              label: accessCopy[a].label,
            }))}
          />
          <p className="m-0 text-[13px] text-ink-3">{accessCopy[access].hint}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Link</Label>
          {linkRow}
        </div>
      </div>
    </Dialog>
  );
}
