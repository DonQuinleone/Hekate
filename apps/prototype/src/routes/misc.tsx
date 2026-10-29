import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Avatar } from "~/components/avatar";
import { paletteKey, ResultRow } from "~/components/command-palette";
import { Icon } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { notificationIcon } from "~/components/notifications";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Floating } from "~/components/ui/floating";
import { Input, Select } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import { comments, notifications, people, personById } from "~/data";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/format";
import { everything, type Hit, type HitGroup, matches } from "~/lib/search";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

export function NotificationsPage() {
  const navigate = useNavigate();
  const [read, setRead] = useState<Set<string>>(
    new Set(notifications.filter((n) => n.read).map((n) => n.id)),
  );
  usePageHeader({
    title: "Notifications",
    actions: (
      <Button variant="ghost" onClick={() => setRead(new Set(notifications.map((n) => n.id)))}>
        Mark all read
      </Button>
    ),
  });
  const groups: [string, typeof notifications][] = [
    ["Today", notifications.filter((n) => n.at.startsWith("2026-10-14"))],
    ["Yesterday", notifications.filter((n) => n.at.startsWith("2026-10-13"))],
  ];
  return (
    <StateGate
      empty={
        <div className="p-8">
          <Empty
            title="Nothing new"
            text="Decisions, replies, new versions, stage changes and assignments arrive here, and by mail as you choose."
          />
        </div>
      }
    >
      <Page width="narrow" className="gap-6">
        {groups.map(([title, list]) => (
          <section key={title} className="flex flex-col gap-1">
            <Label className="mb-1">{title}</Label>
            {list.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  setRead((r) => new Set(r).add(n.id));
                  navigate({ to: n.href });
                }}
                className="flex items-start gap-3 rounded-panel px-2 py-2.5 text-left transition-colors hover:bg-raised/60"
              >
                <span className="relative mt-0.5">
                  <Avatar personId={n.personId} size={28} />
                  <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-overlay text-ink-2 shadow-2">
                    <Icon name={notificationIcon[n.kind]} size={9} />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn("block text-[14px]", read.has(n.id) ? "text-ink-2" : "text-ink")}
                  >
                    <span className="font-medium text-ink">{personById(n.personId).name}</span>{" "}
                    {n.text}
                  </span>
                  <span className="tabular block text-[12px] text-ink-3">{ago(n.at)}</span>
                </span>
                {!read.has(n.id) && (
                  <span className="mt-2 size-2 rounded-full bg-signal" title="Unread" />
                )}
              </button>
            ))}
          </section>
        ))}
      </Page>
    </StateGate>
  );
}

const saved = [
  { id: "s-1", name: "Unviewed 96 kHz masters", query: "kind:audio rate:96 unviewed" },
  { id: "s-2", name: "Comments about noise", query: "comment:noise category:Noise" },
  { id: "s-3", name: "Cuts over a minute at 23.976", query: "duration:>1m fps:23.976" },
];

/** A search by field (decision 263): a file's duration and size, its frame rate, its comments. */
interface Fields {
  /** Minutes. */
  durationMin?: number;
  durationMax?: number;
  /** Megabytes. */
  sizeMin?: number;
  sizeMax?: number;
  frameRate?: number;
  commentText?: string;
}
const frameRates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const MB = 1_000_000;

/** The fields set, each as a chip that clears what it says. */
function fieldChips(f: Fields): { keys: (keyof Fields)[]; label: string }[] {
  const chips: { keys: (keyof Fields)[]; label: string }[] = [];
  if (f.durationMin && f.durationMax)
    chips.push({
      keys: ["durationMin", "durationMax"],
      label: `${f.durationMin} min to ${f.durationMax} min`,
    });
  else if (f.durationMin)
    chips.push({ keys: ["durationMin"], label: `Longer than ${f.durationMin} min` });
  else if (f.durationMax)
    chips.push({ keys: ["durationMax"], label: `Shorter than ${f.durationMax} min` });
  if (f.sizeMin && f.sizeMax)
    chips.push({ keys: ["sizeMin", "sizeMax"], label: `${f.sizeMin} MB to ${f.sizeMax} MB` });
  else if (f.sizeMin) chips.push({ keys: ["sizeMin"], label: `Over ${f.sizeMin} MB` });
  else if (f.sizeMax) chips.push({ keys: ["sizeMax"], label: `Under ${f.sizeMax} MB` });
  if (f.frameRate) chips.push({ keys: ["frameRate"], label: `${f.frameRate} fps` });
  if (f.commentText)
    chips.push({ keys: ["commentText"], label: `Comments say “${f.commentText}”` });
  return chips;
}

/** Whether a hit passes the fields: a file by its measures and comments, a comment by its words. */
function passes(hit: Hit, f: Fields): boolean {
  const said = f.commentText?.toLowerCase();
  const fileFields = Boolean(
    f.durationMin || f.durationMax || f.sizeMin || f.sizeMax || f.frameRate,
  );
  if (hit.group === "Comments")
    return !fileFields && (!said || hit.label.toLowerCase().includes(said));
  if (!hit.file) return !fileFields && !said;
  const { media, size } = hit.file;
  if (f.durationMin && media.duration < f.durationMin * 60) return false;
  if (f.durationMax && media.duration > f.durationMax * 60) return false;
  if (f.sizeMin && size < f.sizeMin * MB) return false;
  if (f.sizeMax && size > f.sizeMax * MB) return false;
  if (f.frameRate && Math.abs((media.fps ?? 0) - f.frameRate) > 0.01) return false;
  if (said) {
    const id = hit.file.id;
    return comments.some((c) => c.fileId === id && c.body.toLowerCase().includes(said));
  }
  return true;
}

/**
 * The Fields control beside the search's menus: the fields filled in together and applied at
 * once, each set one then a chip under the menus.
 */
function FieldsMenu({ fields, onApply }: { fields: Fields; onApply: (next: Fields) => void }) {
  const [open, setOpen, box] = usePopover();
  const [draft, setDraft] = useState<Record<keyof Fields, string>>({
    durationMin: "",
    durationMax: "",
    sizeMin: "",
    sizeMax: "",
    frameRate: "",
    commentText: "",
  });
  const count = fieldChips(fields).length;
  const edit = (key: keyof Fields) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  const num = (text: string) => Number(text.replace(",", ".")) || undefined;
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (!open)
            setDraft({
              durationMin: fields.durationMin ? String(fields.durationMin) : "",
              durationMax: fields.durationMax ? String(fields.durationMax) : "",
              sizeMin: fields.sizeMin ? String(fields.sizeMin) : "",
              sizeMax: fields.sizeMax ? String(fields.sizeMax) : "",
              frameRate: fields.frameRate ? String(fields.frameRate) : "",
              commentText: fields.commentText ?? "",
            });
          setOpen(!open);
        }}
        className={count ? "text-ink" : "text-ink-3"}
      >
        <Icon name="sliders" size={14} />
        Fields
        {count > 0 && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
            {count}
          </span>
        )}
      </Button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Search by field"
          className="rise-in w-80 rounded-panel-lg bg-overlay p-3 shadow-4"
        >
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              onApply({
                durationMin: num(draft.durationMin),
                durationMax: num(draft.durationMax),
                sizeMin: num(draft.sizeMin),
                sizeMax: num(draft.sizeMax),
                frameRate: num(draft.frameRate),
                commentText: draft.commentText.trim() || undefined,
              });
              setOpen(false);
            }}
          >
            {(
              [
                ["Duration, in minutes", "durationMin", "durationMax"],
                ["Size, in MB", "sizeMin", "sizeMax"],
              ] as const
            ).map(([legend, min, max]) => (
              <fieldset key={legend} className="m-0 grid grid-cols-2 gap-2 border-0 p-0">
                <legend className="mb-1.5 p-0 text-[13px] text-ink-2">{legend}</legend>
                <Input
                  aria-label={`${legend}, at least`}
                  placeholder="At least"
                  inputMode="decimal"
                  value={draft[min]}
                  onChange={edit(min)}
                />
                <Input
                  aria-label={`${legend}, at most`}
                  placeholder="At most"
                  inputMode="decimal"
                  value={draft[max]}
                  onChange={edit(max)}
                />
              </fieldset>
            ))}
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Frame rate
              <Select value={draft.frameRate} onChange={edit("frameRate")}>
                <option value="">Any frame rate</option>
                {frameRates.map((rate) => (
                  <option key={rate} value={String(rate)}>
                    {rate} fps
                  </option>
                ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Comments say
              <Input
                value={draft.commentText}
                onChange={edit("commentText")}
                placeholder="Words in a comment"
              />
            </label>
            <div className="flex justify-end gap-2 border-t border-line pt-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onApply({});
                  setOpen(false);
                }}
              >
                Clear fields
              </Button>
              <Button type="submit" variant="primary" size="sm">
                Apply
              </Button>
            </div>
          </form>
        </Floating>
      )}
    </div>
  );
}

export function SearchPage({ query: initial = "" }: { query?: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [query, setQuery] = useState(initial);
  const [type, setType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [personId, setPersonId] = useState("");
  const [fields, setFields] = useState<Fields>({});
  usePageHeader({ title: "Search" });
  const all = useMemo(() => everything(viewer), [viewer]);
  const byField = fieldChips(fields).length > 0;
  const hits = useMemo(
    () =>
      // With fields and no words, everything the fields let through, newest first.
      (query.trim() || !byField
        ? matches(query, all, 8)
        : all.filter((h) => h.file || h.group === "Comments")
      ).filter((h) => {
        if (type && (!h.file || h.file.kind !== type)) return false;
        if (projectId && h.projectId !== projectId) return false;
        if (personId && h.personId !== personId) return false;
        return passes(h, fields);
      }),
    [query, all, type, projectId, personId, fields, byField],
  );
  const q = query.trim();
  const filtered = Boolean(type || projectId || personId || byField);
  const go = (hit: Hit) => {
    if (hit.run) hit.run();
    else if (hit.destination)
      navigate({
        to: hit.destination.to,
        params: hit.destination.params ?? {},
        search: hit.destination.search ?? {},
      });
  };
  let lastGroup: HitGroup | null = null;
  return (
    <Page width="narrow" className="gap-5">
      <div className="relative">
        <Icon
          name="search"
          size={18}
          className="absolute top-1/2 left-4 -translate-y-1/2 text-ink-3"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Projects, tracks, files, reviews, tasks, people and comments"
          aria-label="Search"
          className="h-12 w-full rounded-panel-lg border border-line bg-raised/40 pr-4 pl-12 text-[16px] text-ink shadow-1 placeholder:text-ink-3 focus:border-edge-strong focus:outline-none"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value)} className="w-32">
          <option value="">Any kind</option>
          <option value="audio">Audio</option>
          <option value="video">Video</option>
          <option value="document">Documents</option>
          <option value="image">Pictures</option>
        </Select>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-40">
          <option value="">Any project</option>
          {viewer.projects().map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={personId} onChange={(e) => setPersonId(e.target.value)} className="w-40">
          <option value="">Anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <FieldsMenu fields={fields} onApply={setFields} />
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setType("");
              setProjectId("");
              setPersonId("");
              setFields({});
            }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
          <Kbd>{paletteKey}</Kbd> from anywhere
        </span>
      </div>
      {byField && (
        <ul aria-label="Fields" className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
          {fieldChips(fields).map((chip) => (
            <li
              key={chip.keys.join()}
              className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised/40 pr-1 pl-2.5 text-[12px] text-ink-2"
            >
              <span className="max-w-64 truncate">{chip.label}</span>
              <button
                type="button"
                aria-label={`Remove ${chip.label}`}
                onClick={() =>
                  setFields(
                    Object.fromEntries(
                      Object.entries(fields).filter(([k]) => !(chip.keys as string[]).includes(k)),
                    ),
                  )
                }
                className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink"
              >
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {!q && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-ink-3">Saved</span>
          {saved.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setQuery(s.query)}
              className="flex h-7 items-center rounded-chip border border-line px-2.5 text-[13px] text-ink-2 transition-colors hover:border-edge-strong hover:text-ink"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {!q && !filtered ? (
        <p className="text-[13px] text-ink-3">
          Type to search what you may see, or narrow by kind, project, person and a file's fields.
        </p>
      ) : hits.length === 0 ? (
        <Empty
          title="No results"
          text={
            q
              ? `Nothing matches “${q}” in what you can see.`
              : "Nothing matches these filters in what you can see."
          }
        />
      ) : (
        <div className="flex flex-col">
          {hits.map((hit) => {
            const head = hit.group !== lastGroup;
            lastGroup = hit.group;
            return (
              <div key={`${hit.group}-${hit.id}`}>
                {head && <Label className="mt-4 mb-1 block px-3 first:mt-0">{hit.group}</Label>}
                <ResultRow hit={hit} onSelect={go} />
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
