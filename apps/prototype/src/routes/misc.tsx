import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { comments, files, people, personById, projects, tracks } from "~/data";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

const notifications = [
  {
    id: "n-1",
    at: "2026-10-14T20:41:00Z",
    personId: "p-tomas",
    text: "uploaded Maple Leaf Rag V3",
    kind: "version",
    href: "/tracks/t-maple",
    read: false,
  },
  {
    id: "n-2",
    at: "2026-10-14T19:25:00Z",
    personId: "p-alex",
    text: "replied to your comment on Maple Leaf Rag V2",
    kind: "reply",
    href: "/files/file-maple-v2-dry?comment=c-2",
    read: false,
  },
  {
    id: "n-3",
    at: "2026-10-14T14:20:00Z",
    personId: "p-tomas",
    text: "requested changes on Album masters",
    kind: "decision",
    href: "/reviews/rev-masters",
    read: false,
  },
  {
    id: "n-4",
    at: "2026-10-14T12:35:00Z",
    personId: "p-tomas",
    text: "submitted feedback on Mix notes, round two",
    kind: "decision",
    href: "/reviews/rev-mixnotes",
    read: true,
  },
  {
    id: "n-5",
    at: "2026-10-14T10:02:00Z",
    personId: "p-mira",
    text: "approved Album masters",
    kind: "decision",
    href: "/reviews/rev-masters",
    read: true,
  },
  {
    id: "n-6",
    at: "2026-10-13T20:00:00Z",
    personId: "p-mira",
    text: "assigned you: move the title away from the sleeve edge",
    kind: "assignment",
    href: "/projects/proj-joplin/tasks",
    read: true,
  },
  {
    id: "n-7",
    at: "2026-10-13T19:05:00Z",
    personId: "p-tomas",
    text: "moved Opening titles to With director",
    kind: "stage",
    href: "/tracks/t-titles",
    read: true,
  },
];
const kindIcon: Record<string, IconName> = {
  version: "upload",
  reply: "comment",
  decision: "review",
  assignment: "users",
  stage: "board",
};

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
      <div className="fade-in mx-auto flex w-full max-w-[760px] flex-col gap-6 px-4 py-6 @3xl/app:px-8">
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
                    <Icon name={kindIcon[n.kind] ?? "bell"} size={9} />
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
      </div>
    </StateGate>
  );
}

const saved = [
  { id: "s-1", name: "Unviewed 96 kHz masters", query: "kind:audio rate:96 unviewed" },
  { id: "s-2", name: "Comments about noise", query: "comment:noise category:Noise" },
];

export function SearchPage() {
  const viewer = useViewer();
  const [query, setQuery] = useState("");
  const [advanced, setAdvanced] = useState(false);
  usePageHeader({ title: "Search" });
  const q = query.trim().toLowerCase();
  const hit = (s: string) => q.length > 0 && s.toLowerCase().includes(q);
  const results = {
    projects: projects.filter((p) => viewer.canSee(p.id) && hit(p.name)),
    tracks: tracks.filter((t) => viewer.canSee(t.projectId) && hit(t.name)),
    files: files.filter((f) => viewer.canSee(f.projectId) && hit(f.name)),
    comments: comments.filter((c) => hit(c.body)),
    people: people.filter((p) => hit(p.name)),
  };
  const total = Object.values(results).reduce((n, l) => n + l.length, 0);
  return (
    <div className="fade-in mx-auto flex w-full max-w-[880px] flex-col gap-5 px-4 py-6 @3xl/app:px-8">
      <div className="relative">
        <Icon
          name="search"
          size={16}
          className="absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-3"
        />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Projects, files, tracks, comments and people"
          aria-label="Search"
          className="h-12 w-full rounded-panel-lg border border-line bg-raised/40 pr-24 pl-10 text-[16px] text-ink shadow-2 placeholder:text-ink-3 focus:border-edge-strong focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          className={cn(
            "absolute top-1/2 right-2 flex h-8 -translate-y-1/2 items-center gap-1.5 rounded-control px-2.5 text-[13px] transition-colors",
            advanced ? "bg-raised text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          <Icon name="filter" size={14} />
          Fields
        </button>
      </div>
      {advanced && (
        <div className="rise-in grid gap-3 rounded-panel-lg border border-line bg-raised/25 p-4 @3xl/app:grid-cols-3">
          {[
            [
              "Type",
              <Select key="t" defaultValue="">
                <option value="">Any</option>
                <option>Audio</option>
                <option>Video</option>
                <option>Document</option>
                <option>Picture</option>
              </Select>,
            ],
            [
              "Duration",
              <span key="d" className="flex items-center gap-2">
                <Input placeholder="min" className="w-20" />
                <span className="text-ink-3">to</span>
                <Input placeholder="max" className="w-20" />
              </span>,
            ],
            [
              "Size",
              <span key="s" className="flex items-center gap-2">
                <Input placeholder="MB" className="w-20" />
                <span className="text-ink-3">to</span>
                <Input placeholder="MB" className="w-20" />
              </span>,
            ],
            [
              "Frame rate",
              <Select key="f" defaultValue="">
                <option value="">Any</option>
                <option>24</option>
                <option>25</option>
                <option>29.97</option>
                <option>50</option>
              </Select>,
            ],
            ["Tags", <Input key="g" placeholder="master, approved" />],
            [
              "Uploaded by",
              <Select key="u" defaultValue="">
                <option value="">Anyone</option>
                {people.map((p) => (
                  <option key={p.id}>{p.name}</option>
                ))}
              </Select>,
            ],
            ["Comment text", <Input key="c" placeholder="words in a comment" />],
            [
              "Project",
              <Select key="p" defaultValue="">
                <option value="">Any</option>
                {projects.map((p) => (
                  <option key={p.id}>{p.name}</option>
                ))}
              </Select>,
            ],
          ].map(([label, control]) => (
            <label key={String(label)} className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              {label}
              {control}
            </label>
          ))}
          <div className="flex items-end justify-end gap-2 @3xl/app:col-span-3">
            <Button variant="ghost">Save this search</Button>
            <Button variant="primary">Search</Button>
          </div>
        </div>
      )}
      <div className="grid gap-8 @3xl/app:grid-cols-[minmax(0,1fr)_220px]">
        <div className="flex min-w-0 flex-col gap-6">
          {q.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              Type to search. <Kbd>/</Kbd> opens this from anywhere.
            </p>
          ) : total === 0 ? (
            <Empty title="No results" text={`Nothing matches “${query}” in what you can see.`} />
          ) : (
            <>
              {results.projects.length > 0 && (
                <section className="flex flex-col gap-1">
                  <Label>Projects</Label>
                  {results.projects.map((p) => (
                    <Link
                      key={p.id}
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      className="flex items-center gap-3 rounded-panel px-2 py-2 hover:bg-raised/60"
                    >
                      <Icon name="folder" className="text-ink-3" />
                      <span className="text-[14px] text-ink">{p.name}</span>
                    </Link>
                  ))}
                </section>
              )}
              {results.tracks.length > 0 && (
                <section className="flex flex-col gap-1">
                  <Label>Tracks</Label>
                  {results.tracks.map((t) => (
                    <Link
                      key={t.id}
                      to="/tracks/$trackId"
                      params={{ trackId: t.id }}
                      className="flex items-center gap-3 rounded-panel px-2 py-2 hover:bg-raised/60"
                    >
                      <Icon name="track" className="text-ink-3" />
                      <span className="text-[14px] text-ink">{t.name}</span>
                      <span className="text-[13px] text-ink-3">{t.versions.length} versions</span>
                    </Link>
                  ))}
                </section>
              )}
              {results.files.length > 0 && (
                <section className="flex flex-col gap-1">
                  <Label>Files</Label>
                  {results.files.map((f) => (
                    <Link
                      key={f.id}
                      to="/files/$fileId"
                      params={{ fileId: f.id }}
                      className="flex items-center gap-3 rounded-panel px-2 py-2 hover:bg-raised/60"
                    >
                      <Thumb file={f} width={40} height={26} />
                      <span className="truncate text-[14px] text-ink">{f.name}</span>
                    </Link>
                  ))}
                </section>
              )}
              {results.comments.length > 0 && (
                <section className="flex flex-col gap-1">
                  <Label>Comments</Label>
                  {results.comments.map((c) => (
                    <Link
                      key={c.id}
                      to="/files/$fileId"
                      params={{ fileId: c.fileId }}
                      search={{ comment: c.id }}
                      className="flex items-start gap-3 rounded-panel px-2 py-2 hover:bg-raised/60"
                    >
                      <Avatar personId={c.authorId} size={22} />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] text-ink">{c.body}</span>
                        <span className="block text-[12px] text-ink-3">
                          {personById(c.authorId).name} · {ago(c.createdAt)}
                        </span>
                      </span>
                    </Link>
                  ))}
                </section>
              )}
              {results.people.length > 0 && (
                <section className="flex flex-col gap-1">
                  <Label>People</Label>
                  {results.people.map((p) => (
                    <Link
                      key={p.id}
                      to="/members"
                      className="flex items-center gap-3 rounded-panel px-2 py-2 hover:bg-raised/60"
                    >
                      <Avatar personId={p.id} size={22} />
                      <span className="text-[14px] text-ink">{p.name}</span>
                    </Link>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
        <aside className="flex flex-col gap-2">
          <Label>Saved searches</Label>
          {saved.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setQuery(s.query);
                setAdvanced(true);
              }}
              className="flex flex-col rounded-panel px-2 py-1.5 text-left transition-colors hover:bg-raised/60"
            >
              <span className="text-[13px] text-ink">{s.name}</span>
              <span className="tabular truncate text-[12px] text-ink-3">{s.query}</span>
            </button>
          ))}
          <span className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-3">
            <Dot state="passed" />
            Searches cover only what you may see.
          </span>
        </aside>
      </div>
    </div>
  );
}
