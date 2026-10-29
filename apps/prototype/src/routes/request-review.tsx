import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Card, Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { Chip, PermissionsDialog } from "~/components/permissions";
import { PeopleField, type Person } from "~/components/share";
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
  type Project,
  personById,
  projectById,
  type Review,
  type ReviewKind,
  reviewById,
  trackById,
} from "~/data";
import { cn } from "~/lib/cn";
import { kindIcon } from "~/lib/files";
import { stepTitle } from "~/lib/reviews";
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

/** The key under which "Everything in this workspace" is chosen, beside item ids. */
export const WORKSPACE = "workspace";

/** Everything beneath a folder, by id: its folders, tracks and files, however deep. */
function beneath(project: Project, folderId: string): string[] {
  return itemsIn(project, folderId).flatMap((item) =>
    item.kind === "folder"
      ? [item.id, ...beneath(project, item.id)]
      : item.kind === "version"
        ? []
        : [item.id],
  );
}

/**
 * The project's folders, tracks and loose files as a tree with boxes to tick. A folder ticked
 * covers everything beneath it, files added later included; one with only some of its
 * contents ticked shows a dash. "Everything in this workspace" is offered to whoever may ask
 * it of every project (#501).
 */
function ItemPicker({
  projectId,
  chosen,
  onToggle,
  workspace,
}: {
  projectId: string;
  chosen: Set<string>;
  onToggle: (id: string) => void;
  /** Whether the whole workspace may be chosen: Reviews: Manage on every project, or an admin. */
  workspace: boolean;
}) {
  const project = projectById(projectId);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  if (!project) return null;
  const all = chosen.has(WORKSPACE);
  const toggleFolder = (id: string) => {
    const n = new Set(openFolders);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpenFolders(n);
  };
  const row = (item: Item, depth: number, covered: boolean): ReactNode => {
    if (item.kind === "version") return null;
    const name =
      item.kind === "folder"
        ? item.folder.name
        : item.kind === "track"
          ? item.track.name
          : item.file.name;
    if (query && !name.toLowerCase().includes(query.toLowerCase()) && item.kind !== "folder")
      return null;
    const folder = item.kind === "folder";
    const under = folder ? beneath(project, item.id) : [];
    const ticked = covered || chosen.has(item.id);
    const within = under.filter((id) => chosen.has(id)).length;
    const partly = folder && !ticked && within > 0;
    const pickable = folder || (item.kind === "track" ? Boolean(latestVersion(item.track)) : true);
    return (
      <li key={item.id}>
        <div
          className={cn(
            "flex h-9 items-center gap-2.5 rounded-control pr-2 hover:bg-raised/50",
            ticked && !covered && "bg-raised/40",
          )}
          style={{ paddingLeft: 8 + depth * 20 }}
        >
          {folder ? (
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
            <span className="size-5 shrink-0" />
          )}
          <input
            type="checkbox"
            ref={(el) => {
              if (el) el.indeterminate = partly;
            }}
            checked={ticked}
            disabled={covered || !pickable}
            onChange={() => onToggle(item.id)}
            aria-label={name}
          />
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
              pickable ? "text-ink" : "text-ink-3",
            )}
          >
            {name}
          </span>
          {folder && (ticked || partly) && (
            <span className="text-[12px] text-ink-3">
              {ticked ? "everything in it" : `${within} of ${under.length}`}
            </span>
          )}
          {item.kind === "track" && (
            <span className="text-[12px] text-ink-3">
              {latestVersion(item.track) ? `V${latestVersion(item.track)?.number}` : "no version"}
            </span>
          )}
        </div>
        {item.kind === "folder" && openFolders.has(item.id) && (
          <ul>{itemsIn(project, item.folder.id).map((child) => row(child, depth + 1, ticked))}</ul>
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
      {workspace && (
        <label
          className={cn(
            "flex h-10 cursor-pointer items-center gap-2.5 border-b border-line px-3",
            all && "bg-raised/40",
          )}
        >
          <input
            type="checkbox"
            checked={all}
            onChange={() => onToggle(WORKSPACE)}
            aria-label="Everything in this workspace"
          />
          <Icon name="globe" size={15} className="text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
            Everything in this workspace
          </span>
          <span className="text-[12px] text-ink-3">every project, now and later</span>
        </label>
      )}
      <ul className="scroll-quiet max-h-[320px] overflow-auto p-1.5">
        {itemsIn(project, null).map((item) => row(item, 0, all))}
      </ul>
    </Card>
  );
}

/** One step of the order: who is asked together, and what the step is called. */
interface Step {
  name: string;
  /** Person ids ("p-…"), group ids ("g-…") and new guests by address ("guest:…"). */
  people: string[];
}

const isGroup = (id: string) => id.startsWith("g-");
const isNewGuest = (id: string) => id.startsWith("guest:");

/** The steps a review was sent in, to send it again: a group once per step, its people under it. */
function stepsOf(review: Review): Step[] {
  const positions = [...new Set(review.reviewers.map((r) => r.position))].sort((a, b) => a - b);
  return positions.map((pos, i) => {
    const rows = review.reviewers.filter((r) => r.position === pos);
    const people: string[] = [];
    for (const r of rows) {
      const id = r.groupId ?? r.personId;
      if (!people.includes(id)) people.push(id);
    }
    return { name: review.stepNames?.[i] ?? "", people };
  });
}

export function RequestReviewPage({
  projectId,
  kind: kindParam,
  item,
  from,
}: {
  projectId?: string;
  kind?: string;
  item?: string;
  /** A review to duplicate (#502): everything filled in from it, nothing sent until Send. */
  from?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const candidates = viewer.projects().filter((p) => viewer.can(p.id, "request_reviews"));
  const original = from ? reviewById(from) : undefined;
  const project = projectById(original?.projectId ?? projectId ?? candidates[0]?.id ?? "");
  const [kind, setKind] = useState<ReviewKind>(
    original ? original.kind : kindParam === "feedback" ? "feedback" : "approval",
  );
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(original ? original.items.map((i) => i.trackId ?? i.fileId ?? "") : item ? [item] : []),
  );
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [steps, setSteps] = useState<Step[]>(() =>
    original
      ? original.order === "sequence"
        ? stepsOf(original)
        : [{ name: "", people: stepsOf(original).flatMap((s) => s.people) }]
      : [{ name: "", people: ["p-mira", "p-tomas"] }],
  );
  const [inTurn, setInTurn] = useState(original?.order === "sequence");
  const [rule, setRule] = useState<"all" | "any" | "quorum">(
    original?.rule === "any" ? "any" : original?.rule === "quorum" ? "quorum" : "all",
  );
  const [due, setDue] = useState(original?.dueAt?.slice(0, 10) ?? "2026-10-30");
  const [remind, setRemind] = useState(true);
  const [message, setMessage] = useState(original?.message ?? "");
  const [override, setOverride] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
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

  const people = steps.flatMap((s) => s.people);
  const has = (id: string) => people.includes(id);
  // Whoever may manage reviews in every project, or runs the workspace, may ask about all of it.
  const wholeWorkspace = viewer.projects().every((p) => viewer.can(p.id, "manage_reviewers"));
  const toggleItem = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) {
      n.delete(id);
    } else {
      // The workspace covers everything, and a folder everything beneath it: what was ticked
      // there is ticked no more.
      if (id === WORKSPACE) n.clear();
      else {
        n.delete(WORKSPACE);
        for (const under of beneath(project, id)) n.delete(under);
      }
      n.add(id);
    }
    setChosen(n);
  };
  const addTo = (stepIndex: number, id: string) => {
    if (has(id)) return;
    setSteps(steps.map((s, i) => (i === stepIndex ? { ...s, people: [...s.people, id] } : s)));
  };
  const remove = (id: string) =>
    setSteps(steps.map((s) => ({ ...s, people: s.people.filter((p) => p !== id) })));
  const moveTo = (id: string, to: number) =>
    setSteps(
      steps.map((s, i) => ({
        ...s,
        people:
          i === to ? [...s.people.filter((p) => p !== id), id] : s.people.filter((p) => p !== id),
      })),
    );
  const rename = (stepIndex: number, name: string) =>
    setSteps(steps.map((s, i) => (i === stepIndex ? { ...s, name } : s)));
  const removeStep = (stepIndex: number) =>
    setSteps(
      steps.length === 1
        ? [{ name: "", people: [] }]
        : steps
            .filter((_, i) => i !== stepIndex)
            .map((s, i) =>
              // Whoever was in it joins the step before, or the first.
              i === Math.max(0, stepIndex - 1)
                ? { ...s, people: [...s.people, ...(steps[stepIndex]?.people ?? [])] }
                : s,
            ),
    );
  const projectGroups = groups.filter((g) => g.projectId === project.id);
  const memberIds = new Set(project.members.map((m) => m.personId));
  const reviewerGuests = guests.filter(
    (g) => !memberIds.has(g.personId) || g.personId === "p-mira",
  );
  // Everyone who can be asked, as the field offers them.
  const offered: Person[] = [
    ...project.members.map((m): Person => {
      const role = project.roles.find((r) => r.id === m.roleId);
      return {
        key: m.personId,
        personId: m.personId,
        name: personById(m.personId).name,
        hint: role?.name,
        kind: "member",
      };
    }),
    ...projectGroups.map(
      (g): Person => ({
        key: g.id,
        name: g.name,
        hint: `${g.personIds.length} people`,
        kind: "group",
      }),
    ),
    ...reviewerGuests.map(
      (g): Person => ({
        key: g.personId,
        personId: g.personId,
        name: personById(g.personId).name,
        hint: g.label,
        kind: "guest",
      }),
    ),
  ];
  const labelOf = (id: string): { name: string; hint: string } => {
    if (isGroup(id)) {
      const g = projectGroups.find((x) => x.id === id);
      return { name: g?.name ?? "A group", hint: `${g?.personIds.length ?? 0} people` };
    }
    if (isNewGuest(id)) return { name: id.slice("guest:".length), hint: "New guest · by link" };
    const member = project.members.find((m) => m.personId === id);
    const role = project.roles.find((r) => r.id === member?.roleId);
    const canDecide = role?.permissions.includes("decide");
    const guest = reviewerGuests.find((g) => g.personId === id);
    const hint = member
      ? `${role?.name ?? ""}${kind === "approval" && !canDecide ? " · comments only" : ""}`
      : `${guest?.label ?? "Guest"} · by link`;
    return { name: personById(id).name, hint };
  };

  const personRow = (id: string, stepIndex: number) => {
    const { name, hint } = labelOf(id);
    return (
      <li
        key={id}
        draggable={inTurn && steps.length > 1}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(id);
        }}
        onDragEnd={() => setDragging(null)}
        className={cn(
          "flex min-h-11 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0",
          dragging === id && "opacity-40",
        )}
      >
        {inTurn && steps.length > 1 && (
          <Icon name="grip" size={14} className="shrink-0 cursor-grab text-ink-3" />
        )}
        {isGroup(id) ? (
          <span className="flex size-6 items-center justify-center text-ink-3">
            <Icon name="users" size={15} />
          </span>
        ) : isNewGuest(id) ? (
          <span className="flex size-6 items-center justify-center text-ink-3">
            <Icon name="mail" size={14} />
          </span>
        ) : (
          <Avatar personId={id} size={24} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] text-ink">{name}</span>
          <span className="block truncate text-[12px] text-ink-3">{hint}</span>
        </span>
        {inTurn && steps.length > 1 && (
          <Dropdown
            size="sm"
            value={
              <span className="text-[12px]">
                {stepTitle(steps[stepIndex]?.name, stepIndex + 1)}
              </span>
            }
            actions={steps.map((s, i) => ({
              label: stepTitle(s.name, i + 1),
              checked: i === stepIndex,
              onSelect: () => moveTo(id, i),
            }))}
          />
        )}
        {!isGroup(id) && (
          <button
            type="button"
            onClick={() => setOverride(id)}
            className="text-[12px] text-ink-3 hover:text-ink"
          >
            Override
          </button>
        )}
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={() => remove(id)}
          className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={12} />
        </button>
      </li>
    );
  };

  const stepCard = (step: Step, i: number) => (
    <li key={String(i)} className="flex items-start gap-3">
      {inTurn && (
        <span className="tabular mt-2 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-[12px] font-medium text-ink">
          {i + 1}
        </span>
      )}
      <Card
        className={cn(
          "min-w-0 flex-1 transition-colors",
          dragging && !step.people.includes(dragging) && "border-dashed border-edge",
        )}
      >
        <div
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const id = e.dataTransfer.getData("text/plain") || dragging;
            if (id) moveTo(id, i);
            setDragging(null);
          }}
        >
          {inTurn && (
            <div className="flex h-11 items-center gap-2 border-b border-line px-3">
              <Input
                value={step.name}
                onChange={(e) => rename(i, e.target.value)}
                placeholder={`Name this step (optional), such as ${["Producer", "Stakeholders", "Label"][i % 3]}`}
                aria-label={`Name of step ${i + 1}`}
                className="h-7 flex-1 border-transparent bg-transparent px-1 shadow-none hover:border-edge"
              />
              <button
                type="button"
                aria-label={`Remove step ${i + 1}`}
                onClick={() => removeStep(i)}
                className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
          <ul className="list-none p-0">{step.people.map((id) => personRow(id, i))}</ul>
          <div className={cn("p-2", step.people.length > 0 && "border-t border-line")}>
            <PeopleField
              label={inTurn ? `Add to ${stepTitle(step.name, i + 1)}` : "Add reviewers"}
              people={offered.filter((p) => !has(p.key))}
              chosen={[]}
              onChange={(next) => {
                const picked = next[0];
                if (picked) addTo(i, picked.key);
              }}
              placeholder={
                step.people.length === 0
                  ? "Members, groups, or an email address for a new guest"
                  : "Add someone"
              }
            />
          </div>
        </div>
      </Card>
    </li>
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
          {original && (
            <p className="flex items-center gap-2 rounded-panel border border-line bg-raised/40 px-3 py-2 text-[13px] text-ink-2">
              <Icon name="copy" size={14} className="text-ink-3" />
              Filled in from {original.title}. Nothing is sent until you press Send.
            </p>
          )}
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
            hint="Tracks at their latest version or a chosen one, files, or whole folders."
          >
            <ItemPicker
              projectId={project.id}
              chosen={chosen}
              onToggle={toggleItem}
              workspace={wholeWorkspace}
            />
            {chosenItems.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {chosenItems.map((id) => {
                  const track = trackById(id);
                  const folder = folders.find((f: Folder) => f.id === id);
                  const name =
                    id === WORKSPACE
                      ? "Everything in this workspace"
                      : (track?.name ??
                        folder?.name ??
                        itemsIn(project, null).find((i) => i.id === id && i.kind === "file")?.id ??
                        id);
                  return (
                    <li
                      key={id}
                      className="flex h-8 items-center gap-2 rounded-chip border border-line bg-raised/40 pr-1 pl-2.5 text-[13px] text-ink"
                    >
                      <Icon
                        name={
                          id === WORKSPACE ? "globe" : track ? "track" : folder ? "folder" : "file"
                        }
                        size={13}
                        className="text-ink-3"
                      />
                      {track ? track.name : name.replace(/^file-/, "")}
                      {folder && <span className="text-ink-3">everything in it</span>}
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
            {chosen.has(WORKSPACE) ? (
              <p className="text-[12px] text-ink-3">
                Covers every project you may share, now and those made later. The invitation says
                so.
              </p>
            ) : chosenItems.some((id) => folders.some((f: Folder) => f.id === id)) ? (
              <p className="text-[12px] text-ink-3">
                A folder covers everything in it, files added later included.
              </p>
            ) : null}
          </Section>

          <Section
            n={3}
            title="Reviewers"
            hint="Members, groups and guests. An address no one here answers to invites a new guest, by link. Their usual permissions apply unless you override them here."
          >
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex items-center gap-2">
                  <Label>Order</Label>
                  <div
                    role="radiogroup"
                    aria-label="Order"
                    className="flex rounded-control border border-line bg-raised/40 p-0.5"
                  >
                    {(
                      [
                        [false, "All at once"],
                        [true, "In steps"],
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
                          inTurn === v
                            ? "bg-overlay text-ink shadow-2"
                            : "text-ink-3 hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                {kind === "approval" && (
                  <div className="flex items-center gap-1.5">
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
              <p className="text-[13px] text-ink-3">
                {inTurn
                  ? "Each step starts when the one before finishes; everyone in a step is asked together. Drag someone to another step, or choose it from theirs."
                  : "Everyone is asked now."}
              </p>
            </div>
            <ol className="flex flex-col gap-2">
              {(inTurn ? steps : [{ name: "", people }]).map((step, i) => stepCard(step, i))}
              {inTurn && (
                <li className="pl-10">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSteps([...steps, { name: "", people: [] }])}
                  >
                    <Icon name="plus" size={12} />
                    Add a step
                  </Button>
                </li>
              )}
            </ol>
          </Section>

          <Section n={4} title="When and why">
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
              value={message}
              onChange={(e) => setMessage(e.target.value)}
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
                  [
                    "Items",
                    chosen.has(WORKSPACE)
                      ? "everything"
                      : chosen.size
                        ? `${chosen.size} chosen`
                        : "none yet",
                  ],
                  [
                    "People",
                    people.length
                      ? `${people.length}${inTurn ? `, in ${steps.filter((s) => s.people.length).length} steps` : ", all at once"}`
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
