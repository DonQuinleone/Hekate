import {
  type ApprovalRule,
  applyPermissions,
  type CreateReviewInput,
  capital,
  type DownloadLevel,
  type GuestInput,
  type ReviewerInput,
  type ReviewerPermissionsChange,
  type ReviewKind,
  type ReviewStepInput,
  reviewerDefaults,
  stepTitle,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DragEvent, type FormEvent, type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { type Chosen, ItemPicker, latestOf } from "~/components/item-picker";
import { Card, Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { PeoplePicker, type Person } from "~/components/people-picker";
import { ReviewerPermissionsEditor } from "~/components/reviewer-permissions";
import { Button } from "~/components/ui/button";
import { ToggleChip } from "~/components/ui/chip";
import { ChoiceCard } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { InlineInput, Input, Textarea } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Switch } from "~/components/ui/toggle";
import { itemsIn } from "~/lib/browser";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import {
  type ProjectGroup,
  projectFilesQuery,
  projectFoldersQuery,
  projectGroupsQuery,
  projectGuestsQuery,
  projectMembersQuery,
  projectQuery,
  projectRolesQuery,
  projectTracksQuery,
  type ReviewDetail,
  reviewQuery,
  reviewScopeQuery,
  useCreateReview,
  useItemWords,
  useProjectCan,
  workspaceSettingsQuery,
} from "~/lib/queries";
import {
  addToStep,
  dropFromSteps,
  dueDateOf,
  emptyStep,
  type FormStep,
  itemsFromReview,
  moveToStep,
  removeStep,
  renameStep,
  stepIndexOf,
  stepsFromReview,
} from "~/lib/review-form";
import { toggleScope, WORKSPACE_KEY } from "~/lib/review-scope";
import { guestFromEmail } from "~/lib/shares";

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

const ruleWords: Record<ApprovalRule, string> = {
  all: "everyone approves",
  any: "any one approves",
  share: "a share approves",
};

const dueFormat = formatDates({ day: "numeric", month: "long" });

/** A date some days from today, as a date field holds it. */
const daysFromNow = (days: number) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** What a step might be called, offered as the field's placeholder, one per step. */
const stepNameExamples = ["Producer", "Stakeholders", "Label"];

/** A numbered part of the form: its title and hint at the left, its controls beside them. */
function Section({
  n,
  title,
  hint,
  children,
}: {
  n: number;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`request-${n}`}
      className="grid gap-4 @3xl/app:grid-cols-[200px_minmax(0,1fr)]"
    >
      <div className="flex items-start gap-3">
        <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-[12px] text-ink-2">
          {n}
        </span>
        <div>
          <h2 id={`request-${n}`} className="text-[15px] font-medium text-ink">
            {title}
          </h2>
          {hint && <p className="mt-0.5 text-[13px] text-ink-3">{hint}</p>}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}

/** A reviewer in the request, by key: `member:<user id>`, `guest:<email>` or `group:<id>`. */
type Key = string;

/**
 * The server matches an override to a reviewer by member or guest, so one given for a group
 * reaches its members here, each unless they have one of their own.
 */
export function expandGroupOverrides(
  overrides: Record<Key, ReviewerPermissionsChange>,
  groups: ProjectGroup[],
): Record<string, ReviewerPermissionsChange> {
  const out: Record<string, ReviewerPermissionsChange> = {};
  for (const [key, change] of Object.entries(overrides)) {
    if (!key.startsWith("group:")) {
      out[key] = change;
      continue;
    }
    const group = groups.find((g) => g.id === key.slice("group:".length));
    for (const member of group?.members ?? []) {
      const own = member.userId ? `member:${member.userId}` : `guest:${member.email}`;
      if (!(own in overrides) && !(own in out)) out[own] = change;
    }
  }
  return out;
}

/** What the form opens with: from the address it was opened at, or from a review (#502). */
interface Initial {
  kind: ReviewKind;
  chosen: Chosen;
  steps: FormStep[];
  inTurn: boolean;
  rule: ApprovalRule;
  share: string;
  due: string;
  remind: boolean;
  message: string;
  overrides: Record<Key, ReviewerPermissionsChange>;
  added: Map<Key, GuestInput>;
}

/** The form filled in from a review, to send the same again: nothing is sent until Send. */
function initialFromReview(review: ReviewDetail): Initial {
  return {
    kind: review.kind === "share" ? "feedback" : review.kind,
    chosen: itemsFromReview(review),
    steps: stepsFromReview(review),
    inTurn: review.order === "sequence",
    rule: review.rule ?? "all",
    share: String(review.share ?? 66),
    due: dueDateOf(review.dueAt),
    remind: review.remind,
    message: review.message ?? "",
    overrides: {},
    added: new Map(),
  };
}

/**
 * Asking for a review, inside the project (#130): what, who in what order, by when. The
 * form is the prototype's request page; it sends to the reviews API, which checks it all.
 * Opened from a review's Duplicate (#502), it starts with that review's choices.
 */
export function RequestReviewPage({
  projectId,
  kind: kindParam,
  item,
  items: itemsParam,
  version,
  people: peopleParam,
  download,
  until,
  from,
}: {
  projectId: string;
  kind?: ReviewKind;
  item?: string;
  /** From a share sheet's "More options" (#489): its items, one version, its people, and what they may download and until when. */
  items?: string[];
  version?: string;
  people?: string[];
  download?: DownloadLevel;
  /** An ISO date, or "never" for a link that works until it is withdrawn. */
  until?: string;
  /** A review to duplicate (#502): everything filled in from it. */
  from?: string;
}) {
  const { data: project, error } = useQuery(projectQuery(projectId));
  const can = useProjectCan(projectId);
  const mayRequest = can("request_reviews");
  const { data: original, error: originalError } = useQuery({
    ...reviewQuery(from ?? ""),
    enabled: Boolean(from) && mayRequest,
  });

  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!project) return <p className="p-8 text-ink-3">Loading</p>;
  const crumbs = [
    { key: "projects", link: <Link to="/projects">Projects</Link> },
    {
      key: "project",
      link: (
        <Link to="/projects/$projectId" params={{ projectId }}>
          {project.name}
        </Link>
      ),
    },
    {
      key: "reviews",
      link: (
        <Link to="/projects/$projectId/reviews" params={{ projectId }}>
          Reviews
        </Link>
      ),
    },
  ];
  if (!mayRequest || project.archivedAt) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="New review" />
        <Page width="narrow">
          <Empty
            title={project.archivedAt ? "This project is archived" : "Not for your role"}
            text={
              project.archivedAt
                ? "An archived project is read-only. Unarchive it to ask for reviews again."
                : "Asking for reviews needs the permission in a project role. Ask whoever runs the project."
            }
          />
        </Page>
      </>
    );
  }
  if (from && !original && !originalError) {
    return (
      <>
        <PageHeader crumbs={crumbs} title="New review" />
        <p className="p-8 text-ink-3">Loading</p>
      </>
    );
  }
  // A review of another project cannot be duplicated here: the form starts empty instead.
  const duplicated = original && original.projectId === projectId ? original : null;
  const initial: Initial = duplicated
    ? initialFromReview(duplicated)
    : {
        kind: kindParam ?? "approval",
        chosen: new Map(
          [...(item ? [item] : []), ...(itemsParam ?? [])].map((key) => [
            key,
            // A version named is of the one track asked about (#489).
            { versionId: version && key.startsWith("track:") ? version : null },
          ]),
        ),
        steps: [{ name: "", people: peopleParam ?? [] }],
        inTurn: false,
        rule: "all",
        share: "66",
        due: "",
        remind: true,
        message: "",
        // What a share sheet chose for everyone it named (#489) comes in as their overrides,
        // since the page sets what people may do one person at a time.
        overrides:
          download || until
            ? Object.fromEntries(
                (peopleParam ?? []).map((key) => [
                  key,
                  {
                    ...(download ? { download } : {}),
                    // "never" is a link that works until it is withdrawn: an expiry of null, chosen.
                    ...(until ? { expiresAt: until === "never" ? null : until } : {}),
                  },
                ]),
              )
            : {},
        // One a share sheet named by address alone (#489) is named from it, until the People
        // page renames them.
        added: new Map(
          (peopleParam ?? [])
            .filter((key) => key.startsWith("guest:"))
            .map((key) => [key, guestFromEmail(key.slice("guest:".length))]),
        ),
      };
  return (
    <>
      <PageHeader crumbs={crumbs} title="New review" />
      <ReviewForm
        key={duplicated?.id ?? "new"}
        projectId={projectId}
        initial={initial}
        fromTitle={duplicated?.title ?? null}
      />
    </>
  );
}

function ReviewForm({
  projectId,
  initial,
  fromTitle,
}: {
  projectId: string;
  initial: Initial;
  /** The review this one is filled in from (#502), named above the form. */
  fromTitle: string | null;
}) {
  const navigate = useNavigate();
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: files = [] } = useQuery(projectFilesQuery(projectId));
  const { data: folders = [] } = useQuery(projectFoldersQuery(projectId));
  const { data: members = [] } = useQuery(projectMembersQuery(projectId));
  const { data: roles = [] } = useQuery(projectRolesQuery(projectId));
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const { data: known = [] } = useQuery(projectGuestsQuery(projectId));
  const { words, versionLabel } = useItemWords(projectId);
  const create = useCreateReview(projectId);
  // Whether everything in the workspace may be asked about (#501): offered only then.
  const { data: scope = null } = useQuery({ ...reviewScopeQuery, enabled: mayRequest });

  const [kind, setKind] = useState<ReviewKind>(initial.kind);
  const [chosen, setChosen] = useState<Chosen>(initial.chosen);
  // The order, step by step (#500): everyone in a step is asked together. The steps stand
  // whether or not they are in turn, so switching back finds them as they were.
  const [steps, setSteps] = useState<FormStep[]>(initial.steps);
  const [inTurn, setInTurn] = useState(initial.inTurn);
  const [rule, setRule] = useState<ApprovalRule>(initial.rule);
  const [share, setShare] = useState(initial.share);
  const [due, setDue] = useState(initial.due);
  const [remind, setRemind] = useState(initial.remind);
  const [message, setMessage] = useState(initial.message);
  const [overrides, setOverrides] = useState(initial.overrides);
  const [overriding, setOverriding] = useState<Key | null>(null);
  // Guests typed in here, by key: an address no one answers to, named from it.
  const [added, setAdded] = useState<Map<Key, GuestInput>>(initial.added);
  // The person being dragged to another step, by key.
  const [dragging, setDragging] = useState<Key | null>(null);

  const deciders = new Set(roles.filter((r) => r.permissions.includes("decide")).map((r) => r.id));
  const memberById = new Map(members.map((m) => [m.userId, m]));
  // A guest the project knows keeps their name over one made from their address.
  const guestsByKey = new Map<Key, GuestInput>([
    ...added,
    ...known.map((g): [Key, GuestInput] => [
      `guest:${g.email}`,
      { name: g.name, email: g.email, label: g.label ?? undefined },
    ]),
  ]);
  const people = steps.flatMap((s) => s.people);
  const has = (key: Key) => people.includes(key);
  // Why someone cannot be asked, if they cannot: the server refuses the same.
  const memberRefusal = (userId: string) => {
    const m = memberById.get(userId);
    if (!m) return "Cannot see this project";
    return kind === "approval" && !deciders.has(m.roleId) ? "Their role cannot decide" : null;
  };
  const groupRefusal = (group: ProjectGroup) => {
    if (group.members.length === 0) return "No one in it";
    const out = group.members.find((m) => !m.guest && m.userId && memberRefusal(m.userId));
    if (!out?.userId) return null;
    return memberRefusal(out.userId) === "Cannot see this project"
      ? `${out.name} cannot see this project`
      : `${out.name} cannot decide`;
  };
  const refusalOf = (key: Key): string | null => {
    const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
    if (type === "member") return memberRefusal(id);
    if (type === "group") {
      const group = groups.find((g) => g.id === id);
      return group ? groupRefusal(group) : "No longer a group here";
    }
    return guestsByKey.has(key) ? null : "Unknown";
  };
  // A choice made under another kind may no longer hold: only who can be asked is sent.
  const askable = (key: Key) => refusalOf(key) === null;

  // Everyone the field offers (#489): members, groups and the guests the project knows.
  const offered: Person[] = [
    ...members.map((m): Person => {
      const why = memberRefusal(m.userId);
      const role = roles.find((r) => r.id === m.roleId)?.name ?? "";
      return {
        key: `member:${m.userId}`,
        name: m.name,
        hint: why ? `${role} · ${why.toLowerCase()}` : role,
        kind: "member",
      };
    }),
    ...groups.map((g): Person => {
      const why = groupRefusal(g);
      const count = `${g.members.length} ${g.members.length === 1 ? "person" : "people"}`;
      return {
        key: `group:${g.id}`,
        name: g.name,
        hint: why ? `${count} · ${why.toLowerCase()}` : count,
        kind: "group",
      };
    }),
    ...[...guestsByKey].map(
      ([key, g]): Person => ({ key, name: g.name, hint: g.label ?? g.email, kind: "guest" }),
    ),
  ];

  const add = (stepIndex: number, person: Person) => {
    if (person.kind === "guest" && !guestsByKey.has(person.key)) {
      setAdded(new Map(added).set(person.key, guestFromEmail(person.key.slice("guest:".length))));
    }
    setSteps(addToStep(steps, stepIndex, person.key));
  };
  const remove = (key: Key) => setSteps(dropFromSteps(steps, key));
  // A folder taken covers what is beneath it, and the workspace everything (#501).
  const toggleItem = (key: string) =>
    setChosen(
      toggleScope(chosen, key, { versionId: null }, (folderId) =>
        itemsIn(folders, tracks, files, folderId),
      ),
    );

  const labelOf = (key: Key): { name: string; hint: string; avatar: string } => {
    const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
    if (type === "member") {
      const m = memberById.get(id);
      const role = roles.find((r) => r.id === m?.roleId)?.name ?? "";
      return { name: m?.name ?? "Someone", hint: role, avatar: id };
    }
    if (type === "group") {
      const g = groups.find((x) => x.id === id);
      const n = g?.members.length ?? 0;
      return {
        name: g?.name ?? "A group",
        hint: `${n} ${n === 1 ? "person" : "people"}`,
        avatar: id,
      };
    }
    const g = guestsByKey.get(key);
    const fresh = added.has(key) && !known.some((k) => `guest:${k.email}` === key);
    return {
      name: g?.name ?? id,
      hint: `${g?.label ?? (fresh ? "New guest" : "Guest")} · ${id}`,
      avatar: id,
    };
  };

  const items = [...chosen.keys()];
  const wholeWorkspace = chosen.has(WORKSPACE_KEY);
  const sent = people.filter(askable);
  const shareValue = Number(share);
  const shareOk = Number.isInteger(shareValue) && shareValue >= 1 && shareValue <= 100;
  const ready =
    items.length > 0 && sent.length > 0 && (kind !== "approval" || rule !== "share" || shareOk);

  const entryOf = (key: Key): ReviewerInput => {
    const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
    if (type === "member") return id;
    if (type === "group") return { groupId: id };
    return guestsByKey.get(key) as GuestInput;
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const reviewers: ReviewStepInput[] = inTurn
      ? steps
          .map((s) => ({ name: s.name.trim(), reviewers: s.people.filter(askable).map(entryOf) }))
          .filter((s) => s.reviewers.length > 0)
          .map((s) =>
            s.name ? s : s.reviewers.length === 1 ? (s.reviewers[0] as ReviewerInput) : s.reviewers,
          )
      : sent.map(entryOf);
    create.mutate(
      {
        kind,
        message: message.trim() || undefined,
        dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
        remind,
        order: inTurn ? "sequence" : "parallel",
        rule: kind === "approval" ? rule : undefined,
        share: kind === "approval" && rule === "share" ? shareValue : undefined,
        items: items.map((key) => {
          const [type, id = ""] = key.split(":") as [string, string];
          return type === WORKSPACE_KEY
            ? { workspace: true as const }
            : type === "folder"
              ? { folderId: id }
              : type === "track"
                ? { trackId: id, versionId: chosen.get(key)?.versionId ?? null }
                : { fileId: id };
        }),
        reviewers: reviewers as CreateReviewInput["reviewers"],
        overrides: expandGroupOverrides(
          Object.fromEntries(Object.entries(overrides).filter(([key]) => sent.includes(key))),
          groups,
        ),
      },
      {
        onSuccess: (review) =>
          void navigate({ to: "/reviews/$reviewId", params: { reviewId: review.id } }),
      },
    );
  };

  // Steps as they are shown: each its own list in turn, one list for everyone otherwise.
  const shown: FormStep[] = inTurn ? steps : [{ name: "", people }];
  const movable = inTurn && steps.length > 1;
  const stepLabel = (i: number) => stepTitle(steps[i]?.name, i + 1);
  const dropOn = (event: DragEvent, to: number | "new") => {
    event.preventDefault();
    const key = event.dataTransfer.getData("text/plain") || dragging;
    setDragging(null);
    if (!key) return;
    if (to === "new") setSteps([...dropFromSteps(steps, key), { name: "", people: [key] }]);
    else if (stepIndexOf(steps, key) !== to) setSteps(moveToStep(steps, key, to));
  };

  const personRow = (key: Key, stepIndex: number) => {
    const { name, hint, avatar } = labelOf(key);
    const refusal = refusalOf(key);
    const group = key.startsWith("group:");
    return (
      <li
        key={key}
        draggable={movable}
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", key);
          event.dataTransfer.effectAllowed = "move";
          setDragging(key);
        }}
        onDragEnd={() => setDragging(null)}
        className={cn(
          "flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 last:border-b-0",
          dragging === key && "opacity-40",
        )}
      >
        {movable && (
          <Icon name="grip" size={14} className="shrink-0 cursor-grab text-ink-3" aria-hidden />
        )}
        {group ? (
          <span className="flex size-6 shrink-0 items-center justify-center text-ink-3">
            <Icon name="users" size={15} />
          </span>
        ) : (
          <Avatar id={avatar} name={name} size={24} />
        )}
        <span className="min-w-36 flex-1 basis-40">
          <span className={cn("block truncate text-[14px]", refusal ? "text-ink-3" : "text-ink")}>
            {name}
          </span>
          <span className="block truncate text-[12px] text-ink-3">
            {hint}
            {refusal ? ` · ${refusal.toLowerCase()}, not asked` : ""}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {movable && (
            <Dropdown
              size="sm"
              label={`Step for ${name}`}
              value={<span className="max-w-32 truncate text-[12px]">{stepLabel(stepIndex)}</span>}
              actions={steps.map((_, i) => ({
                label: stepLabel(i),
                checked: i === stepIndex,
                onSelect: () => setSteps(moveToStep(steps, key, i)),
              }))}
            />
          )}
          {!group && !refusal && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOverriding(key)}
              aria-label={`Override what ${name} may do`}
            >
              {overrides[key] ? "Overridden" : "Override"}
            </Button>
          )}
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={() => remove(key)}
            className="flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={12} />
          </button>
        </span>
      </li>
    );
  };

  const stepCard = (step: FormStep, i: number) => {
    // Added to the step that is open; all at once, to the last step, as the server reads it.
    const target = inTurn ? i : steps.length - 1;
    return (
      <li key={String(i)} className="flex items-start gap-3">
        {inTurn && (
          <span className="tabular mt-2.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-[12px] font-medium text-ink">
            {i + 1}
          </span>
        )}
        <Card
          className={cn(
            "min-w-0 flex-1 transition-colors",
            dragging && !step.people.includes(dragging) && "border-dashed border-edge",
          )}
        >
          <section
            aria-label={inTurn ? stepLabel(i) : "Reviewers"}
            onDragOver={(event) => {
              if (dragging) event.preventDefault();
            }}
            onDrop={(event) => dropOn(event, i)}
          >
            {inTurn && (
              <div className="flex h-11 items-center gap-2 border-b border-line px-2">
                <InlineInput
                  value={step.name}
                  onChange={(e) => setSteps(renameStep(steps, i, e.target.value))}
                  placeholder={`Name this step, such as ${stepNameExamples[i % stepNameExamples.length]} (optional)`}
                  aria-label={`Name of step ${i + 1}`}
                  maxLength={80}
                  autoComplete="off"
                  className="h-8 min-w-0 flex-1 px-2 text-[14px]"
                />
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => setSteps(removeStep(steps, i))}
                >
                  <Icon name="close" size={13} />
                </Button>
              </div>
            )}
            {step.people.length > 0 && (
              <ul className="m-0 list-none p-0">{step.people.map((key) => personRow(key, i))}</ul>
            )}
            <div className={cn("p-1.5", step.people.length > 0 && "border-t border-line")}>
              <PeoplePicker
                label={inTurn ? `Add to ${stepLabel(i)}` : "Add reviewers"}
                chips={false}
                size="quiet"
                people={offered.filter((p) => !has(p.key))}
                chosen={[]}
                onChange={(next) => {
                  const picked = next[0];
                  if (picked) add(target, picked);
                }}
                placeholder={
                  people.length === 0
                    ? "Members, groups, or an email address for a new guest"
                    : step.people.length === 0
                      ? "Add someone to this step"
                      : "Add someone"
                }
              />
            </div>
          </section>
        </Card>
      </li>
    );
  };

  const defaults = settings ? reviewerDefaults(settings, new Date()) : null;
  const overridingLabel = overriding ? labelOf(overriding) : null;
  const dueLabel = due ? dueFormat.format(new Date(`${due}T12:00:00`)) : "no date";
  const stepsSent = steps.filter((s) => s.people.some(askable)).length;

  return (
    <>
      <Page>
        <form
          onSubmit={submit}
          aria-label="Request a review"
          className="grid gap-10 @5xl/app:grid-cols-[minmax(0,1fr)_280px]"
        >
          <div className="flex min-w-0 flex-col gap-10">
            {fromTitle && (
              <p
                role="status"
                className="m-0 flex items-center gap-2 rounded-panel border border-line bg-raised/40 px-3 py-2 text-[13px] text-ink-2"
              >
                <Icon name="copy" size={14} className="shrink-0 text-ink-3" />
                <span className="min-w-0 truncate">
                  Filled in from {fromTitle}. Nothing is sent until you press Send.
                </span>
              </p>
            )}
            <Section n={1} title="Kind">
              <div role="radiogroup" aria-label="Kind" className="grid gap-2 @3xl/app:grid-cols-2">
                {kinds.map((k) => (
                  <ChoiceCard
                    key={k.id}
                    name="kind"
                    value={k.id}
                    checked={kind === k.id}
                    onChange={() => setKind(k.id)}
                    title={
                      <>
                        <Icon name={k.id === "approval" ? "review" : "comment"} size={15} />
                        {k.label}
                      </>
                    }
                    hint={k.hint}
                  />
                ))}
              </div>
            </Section>

            <Section
              n={2}
              title="What"
              hint={`${capital(words.tracks)} at their latest ${words.version} or a chosen one, files, or whole folders.`}
            >
              <ItemPicker
                projectId={projectId}
                chosen={chosen}
                onToggle={toggleItem}
                workspace={scope}
              />
              {items.length > 0 && (
                <ul aria-label="Chosen" className="flex flex-wrap gap-1.5">
                  {items.map((key) => {
                    const [type, id] = key.split(":") as [string, string];
                    const track = type === "track" ? tracks.find((t) => t.id === id) : undefined;
                    const file = type === "file" ? files.find((f) => f.id === id) : undefined;
                    const folder = type === "folder" ? folders.find((f) => f.id === id) : undefined;
                    const name =
                      type === WORKSPACE_KEY
                        ? "Everything in this workspace"
                        : (track?.name ?? file?.name ?? folder?.name ?? "Item");
                    const latest = track ? latestOf(track) : null;
                    const versionId = chosen.get(key)?.versionId ?? null;
                    const picked = track?.versions.find((v) => v.id === versionId);
                    return (
                      <li
                        key={key}
                        className="flex h-8 max-w-full items-center gap-2 rounded-chip border border-line bg-raised/40 pr-1 pl-2.5 text-[13px] text-ink"
                      >
                        <Icon
                          name={
                            type === WORKSPACE_KEY
                              ? "globe"
                              : track
                                ? "track"
                                : folder
                                  ? "folder"
                                  : "file"
                          }
                          size={13}
                          className="shrink-0 text-ink-3"
                        />
                        <span className="min-w-0 truncate">{name}</span>
                        {folder && <span className="shrink-0 text-ink-3">everything in it</span>}
                        {track && latest && (
                          <Dropdown
                            size="sm"
                            value={
                              <span className="tabular text-[12px]">
                                {picked
                                  ? versionLabel(picked.number)
                                  : `Latest (${versionLabel(latest.number)})`}
                              </span>
                            }
                            actions={[
                              {
                                label: `Latest (${versionLabel(latest.number)})`,
                                checked: !picked,
                                onSelect: () =>
                                  setChosen(new Map(chosen).set(key, { versionId: null })),
                              },
                              ...[...track.versions]
                                .sort((a, b) => b.number - a.number)
                                .map((v) => ({
                                  label: versionLabel(v.number),
                                  checked: picked?.id === v.id,
                                  onSelect: () =>
                                    setChosen(new Map(chosen).set(key, { versionId: v.id })),
                                })),
                            ]}
                          />
                        )}
                        <button
                          type="button"
                          aria-label={`Remove ${name}`}
                          onClick={() => toggleItem(key)}
                          className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
                        >
                          <Icon name="close" size={12} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              {wholeWorkspace ? (
                <p className="text-[12px] text-ink-3">
                  Covers every project you may share, now and those made later. The invitation says
                  so.
                </p>
              ) : items.some((key) => key.startsWith("folder:")) ? (
                <p className="text-[12px] text-ink-3">
                  A folder covers everything in it, files added later included.
                </p>
              ) : null}
            </Section>

            <Section
              n={3}
              title="Reviewers"
              hint="Members, groups and guests. An address no one here answers to invites a new guest, by link. What they may do follows the workspace's defaults unless you override it here."
            >
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                  <div className="flex items-center gap-2.5">
                    <span className="label">Order</span>
                    <Segmented
                      label="Order"
                      value={inTurn ? "turn" : "once"}
                      options={[
                        { value: "once", label: "All at once" },
                        { value: "turn", label: "In steps" },
                      ]}
                      onChange={(v) => setInTurn(v === "turn")}
                    />
                  </div>
                  {kind === "approval" && (
                    <fieldset className="m-0 flex flex-wrap items-center gap-1.5 border-0 p-0">
                      <legend className="label float-left mr-1.5">Approved when</legend>
                      {(Object.keys(ruleWords) as ApprovalRule[]).map((r) => (
                        <ToggleChip key={r} pressed={rule === r} onClick={() => setRule(r)}>
                          {ruleWords[r].replace(" approves", "")}
                        </ToggleChip>
                      ))}
                      {rule === "share" && (
                        <span className="flex items-center gap-1 text-[13px] text-ink-3">
                          <Input
                            size="sm"
                            inputMode="numeric"
                            value={share}
                            aria-invalid={!shareOk}
                            onChange={(e) => setShare(e.target.value.replace(/\D/g, ""))}
                            className="w-14 text-center"
                            aria-label="Share that must approve, in per cent"
                          />
                          %
                        </span>
                      )}
                    </fieldset>
                  )}
                </div>
                <p className="m-0 text-[13px] text-ink-3">
                  {inTurn
                    ? "Each step starts when the one before finishes; everyone in a step is asked together. Drag someone to another step, or choose it from their row."
                    : "Everyone is asked now."}
                </p>
              </div>
              <ol aria-label="Steps" className="m-0 flex list-none flex-col gap-2 p-0">
                {shown.map((step, i) => stepCard(step, i))}
                {inTurn && (
                  <li className="pl-10">
                    {dragging ? (
                      <section
                        aria-label="New step"
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => dropOn(event, "new")}
                        className="flex h-10 items-center justify-center rounded-panel border border-dashed border-edge text-[13px] text-ink-3"
                      >
                        Drop here for a new step
                      </section>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSteps([...steps, emptyStep()])}
                      >
                        <Icon name="plus" size={12} />
                        Add a step
                      </Button>
                    )}
                  </li>
                )}
              </ol>
              <p className="m-0 text-[12px] text-ink-3">
                Guests need no account: each is emailed a link that works once, for{" "}
                {settings?.guestLinkDays ?? 3} days, and reaches only this review.
              </p>
            </Section>

            <Section n={4} title="When and why">
              <div className="flex flex-wrap items-center gap-2">
                <span className="label" id="request-due">
                  Due
                </span>
                <Input
                  type="date"
                  value={due}
                  aria-labelledby="request-due"
                  min={daysFromNow(0)}
                  onChange={(e) => setDue(e.target.value)}
                  className="w-44"
                />
                {(
                  [
                    [3, "In 3 days"],
                    [7, "A week"],
                    [14, "Two weeks"],
                  ] as const
                ).map(([days, label]) => (
                  <ToggleChip
                    key={days}
                    pressed={due === daysFromNow(days)}
                    onClick={() => setDue(daysFromNow(days))}
                  >
                    {label}
                  </ToggleChip>
                ))}
                {due && (
                  <span className="flex items-center gap-2 text-[13px] text-ink-2 @3xl/app:ml-auto">
                    Remind the day before
                    <Switch label="Remind the day before" checked={remind} onChange={setRemind} />
                  </span>
                )}
              </div>
              <Textarea
                rows={3}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                aria-label="Message"
                placeholder="What to listen for, and anything they need to know. Goes out with the invitation."
              />
            </Section>
          </div>

          <aside className="flex flex-col gap-4 @5xl/app:sticky @5xl/app:top-6 @5xl/app:self-start">
            <Card className="flex flex-col gap-3 p-4">
              <span className="label">Summary</span>
              <dl className="flex flex-col gap-2 text-[13px]">
                {(
                  [
                    ["Kind", kinds.find((k) => k.id === kind)?.label ?? ""],
                    [
                      "Items",
                      wholeWorkspace
                        ? "everything"
                        : items.length
                          ? `${items.length} chosen`
                          : "none yet",
                    ],
                    [
                      "People",
                      sent.length
                        ? `${sent.length}${
                            inTurn
                              ? `, in ${stepsSent} ${stepsSent === 1 ? "step" : "steps"}`
                              : ", all at once"
                          }`
                        : "none yet",
                    ],
                    ...(kind === "approval"
                      ? [
                          [
                            "Rule",
                            rule === "share"
                              ? `${shareOk ? share : "?"}% approve`
                              : ruleWords[rule],
                          ],
                        ]
                      : []),
                    ["Due", dueLabel],
                  ] as [string, string][]
                ).map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-16 shrink-0 text-ink-3">{k}</dt>
                    <dd className="min-w-0 text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              {create.error && (
                <p role="alert" className="text-[13px] text-signal">
                  {create.error.message}
                </p>
              )}
              <Button
                variant="primary"
                size="lg"
                type="submit"
                disabled={!ready || create.isPending}
                className="mt-1 w-full"
              >
                <Icon name="send" size={14} />
                Send the review
              </Button>
              <Button variant="ghost" className="w-full" asChild>
                <Link to="/projects/$projectId/reviews" params={{ projectId }}>
                  Cancel
                </Link>
              </Button>
              <p className="text-[12px] text-ink-3">
                Invitations go by email when you send. Guests get a link that is theirs alone.
              </p>
            </Card>
          </aside>
        </form>
      </Page>
      {overriding && overridingLabel && defaults && (
        <Dialog
          title={`${overridingLabel.name} in this review`}
          description="An override for this review only; everyone else keeps the workspace's defaults."
          onClose={() => setOverriding(null)}
        >
          <ReviewerPermissionsEditor
            name={overridingLabel.name}
            kind={kind}
            guest={overriding.startsWith("guest:")}
            initial={applyPermissions(defaults, overrides[overriding] ?? {}).data ?? defaults}
            pending={false}
            error={null}
            onSave={(change) => {
              setOverrides({ ...overrides, [overriding]: change });
              setOverriding(null);
            }}
            onCancel={() => setOverriding(null)}
          />
        </Dialog>
      )}
    </>
  );
}
