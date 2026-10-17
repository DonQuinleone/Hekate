import {
  formatBytes,
  type InstanceAccess,
  type InstanceSection,
  type InstanceWorkspace,
  instanceActions,
  instanceSections,
  instanceSectionsFor,
} from "@hekate/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Stat } from "~/components/dashboard";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import {
  instanceAccessQuery,
  instanceOperatorsQuery,
  instanceOverviewQuery,
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
      {access.keyNeeded && current !== "workspaces" ? (
        <KeyNeeded />
      ) : (
        <>
          {current === "overview" && operatorView && <Overview />}
          {current === "workspaces" && <Workspaces access={access} />}
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

/** The workspaces this viewer may see, and the chosen one's figures; its tabs follow in #174. */
function Workspaces({ access }: { access: InstanceAccess }) {
  const { data: workspaces = [] } = useQuery(instanceWorkspacesQuery);
  const [q, setQ] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = workspaces.filter(
    (w) => !q || `${w.name} ${w.slug}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const current = shown.find((w) => w.id === chosen) ?? shown[0];
  return (
    <div className="flex flex-col gap-6 @3xl/app:flex-row @3xl/app:items-start">
      <div className="flex w-full shrink-0 flex-col gap-2 @3xl/app:w-[280px]">
        {(access.operator || workspaces.length > 6) && (
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a workspace"
            aria-label="Find a workspace"
          />
        )}
        <ul aria-label="Workspaces" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {shown.map((w) => (
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
                <span aria-hidden="true" className="size-[7px] shrink-0 rounded-full bg-ok" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{w.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {w.members} {w.members === 1 ? "person" : "people"} ·{" "}
                    {formatBytes(w.storageBytes)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {shown.length === 0 && (
          <p className="px-2.5 py-4 text-[13px] text-ink-3">
            {q ? "Nothing matches." : "No workspaces yet."}
          </p>
        )}
      </div>
      {current && <WorkspaceSummary workspace={current} />}
    </div>
  );
}

function WorkspaceSummary({ workspace }: { workspace: InstanceWorkspace }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6">
      <div className="min-w-0">
        <h2 className="m-0 truncate text-[20px] font-medium tracking-tight text-ink">
          {workspace.name}
        </h2>
        <p className="tabular m-0 text-[13px] text-ink-3">
          {workspace.slug} · since {since.format(new Date(workspace.createdAt))}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-3">
        <Stat label="People" value={workspace.members} hint="members" />
        <Stat label="Projects" value={workspace.projects} hint="active and archived" />
        <Stat
          label="Storage"
          value={formatBytes(workspace.storageBytes)}
          hint="before encryption"
        />
      </div>
    </div>
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
