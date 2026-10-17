import {
  formatBytes,
  type InstanceAccess,
  type InstanceMemberRow,
  type InstanceSection,
  type InstanceWorkspace,
  type InstanceWorkspaceDetail,
  instanceActions,
  instanceSections,
  instanceSectionsFor,
  WORKSPACE_DELETE_GRACE_DAYS,
  type WorkspaceState,
} from "@hekate/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useDeferredValue, useEffect, useRef, useState } from "react";
import { Stat } from "~/components/dashboard";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { Danger, Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { actionCopy } from "~/lib/access-log";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import {
  instanceAccessQuery,
  instanceKeysQuery,
  instanceMembersQuery,
  instanceOperatorsQuery,
  instanceOverviewQuery,
  instanceProjectsQuery,
  instanceSettingsQuery,
  instanceStorageQuery,
  instanceWorkspaceQuery,
  instanceWorkspacesQuery,
  json,
} from "~/lib/queries";

const since = formatDates({ day: "numeric", month: "short", year: "numeric" });

/**
 * `/instance` and its sections (#155, decision 062): the instance side, in the same shell.
 * Operators see every section; a workspace's owner sees their own workspaces and no more.
 */
export function InstancePage({ section }: { section: InstanceSection }) {
  const { data: access, isPending } = useQuery(instanceAccessQuery);
  if (isPending) return null;
  if (!access)
    return (
      <Page width="narrow">
        <PageHeader title="Instance" />
        <Empty
          title="This is for operators"
          text="The instance side is open to its operators and to workspace owners."
        />
      </Page>
    );
  const sections = instanceSectionsFor(access);
  const current = sections.includes(section) ? section : (sections[0] ?? "workspaces");
  const meta = instanceSections[current];
  const operatorView = access.operator && !access.keyNeeded;
  if (current === "workspaces") return <Workspaces access={access} />;
  return (
    <Page className="gap-10">
      <PageHeader
        crumbs={[
          {
            key: "instance",
            link: <Link to="/instance">Instance</Link>,
          },
        ]}
        title={meta.label}
      />
      <p className="m-0 max-w-[620px] text-[14px] text-ink-2">{meta.hint}.</p>
      {access.keyNeeded ? (
        <KeyNeeded />
      ) : (
        <>
          {current === "overview" && operatorView && <Overview />}
          {current === "operators" && operatorView && <Operators />}
        </>
      )}
    </Page>
  );
}

/** An operator signed in without a key: what to do, rather than a refusal. */
function KeyNeeded() {
  const navigate = useNavigate();
  const client = useQueryClient();
  return (
    <Section
      title="Sign in with your security key"
      intro="Operators act from a session signed in with a passkey or hardware security key, so a stolen password alone never reaches every workspace."
    >
      <Row
        name="Sign in again with your key"
        hint="Choose “Sign in with a passkey”, and use your key."
        inline
      >
        <Button
          variant="primary"
          size="md"
          onClick={async () => {
            await authClient.signOut();
            client.clear();
            await navigate({ to: "/sign-in", search: { redirect: "/instance" } });
          }}
        >
          Sign in again
        </Button>
      </Row>
      <Row name="No key yet" hint="Add one to your account first, then sign in with it." inline>
        <Button variant="secondary" size="md" asChild>
          <Link to="/account/$section" params={{ section: "security" }}>
            Your account
          </Link>
        </Button>
      </Row>
    </Section>
  );
}

function Overview() {
  const { data } = useQuery(instanceOverviewQuery);
  if (!data) return null;
  const { queue } = data;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
        <Stat label="Workspaces" value={data.workspaces} hint="on this instance" />
        <Stat label="People" value={data.people} hint="with an account" />
        <Stat label="Storage" value={formatBytes(data.storageBytes)} hint="before encryption" />
        <Stat
          label="Queue"
          value={queue ? queue.waiting : "?"}
          hint={
            !queue
              ? "could not be read"
              : queue.failedToday > 0
                ? `${queue.failedToday} failed today`
                : queue.active > 0
                  ? `${queue.active} running`
                  : "nothing running"
          }
          flag={!queue || queue.failedToday > 0}
        />
      </div>
      <Section title="Needs an operator">
        {data.needs.length === 0 ? (
          <Row
            name="Nothing"
            hint="No failed jobs today, no missing files, and every operator has a key."
          />
        ) : (
          data.needs.map((n) => (
            <Row
              key={n.title}
              name={
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-signal" />
                  {n.title}
                </span>
              }
              hint={n.detail}
            >
              {n.kind === "key_missing" && (
                <Button variant="secondary" size="md" asChild>
                  <Link to="/instance/$section" params={{ section: "operators" }}>
                    Operators
                  </Link>
                </Button>
              )}
            </Row>
          ))
        )}
      </Section>
      <Section title="Recently">
        {data.recent.length === 0 ? (
          <Row name="Nothing yet" hint="What operators do here is listed as it happens." />
        ) : (
          data.recent.map((r) => (
            <Row
              key={`${r.at}${r.action}${r.target}`}
              name={
                <span>
                  <span className="text-ink">{r.target ?? "Instance"}</span>{" "}
                  <span className="text-ink-2">
                    {instanceActions[r.action] ?? r.action}
                    {r.actor ? ` by ${r.actor}` : " at setup"}
                  </span>
                </span>
              }
              inline
            >
              <span className="tabular text-[12px] text-ink-3">{ago(r.at)}</span>
            </Row>
          ))
        )}
      </Section>
    </>
  );
}

type WorkspaceFilter = "" | WorkspaceState;
const filters: { value: WorkspaceFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

/**
 * The workspaces this viewer may see, as a full-height split (#174): the list at the left,
 * searched and filtered, paging as it scrolls; the chosen workspace's tabs at the right.
 */
function Workspaces({ access }: { access: InstanceAccess }) {
  const operator = access.operator && !access.keyNeeded;
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<WorkspaceFilter>("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const search = useDeferredValue(q.trim());
  const list = useInfiniteQuery(
    instanceWorkspacesQuery({ q: search || undefined, state: filter || undefined }),
  );
  const workspaces = list.data?.pages.flatMap((p) => p.workspaces) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const current = workspaces.find((w) => w.id === chosen) ?? workspaces[0];
  const more = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    const end = more.current;
    if (!end || !hasNextPage) return;
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    });
    seen.observe(end);
    return () => seen.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return (
    <>
      <PageHeader
        crumbs={[{ key: "instance", link: <Link to="/instance">Instance</Link> }]}
        title="Workspaces"
        actions={
          operator ? (
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              Workspace
            </Button>
          ) : undefined
        }
      />
      {creating && (
        <NewWorkspace
          onClose={() => setCreating(false)}
          onMade={(id) => {
            setFilter("");
            setQ("");
            setChosen(id);
          }}
        />
      )}
      <div className="flex h-full min-h-0 flex-col @3xl/app:flex-row">
        <div className="flex w-full shrink-0 flex-col border-b border-line @3xl/app:w-[300px] @3xl/app:border-r @3xl/app:border-b-0">
          <div className="flex flex-col gap-2 p-3">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name or subdomain"
              aria-label="Find a workspace by name or subdomain"
            />
            {operator && (
              <Segmented
                label="Show"
                value={filter}
                options={filters}
                onChange={setFilter}
                className="self-start"
              />
            )}
          </div>
          <div className="scroll-quiet flex max-h-[40vh] min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 @3xl/app:max-h-none">
            <ul aria-label="Workspaces" className="m-0 flex list-none flex-col gap-0.5 p-0">
              {workspaces.map((w) => (
                <li key={w.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(w.id)}
                    aria-current={w.id === current?.id ? "true" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-raised/60",
                      w.id === current?.id && "bg-raised shadow-1",
                    )}
                  >
                    <StateDot state={w.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{w.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {people(w.members)} · {formatBytes(w.storageBytes)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {list.isSuccess && workspaces.length === 0 && (
              <p className="px-3 py-6 text-center text-[13px] text-ink-3">
                {q || filter ? "Nothing matches." : "No workspaces yet."}
              </p>
            )}
            <div ref={more} />
            {workspaces.length > 0 && (
              <p className="px-2.5 pt-2 pb-1 text-[11px] text-ink-3">
                {workspaces.length} of {total}
                {hasNextPage ? " · more load as you scroll" : ""}
              </p>
            )}
          </div>
        </div>
        <div className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-y-auto">
          {current && <WorkspaceDetail key={current.id} id={current.id} operator={operator} />}
        </div>
      </div>
    </>
  );
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

function StateDot({ state }: { state: WorkspaceState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        state === "suspended" ? "bg-ink-3" : "bg-ok",
      )}
    />
  );
}

type WorkspaceTab =
  | "overview"
  | "members"
  | "projects"
  | "storage"
  | "billing"
  | "settings"
  | "keys";

/** One workspace: what it is, where it stands, and its tabs. */
function WorkspaceDetail({ id, operator }: { id: string; operator: boolean }) {
  const client = useQueryClient();
  const { data: w } = useQuery(instanceWorkspaceQuery(id));
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [suspending, setSuspending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reinstate = useMutation({
    mutationFn: async () =>
      json(await api.instance.workspaces[":id"].reinstate.$post({ param: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance"] }),
    onError: (e) => setError(e.message),
  });
  if (!w) return null;
  return (
    <div className="fade-in flex flex-col gap-6 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8">
      {suspending && <SuspendWorkspace workspace={w} onClose={() => setSuspending(false)} />}
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 truncate text-[20px] font-medium tracking-tight text-ink">{w.name}</h2>
          <p className="tabular m-0 text-[13px] text-ink-3">
            {w.slug} · since {since.format(new Date(w.createdAt))}
            {w.state === "suspended" && (
              <span className="text-signal">
                {w.deleteAfter
                  ? ` · deleted on ${since.format(new Date(w.deleteAfter))}`
                  : " · suspended"}
              </span>
            )}
          </p>
        </div>
        {operator && (
          <ActionMenu
            always
            label={w.name}
            actions={[
              w.state === "suspended"
                ? { label: "Reinstate", onSelect: () => reinstate.mutate() }
                : { label: "Suspend…", danger: true, onSelect: () => setSuspending(true) },
            ]}
          />
        )}
      </div>
      {w.state === "suspended" && (
        <p className="m-0 max-w-[620px] text-[13px] text-ink-2">
          Suspended {w.suspendedAt ? ago(w.suspendedAt) : ""}
          {w.suspendedReason ? `: ${w.suspendedReason}` : "."} Its members see this, and its guests’
          links do not open until it is reinstated.
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {error}
        </p>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as WorkspaceTab)}>
        <TabsList className="overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members · {w.members}</TabsTrigger>
          <TabsTrigger value="projects">Projects · {w.projects}</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-6 pt-6">
          <WorkspaceOverview workspace={w} />
        </TabsContent>
        <TabsContent value="members" className="flex flex-col gap-6 pt-6">
          <WorkspaceMembers id={id} operator={operator} />
        </TabsContent>
        <TabsContent value="projects" className="flex flex-col gap-6 pt-6">
          <WorkspaceProjects id={id} />
        </TabsContent>
        <TabsContent value="storage" className="flex flex-col gap-6 pt-6">
          <WorkspaceStorage id={id} />
        </TabsContent>
        <TabsContent value="billing" className="flex flex-col gap-6 pt-6">
          <WorkspaceBilling />
        </TabsContent>
        <TabsContent value="settings" className="flex flex-col gap-6 pt-6">
          <WorkspaceSettingsTab
            workspace={w}
            operator={operator}
            onSuspend={() => setSuspending(true)}
          />
        </TabsContent>
        <TabsContent value="keys" className="flex flex-col gap-6 pt-6">
          <WorkspaceKeys id={id} operator={operator} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WorkspaceOverview({ workspace: w }: { workspace: InstanceWorkspaceDetail }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
        <Stat
          label="People"
          value={w.members}
          hint={w.guests > 0 ? `and ${w.guests} ${w.guests === 1 ? "guest" : "guests"}` : "members"}
        />
        <Stat
          label="Projects"
          value={w.projects}
          hint={`${w.activeReviews} active ${w.activeReviews === 1 ? "review" : "reviews"}`}
        />
        <Stat label="Storage" value={formatBytes(w.storageBytes)} hint="before encryption" />
        <Stat
          label="Sign-in"
          value={w.signIn.method === "sso" ? (w.signIn.provider ?? "SSO") : "Password"}
          hint={w.signIn.secondFactor ? "second factor required" : "no second factor"}
        />
      </div>
      {w.invited.length > 0 && (
        <Section title="Waiting to join">
          {w.invited.map((i) => (
            <Row
              key={i.email}
              name={i.email}
              hint={`Invited as ${i.role} · the link lasts until ${since.format(new Date(i.expiresAt))}`}
            />
          ))}
        </Section>
      )}
      <Section title="Recently in this workspace">
        {w.recent.length === 0 ? (
          <Row name="Nothing yet" hint="What its members and guests do is listed as it happens." />
        ) : (
          w.recent.map((r) => (
            <Row
              key={`${r.at}${r.action}${r.actor}`}
              name={
                <span>
                  <span className="text-ink">{actorName(r.actor)}</span>
                  <span className="text-ink-3"> · </span>
                  <span className="text-ink-2">{actionCopy[r.action] ?? r.action}</span>
                </span>
              }
              inline
            >
              <span className="tabular text-[12px] text-ink-3">{ago(r.at)}</span>
            </Row>
          ))
        )}
      </Section>
    </>
  );
}

/** The log keeps "Name <address>"; the name is enough here. */
const actorName = (label: string) => {
  const at = label.indexOf(" <");
  return at > 0 ? label.slice(0, at) : label;
};

const factorWords: Record<InstanceMemberRow["factor"], string> = {
  key: "passkey or security key",
  app: "code app",
  none: "none",
};

function WorkspaceMembers({ id, operator }: { id: string; operator: boolean }) {
  const { data: members = [] } = useQuery(instanceMembersQuery(id));
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  const help = useMutation({
    mutationFn: async ({ userId, action }: { userId: string; action: MemberHelp }) =>
      json(
        await api.instance.workspaces[":id"].members[":userId"][":action"].$post({
          param: { id, userId, action },
        }),
      ),
    onSuccess: (_d, { action }) => setSaid({ text: helpDone[action], error: false }),
    onError: (e) => setSaid({ text: e.message, error: true }),
  });
  return (
    <Section
      title="People"
      intro={
        operator
          ? "Members of this workspace. Operators never sign in as anyone; what you do here is logged against your name."
          : "Members of this workspace."
      }
    >
      {members.map((m) => (
        <Row
          key={m.userId}
          name={
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              {m.name}
              <span className="truncate text-[12px] text-ink-3">{m.email}</span>
            </span>
          }
          hint={[
            roleWords[m.role] ?? m.role,
            m.lastSeenAt ? `seen ${ago(m.lastSeenAt)}` : "not seen yet",
            `second factor: ${factorWords[m.factor]}`,
          ].join(" · ")}
          inline
        >
          {operator && (
            <ActionMenu
              always
              label={m.name}
              actions={[
                {
                  label: "Send a password reset",
                  onSelect: () => help.mutate({ userId: m.userId, action: "password-reset" }),
                },
                {
                  label: "Reset the second factor",
                  onSelect: () => help.mutate({ userId: m.userId, action: "second-factor" }),
                },
                "divider",
                {
                  label: "Sign out everywhere",
                  danger: true,
                  onSelect: () => help.mutate({ userId: m.userId, action: "sessions" }),
                },
              ]}
            />
          )}
        </Row>
      ))}
      {said && (
        <p
          role={said.error ? "alert" : "status"}
          className={cn("m-0 px-4 py-3 text-[13px]", said.error ? "text-signal" : "text-ink-2")}
        >
          {said.text}
        </p>
      )}
    </Section>
  );
}

type MemberHelp = "sessions" | "password-reset" | "second-factor";
const helpDone: Record<MemberHelp, string> = {
  sessions: "Signed out everywhere. They sign in again on each device.",
  "password-reset": "A code to set a new password is on its way to them.",
  "second-factor":
    "Their code app and passkeys are gone. They sign in with their password and add one again.",
};
const roleWords: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function WorkspaceProjects({ id }: { id: string }) {
  const { data: projects, isSuccess } = useQuery(instanceProjectsQuery(id));
  return (
    <Section title="Projects" intro="Names and sizes only; the content stays the workspace’s.">
      {isSuccess && projects.length === 0 && (
        <Row name="No projects yet" hint="Its members make them from their Projects page." />
      )}
      {projects?.map((p) => (
        <Row
          key={p.id}
          name={p.name}
          hint={[
            p.profile,
            `${p.files} ${p.files === 1 ? "file" : "files"}`,
            formatBytes(p.storageBytes),
            `${p.openReviews} open ${p.openReviews === 1 ? "review" : "reviews"}`,
          ].join(" · ")}
          inline
        >
          <span className="text-[12px] text-ink-3">{p.archived ? "archived" : "active"}</span>
        </Row>
      ))}
    </Section>
  );
}

function WorkspaceStorage({ id }: { id: string }) {
  const { data: s } = useQuery(instanceStorageQuery(id));
  if (!s) return null;
  return (
    <>
      <Section title="Storage" intro="Sizes before encryption.">
        <Row
          name="Used"
          hint={`${formatBytes(s.originalBytes)} of originals, ${formatBytes(s.derivedBytes)} made from them for playback, waveforms and pages`}
          inline
        >
          <span className="tabular text-[13px] text-ink-2">
            {formatBytes(s.originalBytes + s.derivedBytes)}
          </span>
        </Row>
        <Row
          name="New objects go to"
          hint={
            s.backendIsDefault ? "The instance’s default backend." : "Chosen for this workspace."
          }
          inline
        >
          <span className="text-[13px] text-ink-2">{s.backend}</span>
        </Row>
        {s.backends.map((b) => (
          <Row
            key={b.name}
            name={b.name}
            hint={`${b.objects} ${b.objects === 1 ? "object" : "objects"}`}
            inline
          >
            <span className="tabular text-[13px] text-ink-2">{formatBytes(b.bytes)}</span>
          </Row>
        ))}
      </Section>
      <Section
        title="Housekeeping"
        intro="What the nightly reconciliation found in this workspace and has not resolved."
      >
        <Row
          name="Missing"
          hint="Records whose bytes are gone from storage. Restore them from a backup."
          inline
        >
          <span
            className={cn(
              "tabular text-[13px]",
              s.findings.missing > 0 ? "text-signal" : "text-ink-2",
            )}
          >
            {s.findings.missing}
          </span>
        </Row>
        <Row name="Orphans" hint="Bytes in storage that no record accounts for." inline>
          <span className="tabular text-[13px] text-ink-2">{s.findings.orphans}</span>
        </Row>
      </Section>
    </>
  );
}

function WorkspaceBilling() {
  return (
    <Section title="Plan">
      <Row
        name="This instance does not charge"
        hint="Plans, trials and invoices appear here once billing is set up for the instance."
      />
    </Section>
  );
}

const secondFactorWords: Record<string, string> = {
  off: "Not required",
  admins: "Required of owners and admins",
  everyone: "Required of everyone",
};

/** What the workspace's owner set, read-only, and what only an operator does with it. */
function WorkspaceSettingsTab({
  workspace: w,
  operator,
  onSuspend,
}: {
  workspace: InstanceWorkspaceDetail;
  operator: boolean;
  onSuspend: () => void;
}) {
  const client = useQueryClient();
  const { data: s } = useQuery(instanceSettingsQuery(w.id));
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["instance"] });
  const reinstate = useMutation({
    mutationFn: async () =>
      json(await api.instance.workspaces[":id"].reinstate.$post({ param: { id: w.id } })),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const keep = useMutation({
    mutationFn: async () =>
      json(await api.instance.workspaces[":id"].delete.cancel.$post({ param: { id: w.id } })),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  if (!s) return null;
  return (
    <>
      {deleting && <DeleteWorkspace workspace={w} onClose={() => setDeleting(false)} />}
      <Section
        title="Sign-in"
        intro="As its owner set it. Operators read these; the workspace changes them."
      >
        <Row name="Subdomain" inline>
          <span className="text-[13px] text-ink-2">{w.slug}</span>
        </Row>
        <Row
          name="Single sign-on"
          hint={s.sso?.enforced ? "The only way in for members other than owners." : undefined}
          inline
        >
          <span className="text-[13px] text-ink-2">{s.sso ? s.sso.protocol : "Not set up"}</span>
        </Row>
        <Row name="Directory" inline>
          <span className="text-[13px] text-ink-2">{s.directory ? "On" : "Off"}</span>
        </Row>
        <Row
          name="Second factor"
          hint={
            s.securityKeyForAdmins ? "Owners and admins sign in with a security key." : undefined
          }
          inline
        >
          <span className="text-[13px] text-ink-2">
            {secondFactorWords[s.secondFactor] ?? s.secondFactor}
          </span>
        </Row>
      </Section>
      <Section title="Guests">
        <Row name="Links last" inline>
          <span className="tabular text-[13px] text-ink-2">
            {s.guestLinkDays} {s.guestLinkDays === 1 ? "day" : "days"}
          </span>
        </Row>
        <Row name="Opening a link" inline>
          <span className="text-[13px] text-ink-2">
            {s.guestVerification === "code" ? "Asks for an emailed code" : "Opens by itself"}
          </span>
        </Row>
      </Section>
      {operator && (
        <Danger>
          <Row
            name={w.state === "suspended" ? "Reinstate" : "Suspend"}
            hint="Suspending keeps everything and lets nobody in."
          >
            {w.state === "suspended" ? (
              <Button variant="secondary" size="md" onClick={() => reinstate.mutate()}>
                Reinstate
              </Button>
            ) : (
              <Button variant="secondary" size="md" onClick={onSuspend}>
                Suspend…
              </Button>
            )}
          </Row>
          {w.deleteAfter ? (
            <Row
              name={`Deleted on ${since.format(new Date(w.deleteAfter))}`}
              hint="With everything in it. Until then, keeping it or reinstating it changes nothing."
            >
              <Button variant="secondary" size="md" onClick={() => keep.mutate()}>
                Keep it
              </Button>
            </Row>
          ) : (
            <Row
              name="Delete"
              hint={
                w.state === "suspended"
                  ? `${WORKSPACE_DELETE_GRACE_DAYS} days after you ask, with everything in it.`
                  : "Suspend it first; it is deleted after a grace period."
              }
            >
              <Button
                variant="ghost"
                size="md"
                disabled={w.state !== "suspended"}
                onClick={() => setDeleting(true)}
              >
                Delete…
              </Button>
            </Row>
          )}
          {error && (
            <p role="alert" className="m-0 px-4 py-3 text-[13px] text-signal">
              {error}
            </p>
          )}
        </Danger>
      )}
    </>
  );
}

function DeleteWorkspace({
  workspace,
  onClose,
}: {
  workspace: InstanceWorkspace;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: async () =>
      json(await api.instance.workspaces[":id"].delete.$post({ param: { id: workspace.id } })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["instance"] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    remove.mutate();
  };
  return (
    <Dialog
      title={`Delete ${workspace.name}`}
      description={`In ${WORKSPACE_DELETE_GRACE_DAYS} days its members, projects, files, reviews, keys and access log are deleted, and its stored files with them. Until then it stays suspended, and keeping it changes nothing.`}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form="delete-workspace"
            disabled={remove.isPending || name.trim() !== workspace.name}
          >
            Delete in {WORKSPACE_DELETE_GRACE_DAYS} days
          </Button>
        </>
      }
    >
      <form id="delete-workspace" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={`Type ${workspace.name} to confirm`} error={error}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Field>
      </form>
    </Dialog>
  );
}

function WorkspaceKeys({ id, operator }: { id: string; operator: boolean }) {
  const client = useQueryClient();
  const { data: k } = useQuery(instanceKeysQuery(id));
  const [error, setError] = useState<string | null>(null);
  const rotate = useMutation({
    mutationFn: async () =>
      json(await api.instance.workspaces[":id"].keys.rotate.$post({ param: { id } })),
    onSuccess: () => client.invalidateQueries({ queryKey: ["instance", "workspace", id, "keys"] }),
    onError: (e) => setError(e.message),
  });
  if (!k) return null;
  const latest = k.versions[0];
  return (
    <Section
      title="Keys"
      intro="The workspace’s key wraps the key of every file it holds, and is itself wrapped by the instance’s master key. Rotating it makes a new version and rewraps everything in the background; earlier versions are kept so nothing becomes unreadable."
    >
      <Row
        name="Workspace key"
        hint={
          latest
            ? [
                `Version ${latest.version}, made ${since.format(new Date(latest.createdAt))}`,
                k.pending > 0
                  ? `${k.pending} still wrapped by an earlier version, rewrapping`
                  : k.versions.length > 1
                    ? "everything rewrapped"
                    : null,
              ]
                .filter(Boolean)
                .join(" · ")
            : "Made when its first file is stored."
        }
      >
        {operator && latest && (
          <Button
            variant="secondary"
            size="md"
            disabled={rotate.isPending || k.pending > 0}
            onClick={() => rotate.mutate()}
          >
            Rotate
          </Button>
        )}
      </Row>
      {error && (
        <p role="alert" className="m-0 px-4 py-3 text-[13px] text-signal">
          {error}
        </p>
      )}
    </Section>
  );
}

/** A new workspace: a name, its subdomain, and its first owner, who is invited. */
function NewWorkspace({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** The invitation's link, when its mail could not be sent, to pass on by hand. */
  const [unsent, setUnsent] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: async () =>
      json<{ id: string; link: string; mailed: boolean }>(
        await api.instance.workspaces.$post({ json: { name, slug, ownerEmail } }),
      ),
    onSuccess: async ({ id, link, mailed }) => {
      await client.invalidateQueries({ queryKey: ["instance"] });
      onMade(id);
      if (mailed) onClose();
      else setUnsent(link);
    },
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    make.mutate();
  };
  if (unsent)
    return (
      <Dialog
        title={`${name} is made`}
        description="Its invitation could not be mailed. Pass this link to its first owner yourself: it works once, for a week."
        onClose={onClose}
        width="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void navigator.clipboard?.writeText(unsent)}
            >
              <Icon name="copy" size={13} />
              Copy the link
            </Button>
            <Button variant="primary" size="md" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <Field label="Invitation link">
          <Input value={unsent} readOnly onFocus={(e) => e.currentTarget.select()} />
        </Field>
      </Dialog>
    );
  return (
    <Dialog
      title="New workspace"
      description="A tenant of its own: members, projects, settings and keys. Its first owner is invited by email."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form="new-workspace"
            disabled={make.isPending}
          >
            Create
          </Button>
        </>
      }
    >
      <form id="new-workspace" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(slugFrom(e.target.value));
            }}
            placeholder="Lantern Pictures"
            required
            autoFocus
          />
        </Field>
        <Field label="Subdomain" hint="Lower-case letters, digits and hyphens.">
          <Input
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="lantern"
            required
          />
        </Field>
        <Field label="First owner’s email" error={error}>
          <Input
            type="email"
            value={ownerEmail}
            onChange={(e) => setOwnerEmail(e.target.value)}
            placeholder="owner@lantern.example"
            autoComplete="off"
            required
          />
        </Field>
      </form>
    </Dialog>
  );
}

const slugFrom = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");

function SuspendWorkspace({
  workspace,
  onClose,
}: {
  workspace: InstanceWorkspace;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suspend = useMutation({
    mutationFn: async () =>
      json(
        await api.instance.workspaces[":id"].suspend.$post({
          param: { id: workspace.id },
          json: { reason },
        }),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["instance"] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    suspend.mutate();
  };
  return (
    <Dialog
      title={`Suspend ${workspace.name}`}
      description="Everything is kept and nobody gets in: its members see the reason, and its guests’ links stop working, until you reinstate it."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form="suspend-workspace"
            disabled={suspend.isPending}
          >
            Suspend
          </Button>
        </>
      }
    >
      <form id="suspend-workspace" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Why" hint="Its members read this." error={error}>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="The invoice for October is unpaid."
            rows={3}
            maxLength={500}
            required
            autoFocus
          />
        </Field>
      </form>
    </Dialog>
  );
}

function Operators() {
  const client = useQueryClient();
  const { data: operators = [] } = useQuery(instanceOperatorsQuery);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["instance"] });
  const remove = useMutation({
    mutationFn: async (userId: string) =>
      json(await api.instance.operators[":userId"].$delete({ param: { userId } })),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  const revoke = useMutation({
    mutationFn: async (userId: string) =>
      json(await api.instance.operators[":userId"].sessions.revoke.$post({ param: { userId } })),
    onSuccess: refresh,
    onError: (e) => setError(e.message),
  });
  return (
    <>
      {adding && <AddOperator onClose={() => setAdding(false)} />}
      <Section
        title="Operators"
        intro="Accounts that may open this side of the application. They sign in with a passkey or hardware security key, and what they do is listed under their name."
        action={
          <Button variant="primary" size="md" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} />
            Operator
          </Button>
        }
      >
        {operators.map((o) => (
          <Row
            key={o.userId}
            name={
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                {o.name}
                <span className="truncate text-[12px] text-ink-3">{o.email}</span>
              </span>
            }
            hint={[
              o.hardwareKeys > 0
                ? `${o.hardwareKeys} hardware ${o.hardwareKeys === 1 ? "key" : "keys"}`
                : o.keys > 0
                  ? `${o.keys} ${o.keys === 1 ? "passkey" : "passkeys"}`
                  : "no passkey or security key",
              o.lastSignInAt ? `signed in ${ago(o.lastSignInAt)}` : "never signed in",
              `operator since ${since.format(new Date(o.since))}`,
              o.addedBy ? `added by ${o.addedBy}` : "since setup",
            ].join(" · ")}
            inline
          >
            <ActionMenu
              always
              label={o.name}
              actions={[
                { label: "Sign out everywhere", onSelect: () => revoke.mutate(o.userId) },
                "divider",
                {
                  label: "Remove as operator",
                  danger: true,
                  onSelect: () => remove.mutate(o.userId),
                },
              ]}
            />
          </Row>
        ))}
      </Section>
      {error && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {error}
        </p>
      )}
    </>
  );
}

function AddOperator({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async () => json(await api.instance.operators.$post({ json: { email } })),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["instance"] });
      onClose();
    },
    onError: (e) => setError(e.message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <Dialog
      title="Make someone an operator"
      description="They manage every workspace on this instance. They need an account here, and sign in with a passkey or hardware security key."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            type="submit"
            form="add-operator"
            disabled={add.isPending}
          >
            Make an operator
          </Button>
        </>
      }
    >
      <form id="add-operator" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Their email address" error={error}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
            autoFocus
          />
        </Field>
      </form>
    </Dialog>
  );
}
