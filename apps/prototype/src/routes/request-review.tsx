import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Card, Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { Chip, PermissionsDialog } from "~/components/permissions";
import { Button } from "~/components/ui/button";
import { Input, Textarea } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  type Folder,
  folders,
  groups,
  guests,
  latestVersion,
  personById,
  projectById,
  type ReviewKind,
  trackById,
} from "~/data";
import { cn } from "~/lib/cn";
import { kindIcon } from "~/lib/files";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";
import { type Item, itemsIn } from "./project-files.tsx";

const kinds: { id: ReviewKind; label: string; hint: string }[] = [
  {
    id: "approval",
    label: "Approval",
    hint: "Each reviewer records Approved or Changes requested. Logged, append-only.",
  },
  {
    id: "feedback",
    label: "Feedback",
    hint: "Comments, then Submit feedback. No formal sign-off.",
  },
];

function Section({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 @3xl/app:grid-cols-[200px_minmax(0,1fr)]">
      <div className="flex items-start gap-3">
        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-[12px] text-ink-2">
          {n}
        </span>
        <div>
          <h2 className="text-[15px] font-medium text-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-3">{hint}</p>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

/** The project's folders and tracks as a tree with boxes to tick; files inside a track are its versions. */
function ItemPicker({
  projectId,
  chosen,
  onToggle,
}: {
  projectId: string;
  chosen: Set<string>;
  onToggle: (id: string) => void;
}) {
  const project = projectById(projectId);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  if (!project) return null;
  const toggleFolder = (id: string) => {
    const n = new Set(openFolders);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpenFolders(n);
  };
  const row = (item: Item, depth: number): ReactNode => {
    if (item.kind === "version") return null;
    const name =
      item.kind === "folder"
        ? item.folder.name
        : item.kind === "track"
          ? item.track.name
          : item.file.name;
    if (query && !name.toLowerCase().includes(query.toLowerCase()) && item.kind !== "folder")
      return null;
    const pickable =
      item.kind === "track" ? Boolean(latestVersion(item.track)) : item.kind === "file";
    return (
      <li key={item.id}>
        <div
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-control pr-2 hover:bg-raised/50",
            chosen.has(item.id) && "bg-raised/40",
          )}
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          {item.kind === "folder" ? (
            <button
              type="button"
              aria-label={openFolders.has(item.id) ? "Collapse" : "Expand"}
              onClick={() => toggleFolder(item.id)}
              className="flex size-5 items-center justify-center text-ink-3 hover:text-ink"
            >
              <Icon
                name="chevronRight"
                size={12}
                className={cn("transition-transform", openFolders.has(item.id) && "rotate-90")}
              />
            </button>
          ) : (
            <input
              type="checkbox"
              checked={chosen.has(item.id)}
              disabled={!pickable}
              onChange={() => onToggle(item.id)}
              aria-label={name}
            />
          )}
          <Icon
            name={
              item.kind === "folder"
                ? "folder"
                : item.kind === "track"
                  ? "track"
                  : kindIcon[item.file.kind]
            }
            size={15}
            className="text-ink-3"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[14px]",
              pickable || item.kind === "folder" ? "text-ink" : "text-ink-3",
            )}
          >
            {name}
          </span>
          {item.kind === "track" && (
            <span className="text-[12px] text-ink-3">
              {latestVersion(item.track) ? `V${latestVersion(item.track)?.number}` : "no version"}
            </span>
          )}
        </div>
        {item.kind === "folder" && openFolders.has(item.id) && (
          <ul>{itemsIn(project, item.folder.id).map((child) => row(child, depth + 1))}</ul>
        )}
      </li>
    );
  };
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="search" size={14} className="text-ink-3" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a track or file"
          className="h-7 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-3 focus:outline-none"
        />
      </div>
      <ul className="scroll-quiet max-h-[320px] overflow-auto p-1.5">
        {itemsIn(project, null).map((item) => row(item, 0))}
      </ul>
    </Card>
  );
}

type Step = string[];

export function RequestReviewPage({
  projectId,
  kind: kindParam,
  item,
}: {
  projectId?: string;
  kind?: string;
  item?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const candidates = viewer.projects().filter((p) => viewer.can(p.id, "request_reviews"));
  const project = projectById(projectId ?? candidates[0]?.id ?? "");
  const [kind, setKind] = useState<ReviewKind>(kindParam === "feedback" ? "feedback" : "approval");
  const [chosen, setChosen] = useState<Set<string>>(new Set(item ? [item] : []));
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[]>([["p-mira", "p-tomas"]]);
  const [inTurn, setInTurn] = useState(false);
  const [rule, setRule] = useState<"all" | "any" | "quorum">("all");
  const [due, setDue] = useState("2026-10-30");
  const [remind, setRemind] = useState(true);
  const [override, setOverride] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  usePageHeader({
    crumbs: project
      ? [
          { label: project.name, to: `/projects/${project.id}` },
          { label: "Reviews", to: `/projects/${project.id}/reviews` },
        ]
      : [],
    title: "New review",
    heading: "page",
  });
  if (candidates.length === 0 || !project)
    return (
      <Refused
        title="Not for your role"
        text="Requesting reviews needs the permission in a project role. Ask a producer."
      />
    );

  const people = steps.flat();
  const has = (id: string) => people.includes(id);
  const toggleItem = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChosen(n);
  };
  const togglePerson = (id: string) => {
    if (has(id))
      setSteps(
        steps.map((s) => s.filter((p) => p !== id)).filter((s, i) => s.length > 0 || i === 0),
      );
    else setSteps(steps.map((s, i) => (i === steps.length - 1 ? [...s, id] : s)));
  };
  const moveTo = (id: string, to: number) =>
    setSteps(
      steps.map((s, i) =>
        i === to ? [...s.filter((p) => p !== id), id] : s.filter((p) => p !== id),
      ),
    );
  const projectGroups = groups.filter((g) => g.projectId === project.id);
  const groupOn = (g: (typeof groups)[number]) => g.personIds.every(has);
  const toggleGroup = (g: (typeof groups)[number]) => {
    if (groupOn(g)) setSteps(steps.map((s) => s.filter((p) => !g.personIds.includes(p))));
    else
      setSteps(
        steps.map((s, i) => (i === steps.length - 1 ? [...new Set([...s, ...g.personIds])] : s)),
      );
  };
  const memberIds = new Set(project.members.map((m) => m.personId));
  const reviewerGuests = guests.filter(
    (g) => !memberIds.has(g.personId) || g.personId === "p-mira",
  );
  const personChip = (id: string, stepIndex: number) => (
    <span
      key={id}
      className="flex h-8 items-center gap-2 rounded-chip border border-line bg-raised/40 pr-1 pl-1.5 text-[13px] text-ink"
    >
      <Avatar personId={id} size={20} />
      {personById(id).name}
      {inTurn && steps.length > 1 && (
        <Dropdown
          size="sm"
          value={<span className="text-[12px]">to step</span>}
          actions={steps.map((_, i) => ({
            label: `Step ${i + 1}`,
            checked: i === stepIndex,
            onSelect: () => moveTo(id, i),
          }))}
        />
      )}
      <button
        type="button"
        aria-label={`Remove ${personById(id).name}`}
        onClick={() => togglePerson(id)}
        className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
      >
        <Icon name="close" size={11} />
      </button>
    </span>
  );
  const chosenItems = [...chosen];
  return (
    <Page>
      <form
        className="grid gap-10 @5xl/app:grid-cols-[minmax(0,1fr)_280px]"
        onSubmit={(e) => {
          e.preventDefault();
          navigate({
            to: "/reviews/$reviewId",
            params: { reviewId: kind === "feedback" ? "rev-mixnotes" : "rev-masters" },
          });
        }}
      >
        <div className="flex min-w-0 flex-col gap-10">
          <Section n={1} title="Kind">
            <div role="radiogroup" className="grid gap-2 @3xl/app:grid-cols-2">
              {kinds.map((k) => (
                <label
                  key={k.id}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 rounded-panel border p-3.5 transition-colors",
                    kind === k.id
                      ? "border-signal/60 bg-signal/10"
                      : "border-line hover:border-edge",
                  )}
                >
                  <input
                    type="radio"
                    name="kind"
                    value={k.id}
                    checked={kind === k.id}
                    onChange={() => setKind(k.id)}
                    className="sr-only"
                  />
                  <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Icon name={k.id === "approval" ? "review" : "comment"} size={15} />
                    {k.label}
                  </span>
                  <span className="text-[13px] text-ink-3">{k.hint}</span>
                </label>
              ))}
            </div>
            <p className="text-[12px] text-ink-3">
              Only want someone to listen? That is a{" "}
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "reviews" }}
                className="text-ink-2 hover:text-ink"
              >
                share
              </Link>
              , not a review.
            </p>
          </Section>

          <Section
            n={2}
            title="What"
            hint="Tracks at their latest version or a chosen one, and files."
          >
            <ItemPicker projectId={project.id} chosen={chosen} onToggle={toggleItem} />
            {chosenItems.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {chosenItems.map((id) => {
                  const track = trackById(id);
                  const name =
                    track?.name ??
                    folders.find((f: Folder) => f.id === id)?.name ??
                    itemsIn(project, null).find((i) => i.id === id && i.kind === "file")?.id ??
                    id;
                  return (
                    <li
                      key={id}
                      className="flex h-8 items-center gap-2 rounded-chip border border-line bg-raised/40 pr-1 pl-2.5 text-[13px] text-ink"
                    >
                      <Icon name={track ? "track" : "file"} size={13} className="text-ink-3" />
                      {track ? track.name : name.replace(/^file-/, "")}
                      {track && (
                        <Dropdown
                          size="sm"
                          value={
                            <span className="text-[12px]">
                              {versions[id] ?? `Latest (V${latestVersion(track)?.number})`}
                            </span>
                          }
                          actions={[
                            {
                              label: `Latest (V${latestVersion(track)?.number})`,
                              checked: !versions[id],
                              onSelect: () => setVersions({ ...versions, [id]: "" }),
                            },
                            ...track.versions.map((v) => ({
                              label: `V${v.number}`,
                              checked: versions[id] === `V${v.number}`,
                              onSelect: () => setVersions({ ...versions, [id]: `V${v.number}` }),
                            })),
                          ]}
                        />
                      )}
                      <button
                        type="button"
                        aria-label="Remove"
                        onClick={() => toggleItem(id)}
                        className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="close" size={11} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          <Section
            n={3}
            title="Who"
            hint="Groups, members and reviewers. Their usual permissions apply unless you override them here."
          >
            {projectGroups.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>Groups</Label>
                <div className="flex flex-wrap gap-1.5">
                  {projectGroups.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      aria-pressed={groupOn(g)}
                      onClick={() => toggleGroup(g)}
                      className={cn(
                        "flex h-8 items-center gap-2 rounded-chip border px-2.5 text-[13px] transition-colors",
                        groupOn(g)
                          ? "border-edge bg-raised text-ink shadow-1"
                          : "border-line text-ink-2 hover:border-edge hover:text-ink",
                      )}
                    >
                      <Icon name="users" size={13} className="text-ink-3" />
                      {g.name}
                      <span className="text-ink-3">{g.personIds.length}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid gap-3 @3xl/app:grid-cols-2">
              <Card>
                <div className="flex h-9 items-center border-b border-line px-3">
                  <Label>Members</Label>
                </div>
                <ul>
                  {project.members.map((m) => {
                    const p = personById(m.personId);
                    const role = project.roles.find((r) => r.id === m.roleId);
                    const canDecide = role?.permissions.includes("decide");
                    return (
                      <li
                        key={m.personId}
                        className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={has(m.personId)}
                          onChange={() => togglePerson(m.personId)}
                          aria-label={p.name}
                        />
                        <Avatar personId={m.personId} size={24} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] text-ink">{p.name}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {role?.name}
                            {kind === "approval" && !canDecide && " · comments only"}
                          </span>
                        </span>
                        {has(m.personId) && (
                          <button
                            type="button"
                            onClick={() => setOverride(m.personId)}
                            className="text-[12px] text-ink-3 hover:text-ink"
                          >
                            Override
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Card>
              <Card>
                <div className="flex h-9 items-center gap-2 border-b border-line px-3">
                  <Label>Guests</Label>
                  <span className="text-[12px] text-ink-3">by link</span>
                  <button
                    type="button"
                    onClick={() => setInviting(!inviting)}
                    className="ml-auto flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
                  >
                    <Icon name="plus" size={11} /> Someone new
                  </button>
                </div>
                <ul>
                  {reviewerGuests.map((g) => {
                    const p = personById(g.personId);
                    return (
                      <li
                        key={g.personId}
                        className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
                      >
                        <input
                          type="checkbox"
                          checked={has(g.personId)}
                          onChange={() => togglePerson(g.personId)}
                          aria-label={p.name}
                        />
                        <Avatar personId={g.personId} size={24} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] text-ink">{p.name}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {g.label} · own comments and replies, score, loops
                          </span>
                        </span>
                        {has(g.personId) && (
                          <button
                            type="button"
                            onClick={() => setOverride(g.personId)}
                            className="text-[12px] text-ink-3 hover:text-ink"
                          >
                            Override
                          </button>
                        )}
                      </li>
                    );
                  })}
                  {inviting && (
                    <li className="rise-in flex flex-col gap-2 border-b border-line px-3 py-2.5 last:border-b-0">
                      <Input placeholder="Name" className="h-8" />
                      <Input placeholder="Email" type="email" className="h-8" />
                      <Input placeholder="Label, such as Composer (optional)" className="h-8" />
                      <span className="text-[12px] text-ink-3">
                        They get a link when you send. Their permissions start from the project's
                        defaults for reviewers.
                      </span>
                    </li>
                  )}
                </ul>
              </Card>
            </div>
          </Section>

          {kind !== "share" && (
            <Section
              n={4}
              title="Order"
              hint={
                inTurn
                  ? "Each step starts when the one before finishes. Everyone at a step is asked together."
                  : "Everyone is asked now."
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <div
                  role="radiogroup"
                  className="flex rounded-control border border-line bg-raised/40 p-0.5"
                >
                  {(
                    [
                      [false, "All at once"],
                      [true, "In turn"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={label}
                      type="button"
                      role="radio"
                      aria-checked={inTurn === v}
                      onClick={() => setInTurn(v)}
                      className={cn(
                        "h-7 rounded-[4px] px-3 text-[13px]",
                        inTurn === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {kind === "approval" && (
                  <div className="flex items-center gap-1.5 @3xl/app:ml-4">
                    <Label>Approved when</Label>
                    <Chip active={rule === "all"} onClick={() => setRule("all")}>
                      everyone approves
                    </Chip>
                    <Chip active={rule === "any"} onClick={() => setRule("any")}>
                      any one approves
                    </Chip>
                    <Chip active={rule === "quorum"} onClick={() => setRule("quorum")}>
                      a share
                    </Chip>
                    {rule === "quorum" && (
                      <span className="flex items-center gap-1 text-[13px] text-ink-3">
                        <Input
                          defaultValue="66"
                          className="h-7 w-14 text-center"
                          aria-label="Percent"
                        />
                        %
                      </span>
                    )}
                  </div>
                )}
              </div>
              {people.length === 0 ? (
                <p className="text-[13px] text-ink-3">Choose who above first.</p>
              ) : inTurn ? (
                <ol className="flex flex-col gap-2">
                  {steps.map((step, i) => (
                    <li key={String(i)} className="flex items-start gap-3">
                      <span className="tabular mt-1 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-[12px] font-medium text-ink">
                        {i + 1}
                      </span>
                      <div className="flex min-h-10 min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-panel border border-dashed border-line-strong p-1.5">
                        {step.map((id) => personChip(id, i))}
                        {step.length === 0 && (
                          <span className="px-2 text-[12px] text-ink-3">Move people here</span>
                        )}
                      </div>
                    </li>
                  ))}
                  <li className="flex items-center gap-3 pl-10">
                    <Button variant="ghost" size="sm" onClick={() => setSteps([...steps, []])}>
                      <Icon name="plus" size={12} />
                      Add a step
                    </Button>
                    {steps.length > 1 && (
                      <Button variant="ghost" size="sm" onClick={() => setSteps([steps.flat()])}>
                        Merge into one
                      </Button>
                    )}
                  </li>
                </ol>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {people.map((id) => personChip(id, 0))}
                </div>
              )}
            </Section>
          )}

          <Section n={5} title="When and why">
            <div className="flex flex-wrap items-center gap-2">
              <Label>Due</Label>
              <Input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className="h-8 w-40"
              />
              {(
                [
                  ["2026-10-17", "In 3 days"],
                  ["2026-10-21", "A week"],
                  ["2026-10-28", "Two weeks"],
                ] as const
              ).map(([d, label]) => (
                <Chip key={d} active={due === d} onClick={() => setDue(d)}>
                  {label}
                </Chip>
              ))}
              <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
                Remind the day before
                <Switch label="Remind the day before" checked={remind} onChange={setRemind} />
              </label>
            </div>
            <Textarea
              rows={3}
              placeholder="What to listen for, and anything they need to know. Goes out with the invitation."
            />
          </Section>
        </div>

        <aside className="flex flex-col gap-4 @5xl/app:sticky @5xl/app:top-6 @5xl/app:self-start">
          <Card className="flex flex-col gap-3 p-4">
            <Label>Summary</Label>
            <dl className="flex flex-col gap-2 text-[13px]">
              {(
                [
                  ["Kind", kinds.find((k) => k.id === kind)?.label ?? ""],
                  ["Items", chosen.size ? `${chosen.size} chosen` : "none yet"],
                  [
                    "People",
                    people.length
                      ? `${people.length}${inTurn ? `, in ${steps.filter((s) => s.length).length} steps` : ", all at once"}`
                      : "none yet",
                  ],
                  ...(kind === "approval"
                    ? [
                        [
                          "Rule",
                          rule === "all"
                            ? "everyone approves"
                            : rule === "any"
                              ? "any one approves"
                              : "a share approves",
                        ],
                      ]
                    : []),
                  [
                    "Due",
                    due
                      ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(
                          new Date(`${due}T12:00:00Z`),
                        )
                      : "no date",
                  ],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="flex gap-3">
                  <dt className="w-16 shrink-0 text-ink-3">{k}</dt>
                  <dd className="text-ink">{v}</dd>
                </div>
              ))}
            </dl>
            <Button
              variant="primary"
              size="lg"
              type="submit"
              disabled={chosen.size === 0 || people.length === 0}
              className="mt-1 w-full"
            >
              <Icon name="send" size={14} />
              Send the review
            </Button>
            <Button variant="ghost" size="md" className="w-full" asChild>
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "reviews" }}
              >
                Cancel
              </Link>
            </Button>
            <p className="text-[12px] text-ink-3">
              Invitations go by email when you send. Guests get a link that is theirs alone.
            </p>
          </Card>
        </aside>
      </form>
      {override && (
        <PermissionsDialog
          personId={override}
          guest={!memberIds.has(override)}
          reviewTitle="this review"
          onClose={() => setOverride(null)}
        />
      )}
    </Page>
  );
}
