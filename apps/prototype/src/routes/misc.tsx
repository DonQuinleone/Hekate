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
import { Select } from "~/components/ui/input";
import { notifications, people, personById } from "~/data";
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
];

export function SearchPage({ query: initial = "" }: { query?: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [query, setQuery] = useState(initial);
  const [type, setType] = useState("");
  const [projectId, setProjectId] = useState("");
  const [personId, setPersonId] = useState("");
  usePageHeader({ title: "Search" });
  const all = useMemo(() => everything(viewer), [viewer]);
  const hits = useMemo(
    () =>
      matches(query, all, 8).filter((h) => {
        if (type && (!h.file || h.file.kind !== type)) return false;
        if (projectId && h.projectId !== projectId) return false;
        if (personId && h.personId !== personId) return false;
        return true;
      }),
    [query, all, type, projectId, personId],
  );
  const q = query.trim();
  const filtered = Boolean(type || projectId || personId);
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
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setType("");
              setProjectId("");
              setPersonId("");
            }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
          <Kbd>{paletteKey}</Kbd> from anywhere
        </span>
      </div>
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
          Type to search what you may see, or narrow by kind, project and person.
        </p>
      ) : hits.length === 0 ? (
        <Empty title="No results" text={`Nothing matches “${q}” in what you can see.`} />
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
