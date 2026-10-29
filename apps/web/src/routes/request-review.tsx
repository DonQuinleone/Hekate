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
  reviewerDefaults,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { type Chosen, ItemPicker, latestOf } from "~/components/item-picker";
import { Card, Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ReviewerPermissionsEditor } from "~/components/reviewer-permissions";
import { Button } from "~/components/ui/button";
import { ToggleChip } from "~/components/ui/chip";
import { Checkbox, ChoiceCard } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Textarea } from "~/components/ui/input";
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
  reviewScopeQuery,
  useCreateReview,
  useItemWords,
  useProjectCan,
  workspaceSettingsQuery,
} from "~/lib/queries";
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

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
 * Asking for a review, inside the project (#130): what, who, in what order, by when. The
 * form is the prototype's request page; it sends to the reviews API, which checks it all.
 */
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

export function RequestReviewPage({
  projectId,
  kind: kindParam,
  item,
  items: itemsParam,
  version,
  people: peopleParam,
  download,
  until,
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
}) {
  const navigate = useNavigate();
  const { data: project, error } = useQuery(projectQuery(projectId));
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const { data: files = [] } = useQuery(projectFilesQuery(projectId));
  const { data: folders = [] } = useQuery(projectFoldersQuery(projectId));
  const { data: members = [] } = useQuery(projectMembersQuery(projectId));
  const { data: roles = [] } = useQuery(projectRolesQuery(projectId));
  const { data: groups = [] } = useQuery(projectGroupsQuery(projectId));
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const can = useProjectCan(projectId);
  const { words, versionLabel } = useItemWords(projectId);
  const mayRequest = can("request_reviews");
  const { data: known = [] } = useQuery({
    ...projectGuestsQuery(projectId),
    enabled: mayRequest,
  });
  const create = useCreateReview(projectId);
  // Whether everything in the workspace may be asked about (#501): offered only then.
  const { data: scope = null } = useQuery({ ...reviewScopeQuery, enabled: mayRequest });

  const [kind, setKind] = useState<ReviewKind>(kindParam ?? "approval");
  const [chosen, setChosen] = useState<Chosen>(
    () =>
      new Map(
        [...(item ? [item] : []), ...(itemsParam ?? [])].map((key) => [
          key,
          // A version named is of the one track asked about (#489).
          { versionId: version && key.startsWith("track:") ? version : null },
        ]),
      ),
  );
  // The order, step by step; everyone in a step is asked together.
  const [steps, setSteps] = useState<Key[][]>([peopleParam ?? []]);
  const [inTurn, setInTurn] = useState(false);
  const [rule, setRule] = useState<ApprovalRule>("all");
  const [share, setShare] = useState("66");
  const [due, setDue] = useState("");
  const [remind, setRemind] = useState(true);
  const [message, setMessage] = useState("");
  // What a share sheet chose for everyone it named (#489) comes in as their overrides, since
  // the page sets what people may do one person at a time.
  const [overrides, setOverrides] = useState<Record<Key, ReviewerPermissionsChange>>(() =>
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
  );
  const [overriding, setOverriding] = useState<Key | null>(null);
  // Guests typed in here, by key, and the form for one more. One a share sheet named by
  // address alone (#489) is named from it, until the People page renames them.
  const [added, setAdded] = useState<Map<Key, GuestInput>>(
    () =>
      new Map(
        (peopleParam ?? [])
          .filter((key) => key.startsWith("guest:"))
          .map((key) => [key, guestFromEmail(key.slice("guest:".length))]),
      ),
  );
  const [inviting, setInviting] = useState(false);
  const [guest, setGuest] = useState({ name: "", email: "", label: "" });
  const [guestError, setGuestError] = useState<string | null>(null);

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
  const people = steps.flat();
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
  // A choice made under another kind may no longer hold: only who can be asked is sent.
  const askable = (key: Key) => {
    const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
    if (type === "member") return memberRefusal(id) === null;
    if (type === "group") {
      const group = groups.find((g) => g.id === id);
      return Boolean(group) && groupRefusal(group as ProjectGroup) === null;
    }
    return guestsByKey.has(key);
  };

  const toggle = (key: Key) =>
    setSteps(
      has(key)
        ? steps.map((s) => s.filter((k) => k !== key)).filter((s, i) => s.length > 0 || i === 0)
        : steps.map((s, i) => (i === steps.length - 1 ? [...s, key] : s)),
    );
  const moveTo = (key: Key, to: number) =>
    setSteps(
      steps.map((s, i) =>
        i === to ? [...s.filter((k) => k !== key), key] : s.filter((k) => k !== key),
      ),
    );
  // A folder taken covers what is beneath it, and the workspace everything (#501).
  const toggleItem = (key: string) =>
    setChosen(
      toggleScope(chosen, key, { versionId: null }, (folderId) =>
        itemsIn(folders, tracks, files, folderId),
      ),
    );
  const addGuest = () => {
    const name = guest.name.trim();
    const email = guest.email.trim().toLowerCase();
    if (!name) return setGuestError("A name is needed: it is how they are shown.");
    if (!emailPattern.test(email))
      return setGuestError("An email is needed: their link goes there.");
    const key = `guest:${email}`;
    if (has(key)) return setGuestError("They are already asked.");
    setAdded(new Map(added).set(key, { name, email, label: guest.label.trim() || undefined }));
    setSteps(steps.map((s, i) => (i === steps.length - 1 ? [...s, key] : s)));
    setGuest({ name: "", email: "", label: "" });
    setGuestError(null);
    setInviting(false);
  };

  const labelOf = (key: Key): { name: string; hint: string; avatar: string } => {
    const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
    if (type === "member") {
      const m = memberById.get(id);
      return { name: m?.name ?? "Someone", hint: "", avatar: id };
    }
    if (type === "group") {
      const g = groups.find((x) => x.id === id);
      return { name: g?.name ?? "A group", hint: `${g?.members.length ?? 0}`, avatar: id };
    }
    const g = guestsByKey.get(key);
    return { name: g?.name ?? id, hint: g?.label ?? "Guest", avatar: id };
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
    const reviewers: CreateReviewInput["reviewers"] = inTurn
      ? steps
          .map((s) => s.filter(askable).map(entryOf))
          .filter((s) => s.length > 0)
          .map((s) => (s.length === 1 ? (s[0] as ReviewerInput) : s))
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
        reviewers,
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

  const personChip = (key: Key, stepIndex: number) => {
    const { name, avatar } = labelOf(key);
    const refused = !askable(key);
    return (
      <span
        key={key}
        className={cn(
          "flex h-8 max-w-full items-center gap-2 rounded-chip border border-line bg-raised/40 pr-1 pl-1.5 text-[13px] text-ink",
          refused && "text-ink-3",
        )}
      >
        {key.startsWith("group:") ? (
          <Icon name="users" size={14} className="mx-0.5 shrink-0 text-ink-3" />
        ) : (
          <Avatar id={avatar} name={name} size={20} />
        )}
        <span className="min-w-0 truncate">{name}</span>
        {refused && <span className="shrink-0 text-[12px] text-ink-3">not asked</span>}
        {inTurn && steps.length > 1 && (
          <Dropdown
            size="sm"
            value={<span className="text-[12px]">Step {stepIndex + 1}</span>}
            actions={steps.map((_, i) => ({
              label: `Step ${i + 1}`,
              checked: i === stepIndex,
              onSelect: () => moveTo(key, i),
            }))}
          />
        )}
        <button
          type="button"
          aria-label={`Remove ${name}`}
          onClick={() => toggle(key)}
          className="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
        >
          <Icon name="close" size={12} />
        </button>
      </span>
    );
  };

  const overrideButton = (key: Key, name: string) =>
    has(key) && (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOverriding(key)}
        aria-label={`Override what ${name} may do`}
      >
        {overrides[key] ? "Overridden" : "Override"}
      </Button>
    );

  const defaults = settings ? reviewerDefaults(settings, new Date()) : null;
  const overridingLabel = overriding ? labelOf(overriding) : null;
  const usableGroups = groups;
  const dueLabel = due ? dueFormat.format(new Date(`${due}T12:00:00`)) : "no date";

  return (
    <>
      <PageHeader crumbs={crumbs} title="New review" />
      <Page>
        <form
          onSubmit={submit}
          aria-label="Request a review"
          className="grid gap-10 @5xl/app:grid-cols-[minmax(0,1fr)_280px]"
        >
          <div className="flex min-w-0 flex-col gap-10">
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
              title="Who"
              hint="Groups, members and guests. What they may do follows the workspace's defaults unless you override it here."
            >
              {usableGroups.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="label">Groups</span>
                  <div className="flex flex-wrap gap-1.5">
                    {usableGroups.map((g) => {
                      const why = groupRefusal(g);
                      const key = `group:${g.id}`;
                      return (
                        <ToggleChip
                          key={g.id}
                          pressed={has(key)}
                          disabled={why !== null && !has(key)}
                          title={why ?? undefined}
                          onClick={() => toggle(key)}
                          className={has(key) ? undefined : "border-line"}
                        >
                          <Icon name="users" size={13} className="text-ink-3" />
                          {g.name}
                          <span className="tabular text-ink-3">{g.members.length}</span>
                          {why && <span className="text-[12px] text-ink-3">· {why}</span>}
                        </ToggleChip>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="grid items-start gap-3 @3xl/app:grid-cols-2">
                <Card>
                  <div className="flex h-10 items-center border-b border-line px-3">
                    <span className="label">Members</span>
                  </div>
                  <ul>
                    {members.map((m) => {
                      const key = `member:${m.userId}`;
                      const why = memberRefusal(m.userId);
                      const role = roles.find((r) => r.id === m.roleId);
                      return (
                        <li
                          key={m.userId}
                          className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                        >
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch has-[:disabled]:cursor-not-allowed">
                            <Checkbox
                              checked={has(key)}
                              disabled={why !== null && !has(key)}
                              onChange={() => toggle(key)}
                            />
                            <Avatar id={m.userId} name={m.name} size={24} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[14px] text-ink">{m.name}</span>
                              <span className="block truncate text-[12px] text-ink-3">
                                {role?.name}
                                {why ? ` · ${why.toLowerCase()}` : ""}
                              </span>
                            </span>
                          </label>
                          {overrideButton(key, m.name)}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
                <Card>
                  <div className="flex h-10 items-center gap-2 border-b border-line px-3">
                    <span className="label">Guests</span>
                    <span className="text-[12px] text-ink-3">by link</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      aria-expanded={inviting}
                      onClick={() => setInviting(!inviting)}
                    >
                      <Icon name="plus" size={12} />
                      Someone new
                    </Button>
                  </div>
                  <ul>
                    {[...guestsByKey].map(([key, g]) => (
                      <li
                        key={key}
                        className="flex min-h-12 items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0"
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 self-stretch">
                          <Checkbox checked={has(key)} onChange={() => toggle(key)} />
                          <Avatar id={g.email} name={g.name} size={24} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[14px] text-ink">{g.name}</span>
                            <span className="block truncate text-[12px] text-ink-3">
                              {g.label ? `${g.label} · ` : ""}
                              {g.email}
                            </span>
                          </span>
                        </label>
                        {overrideButton(key, g.name)}
                      </li>
                    ))}
                    {guestsByKey.size === 0 && !inviting && (
                      <li className="px-3 py-4 text-[13px] text-ink-3">
                        No guests asked here yet. Someone new gets a link of their own.
                      </li>
                    )}
                    {inviting && (
                      <li className="rise-in flex flex-col gap-2 px-3 py-3">
                        <Field label="Name">
                          <Input
                            value={guest.name}
                            onChange={(e) => setGuest({ ...guest, name: e.target.value })}
                            autoComplete="off"
                          />
                        </Field>
                        <Field label="Email" error={guestError ?? undefined}>
                          <Input
                            type="email"
                            value={guest.email}
                            aria-invalid={guestError !== null}
                            onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                            autoComplete="off"
                          />
                        </Field>
                        <Field label="Shown as" hint="Such as Conductor; optional.">
                          <Input
                            value={guest.label}
                            onChange={(e) => setGuest({ ...guest, label: e.target.value })}
                            autoComplete="off"
                          />
                        </Field>
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setInviting(false);
                              setGuestError(null);
                            }}
                          >
                            Cancel
                          </Button>
                          <Button variant="secondary" size="sm" onClick={addGuest}>
                            Add
                          </Button>
                        </div>
                      </li>
                    )}
                  </ul>
                </Card>
              </div>
              <p className="text-[12px] text-ink-3">
                Guests need no account: each is emailed a link that works once, for{" "}
                {settings?.guestLinkDays ?? 3} days, and reaches only this review.
              </p>
            </Section>

            <Section
              n={4}
              title="Order"
              hint={
                inTurn
                  ? "Each step starts when the one before finishes. Everyone at a step is asked together."
                  : "Everyone is asked now."
              }
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Segmented
                  label="Order"
                  value={inTurn ? "turn" : "once"}
                  options={[
                    { value: "once", label: "All at once" },
                    { value: "turn", label: "In turn" },
                  ]}
                  onChange={(v) => setInTurn(v === "turn")}
                />
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
              {people.length === 0 ? (
                <p className="text-[13px] text-ink-3">Choose who above first.</p>
              ) : inTurn ? (
                <ol className="flex flex-col gap-2">
                  {steps.map((step, i) => (
                    <li key={String(i)} className="flex items-start gap-3">
                      <span className="tabular mt-1.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-raised text-[12px] font-medium text-ink">
                        {i + 1}
                      </span>
                      <div className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-panel border border-dashed border-line-strong p-1.5">
                        {step.map((key) => personChip(key, i))}
                        {step.length === 0 && (
                          <span className="px-2 text-[12px] text-ink-3">
                            Move people here from another step
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                  <li className="flex items-center gap-2 pl-10">
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
                  {people.map((key) => personChip(key, 0))}
                </div>
              )}
            </Section>

            <Section n={5} title="When and why">
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
                        ? `${sent.length}${inTurn ? `, in ${steps.filter((s) => s.some(askable)).length} steps` : ", all at once"}`
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
