import {
  type AuditLogRow,
  type AuthLogRow,
  type CheckState,
  channelKindLabels,
  ERROR_REPORT_DAYS,
  errorReportText,
  formatBytes,
  formatMoney,
  type GatewayLogRow,
  guestLinkDays,
  type HealthAmount,
  type HealthRange,
  type HealthService,
  type HealthStorage,
  type InstanceAccess,
  type InstanceEnvironment,
  type InstanceFlag,
  type InstanceMail,
  type InstanceMemberRow,
  type InstanceSection,
  type InstanceSettings,
  type InstanceWorkspace,
  type InstanceWorkspaceDetail,
  instanceActions,
  instanceSections,
  instanceSectionsFor,
  type LogKeepDays,
  type LogKind,
  type LogRange,
  logKeepDays,
  logKinds,
  logRanges,
  type MailLogRow,
  mailProviders,
  parseErrorReference,
  type UpdateChannel,
  updateChannels,
  type WebhookLogRow,
  WORKSPACE_DELETE_GRACE_DAYS,
  type WorkspaceState,
} from "@hekate/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  type FormEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { Gauge, Spark } from "~/components/charts";
import { Stat } from "~/components/dashboard";
import { Empty } from "~/components/empty";
import { SuppressionsDialog } from "~/components/event-channels";
import { Icon } from "~/components/icons";
import { Code, Fact, Inspect } from "~/components/inspect";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ConfirmStep } from "~/components/project-transfer";
import { Danger, Row, Section, SwitchRow } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { type ReviewState, StatusDot } from "~/components/ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { MemberLimitSelect, QuotaSelect, UsageRows } from "~/components/usage";
import { actionCopy } from "~/lib/access-log";
import { shortAgent } from "~/lib/agent";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { docsUrl } from "~/lib/links";
import { formatDates } from "~/lib/locale";
import {
  instanceAccessQuery,
  instanceErrorQuery,
  instanceErrorsQuery,
  instanceFlagsQuery,
  instanceHealthQuery,
  instanceKeysQuery,
  instanceLogQuery,
  instanceMembersQuery,
  instanceOperatorsQuery,
  instanceOverviewQuery,
  instanceOwnSettingsQuery,
  instanceProjectsQuery,
  instanceSettingsQuery,
  instanceStorageQuery,
  instanceSystemQuery,
  instanceWorkspaceQuery,
  instanceWorkspacesQuery,
  json,
  logQueryString,
  noticeQuery,
  useOperatorMove,
  useWorkspaceLimits,
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
          {current === "settings" && operatorView && <Settings />}
          {current === "health" && operatorView && <SystemHealthPage />}
          {current === "logs" && operatorView && <Logs />}
          {current === "system" && operatorView && <SystemInformation />}
          {current === "debug" && operatorView && <Debug />}
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
              {n.kind === "failed_jobs" && (
                <Button variant="secondary" size="md" asChild>
                  <Link to="/instance/$section" params={{ section: "debug" }}>
                    Debug tools
                  </Link>
                </Button>
              )}
              {n.kind === "release_available" && (
                <Button variant="secondary" size="md" asChild>
                  <Link to="/instance/$section" params={{ section: "system" }}>
                    System information
                  </Link>
                </Button>
              )}
              {n.kind === "quota_near" && (
                <Button variant="secondary" size="md" asChild>
                  <Link to="/instance/$section" params={{ section: "workspaces" }}>
                    Workspaces
                  </Link>
                </Button>
              )}
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

const clock = formatDates({ hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** When it failed: the time today, or the day before that. */
const failedAt = (at: string) => {
  const when = new Date(at);
  const today = since.format(new Date()) === since.format(when);
  return `${clock.format(when)} ${today ? "today" : `on ${since.format(when)}`}`;
};

/** Debug tools (#159): the story behind an error reference, and what failed in the last day. */
function Debug() {
  const [entered, setEntered] = useState("");
  const [reference, setReference] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [copied, setCopied] = useState(false);
  const found = useRef<HTMLDivElement>(null);
  const fromList = useRef(false);
  const [since] = useState(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const { data: errors } = useQuery(instanceErrorsQuery(since));
  const report = useQuery({ ...instanceErrorQuery(reference ?? ""), enabled: !!reference });
  // Running a job's failure again (#159): its file's preparation, or the job with its data.
  const retry = useMutation({
    mutationFn: async (reference: string) =>
      json<{ jobs: string[] }>(
        await api.instance.errors[":reference"].retry.$post({ param: { reference } }),
      ),
  });
  const lookUp = (value: string) => {
    const parsed = parseErrorReference(value);
    retry.reset();
    setInvalid(!parsed);
    setReference(parsed);
    setCopied(false);
    if (parsed) setEntered(parsed);
  };
  // Opened from the list below: bring the story into view.
  useEffect(() => {
    if (!report.data || !fromList.current) return;
    fromList.current = false;
    found.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [report.data]);
  const r = report.data;
  return (
    <>
      <Section
        title="Error reference"
        intro="When something fails, the person sees a reference. Paste it here for the whole story: who, where, the request, the job and the stack."
      >
        <div className="flex flex-col gap-3 px-4 py-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              lookUp(entered);
            }}
          >
            <Input
              value={entered}
              onChange={(e) => setEntered(e.target.value)}
              placeholder="HK-7F3A-2C"
              aria-label="Error reference"
              className="tabular w-64 min-w-0"
              autoFocus
            />
            <Button type="submit" variant="primary" size="md" disabled={!entered.trim()}>
              Look up
            </Button>
          </form>
          {invalid && (
            <p className="m-0 text-[13px] text-signal">
              That is not an error reference: they look like HK-7F3A-2C.
            </p>
          )}
          {report.isError && <p className="m-0 text-[13px] text-signal">{report.error.message}</p>}
          {reference && report.data === null && (
            <p className="m-0 text-[13px] text-ink-2">
              No report has {reference}. Reports are kept for {ERROR_REPORT_DAYS} days.
            </p>
          )}
          {r && (
            <div
              ref={found}
              className="flex scroll-mt-4 flex-col gap-3 rounded-panel border border-line bg-canvas/40 p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="tabular text-[16px] font-medium text-ink">{r.reference}</span>
                <span className="text-[13px] text-ink-3">{failedAt(r.occurredAt)}</span>
                <span className="text-[13px] text-ink-3">
                  {r.source} · {r.location}
                </span>
              </div>
              <p className="m-0 text-[14px] [overflow-wrap:anywhere] text-ink">{r.message}</p>
              <dl className="m-0 grid gap-x-6 gap-y-1 text-[13px] @3xl/app:grid-cols-2">
                <Fact term="Who">
                  {r.who
                    ? `${r.who.name} · ${r.who.email}`
                    : r.source === "worker"
                      ? "A job"
                      : "Nobody signed in"}
                </Fact>
                <Fact term="Workspace">{r.workspace ?? "None"}</Fact>
                {r.requestId && (
                  <Fact term="Request" tabular>
                    {r.requestId}
                  </Fact>
                )}
                {r.jobId && (
                  <Fact term="Job" tabular>
                    {r.jobId}
                  </Fact>
                )}
                {r.traceId && (
                  <Fact term="Trace" tabular>
                    {r.traceId}
                  </Fact>
                )}
                {r.status && (
                  <Fact term="Status" tabular>
                    {r.status}
                  </Fact>
                )}
              </dl>
              {r.context && (
                <Code label="The job's data">{JSON.stringify(r.context, null, 2)}</Code>
              )}
              {r.stack && <Code label="Stack">{r.stack}</Code>}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="md"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(errorReportText(r));
                    setCopied(true);
                  }}
                >
                  <Icon name="copy" size={13} />
                  {copied ? "Copied" : "Copy the report"}
                </Button>
                {r.source === "worker" && (
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={retry.isPending || retry.isSuccess}
                    onClick={() => retry.mutate(r.reference)}
                  >
                    {retry.isSuccess ? "Running again" : "Retry the job"}
                  </Button>
                )}
              </div>
              {retry.isError && (
                <p className="m-0 text-[13px] text-signal">{retry.error.message}</p>
              )}
            </div>
          )}
        </div>
      </Section>
      <Section title="Errors today" intro="Everything that failed in the last day, newest first.">
        {errors?.length === 0 ? (
          <Row name="Nothing" hint="Nothing has failed in the last day." />
        ) : (
          errors?.map((e) => (
            <Row
              key={e.reference}
              name={
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot state="changes_requested" />
                  <span className="tabular shrink-0">{e.reference}</span>
                  <span className="truncate text-ink-2">{e.message}</span>
                </span>
              }
              hint={`${clock.format(new Date(e.occurredAt))} · ${e.workspace ?? "No workspace"} · ${e.source} · ${e.location}`}
              inline
            >
              <Button
                variant="ghost"
                size="md"
                aria-label={`Open ${e.reference}`}
                onClick={() => {
                  fromList.current = true;
                  lookUp(e.reference);
                }}
              >
                Open
              </Button>
            </Row>
          ))
        )}
      </Section>
      <Inspect
        onReference={(reference) => {
          fromList.current = true;
          lookUp(reference);
        }}
      />
      <Replay />
      <Flags />
    </>
  );
}

/** One delivery in the webhook log: when, to which channel, which event, and what came of it. */
function WebhookEntry({ row: r, action }: { row: WebhookLogRow; action?: ReactNode }) {
  return (
    <div
      data-log-entry
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px]",
        action
          ? "@3xl/app:grid-cols-[150px_minmax(0,1fr)_170px_minmax(0,1fr)_120px_104px]"
          : "@3xl/app:grid-cols-[150px_minmax(0,1fr)_170px_minmax(0,1fr)_120px]",
      )}
    >
      <span className="tabular text-ink-3">{logTime.format(new Date(r.at))}</span>
      <span className="tabular justify-self-end text-ink-3 @3xl/app:order-5 @3xl/app:justify-self-end">
        {r.replay ? "Replay · " : ""}
        {r.attempts === 1 ? "1 attempt" : `${r.attempts} attempts`}
      </span>
      <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-2 @3xl/app:col-span-1">
        <span className="truncate text-ink-2">
          {channelKindLabels[r.channel.kind]} {r.channel.name}
        </span>
        <span className="truncate text-[12px] text-ink-3">{r.workspace.name}</span>
      </span>
      <span className="tabular col-span-2 truncate text-ink @3xl/app:order-3 @3xl/app:col-span-1">
        {r.event}
      </span>
      <span
        className={cn(
          "col-span-2 truncate @3xl/app:order-4 @3xl/app:col-span-1",
          r.status === "failed" || (r.status === "pending" && r.attempts > 0)
            ? "text-signal"
            : "text-ink-3",
        )}
        title={deliveryResult(r)}
      >
        {deliveryResult(r)}
      </span>
      {action && (
        <span className="col-span-2 @3xl/app:order-6 @3xl/app:col-span-1 @3xl/app:justify-self-end">
          {action}
        </span>
      )}
    </div>
  );
}

/** One event in the gateway log: when, for which workspace, what it was, and what came of it. */
function GatewayEntry({ row: r, action }: { row: GatewayLogRow; action?: ReactNode }) {
  const failed = r.result?.startsWith("failed") ?? false;
  return (
    <div
      data-log-entry
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px]",
        action
          ? "@3xl/app:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.4fr)_110px_minmax(0,1fr)_104px]"
          : "@3xl/app:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.4fr)_110px_minmax(0,1fr)]",
      )}
    >
      <span className="tabular text-ink-3">{logTime.format(new Date(r.at))}</span>
      <span className="tabular justify-self-end text-ink-2 @3xl/app:order-4">
        {r.amount === null || !r.currency ? "" : formatMoney(r.amount, r.currency)}
      </span>
      <span className="col-span-2 truncate text-ink-2 @3xl/app:order-2 @3xl/app:col-span-1">
        {r.workspace?.name ?? "Instance"}
      </span>
      <span className="tabular col-span-2 truncate text-ink @3xl/app:order-3 @3xl/app:col-span-1">
        {[r.event, r.summary].filter(Boolean).join(" · ")}
      </span>
      <span
        className={cn(
          "col-span-2 truncate @3xl/app:order-5 @3xl/app:col-span-1",
          failed ? "text-signal" : "text-ink-3",
        )}
        title={r.result ?? undefined}
      >
        {r.result ?? "Being taken"}
      </span>
      {action && (
        <span className="col-span-2 @3xl/app:order-6 @3xl/app:col-span-1 @3xl/app:justify-self-end">
          {action}
        </span>
      )}
    </div>
  );
}

/**
 * A past delivery sent again to its channel (#161): a new delivery of the same event, so a
 * receiver that kept it can tell. Chosen from the last week's deliveries.
 */
function Replay() {
  const [picking, setPicking] = useState<"delivery" | "gateway" | null>(null);
  const { data: own } = useQuery(instanceOwnSettingsQuery);
  const billing = own ? own.environment.modules.billing !== "off" : false;
  return (
    <Section title="Replay">
      <Row
        name="Replay a webhook"
        hint="Send a past delivery again to its channel, as the same event."
      >
        <Button variant="secondary" size="md" onClick={() => setPicking("delivery")}>
          Pick a delivery
        </Button>
      </Row>
      {billing && (
        <Row
          name="Take a gateway event again"
          hint="Act on a past event from the billing gateway again, read against how its subscription or invoice stands now."
        >
          <Button variant="secondary" size="md" onClick={() => setPicking("gateway")}>
            Pick an event
          </Button>
        </Row>
      )}
      {picking === "delivery" && <ReplayDialog onClose={() => setPicking(null)} />}
      {picking === "gateway" && <GatewayReplayDialog onClose={() => setPicking(null)} />}
    </Section>
  );
}

/** A gateway event taken again (#178), chosen from the last week's. */
function GatewayReplayDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const log = useInfiniteQuery(instanceLogQuery("gateway", { range: "7d" }));
  const [taken, setTaken] = useState<Map<string, string>>(new Map());
  const take = useMutation({
    mutationFn: async (id: string) =>
      json<{ result: string }>(
        await api.instance["gateway-events"][":id"].replay.$post({ param: { id } }),
      ),
    onSuccess: ({ result }, id) => {
      setTaken((t) => new Map(t).set(id, result));
      void client.invalidateQueries({ queryKey: ["instance", "logs", "gateway"] });
    },
  });
  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <Dialog
      title="Take a gateway event again"
      description="The last week's events, newest first. Each is read against its subscription or invoice as the gateway holds it now, so nothing that came after is undone."
      onClose={onClose}
      width="xl"
    >
      <div className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line">
        {log.isPending ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">Loading</p>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No events this week" text="The gateway has sent nothing." />
          </div>
        ) : (
          rows.map((r) => (
            <GatewayEntry
              key={r.id}
              row={taken.has(r.id) ? { ...r, result: taken.get(r.id) ?? r.result } : r}
              action={
                <Button
                  size="sm"
                  disabled={taken.has(r.id) || (take.isPending && take.variables === r.id)}
                  onClick={() => take.mutate(r.id)}
                >
                  {taken.has(r.id) ? "Taken" : "Take again"}
                </Button>
              }
            />
          ))
        )}
      </div>
      {take.isError && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {take.error.message}
        </p>
      )}
    </Dialog>
  );
}

function ReplayDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const log = useInfiniteQuery(instanceLogQuery("webhooks", { range: "7d" }));
  const [sent, setSent] = useState<Set<string>>(new Set());
  const replay = useMutation({
    mutationFn: async (id: string) =>
      json<{ delivery: string }>(
        await api.instance.deliveries[":id"].replay.$post({ param: { id } }),
      ),
    onSuccess: (_, id) => {
      setSent((s) => new Set(s).add(id));
      void client.invalidateQueries({ queryKey: ["instance", "logs", "webhooks"] });
    },
  });
  const rows = log.data?.pages.flatMap((p) => p.rows) ?? [];
  return (
    <Dialog
      title="Replay a webhook"
      description="The last week's deliveries, newest first. The channel gets the event again, with the same id."
      onClose={onClose}
      width="xl"
    >
      <div className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line">
        {log.isPending ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">Loading</p>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <Empty title="No deliveries this week" text="Nothing has been sent to a channel." />
          </div>
        ) : (
          rows.map((r) => (
            <WebhookEntry
              key={r.id}
              row={r}
              action={
                <Button
                  size="sm"
                  disabled={sent.has(r.id) || (replay.isPending && replay.variables === r.id)}
                  onClick={() => replay.mutate(r.id)}
                >
                  {sent.has(r.id) ? "Queued" : "Send again"}
                </Button>
              }
            />
          ))
        )}
      </div>
      {replay.isError && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {replay.error.message}
        </p>
      )}
    </Dialog>
  );
}

/** The instance's flags (#159): each takes effect within moments, with no restart. */
function Flags() {
  const client = useQueryClient();
  const { data: flags } = useQuery(instanceFlagsQuery);
  const turn = useMutation({
    mutationFn: async ({ key, on }: { key: InstanceFlag["key"]; on: boolean }) =>
      (
        await json<{ flags: InstanceFlag[] }>(
          await api.instance.flags[":key"].$put({ param: { key }, json: { on } }),
        )
      ).flags,
    onSuccess: (next) => client.setQueryData(instanceFlagsQuery.queryKey, next),
  });
  return (
    <Section
      title="Flags"
      intro="Switches for this instance, read as the server runs: each takes effect within moments, with no restart."
    >
      {flags?.map((f) => (
        <SwitchRow
          key={f.key}
          name={f.label}
          hint={
            f.on && f.until
              ? `${f.hint}. On until ${clock.format(new Date(f.until))}.`
              : `${f.hint}.`
          }
          checked={f.on}
          disabled={turn.isPending}
          onChange={(on) => turn.mutate({ key: f.key, on })}
        />
      ))}
      {turn.isError && <Row name="Not changed" hint={turn.error.message} />}
    </Section>
  );
}

/**
 * The instance's settings (#160), as the prototype has them: what an operator decides for every
 * workspace, each change recorded, beside what the environment sets, read-only.
 */
function Settings() {
  const client = useQueryClient();
  const { data, error } = useQuery(instanceOwnSettingsQuery);
  const [message, setMessage] = useState<string | null>(null);
  const [bounced, setBounced] = useState(false);
  const save = useMutation({
    mutationFn: async (next: InstanceSettings) =>
      json<{ settings: InstanceSettings; environment: InstanceEnvironment }>(
        await api.instance.settings.$put({ json: next }),
      ),
    onSuccess: (next) => {
      client.setQueryData(instanceOwnSettingsQuery.queryKey, next);
      void client.invalidateQueries({ queryKey: noticeQuery.queryKey });
    },
  });
  const mailTest = useMutation({
    mutationFn: async () =>
      json<{ to: string; mail: InstanceMail }>(await api.instance.settings["mail-test"].$post()),
  });
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return null;
  const { settings, environment: env } = data;
  const maintenance = settings.maintenance;
  const words = message ?? maintenance.message;
  const modules = env.modules;
  return (
    <>
      <Section
        title="Modules"
        intro="Set in the environment at start; shown here so an operator can see what is on."
      >
        <Row name="Billing" hint="HEKATE_BILLING · off, stripe, paddle or manual" inline>
          <span className="tabular text-[13px] text-ink-2">{modules.billing}</span>
          <StatusDot state={modules.billing === "off" ? "cancelled" : "approved"} />
        </Row>
        <Row name="Support desk" hint="HEKATE_SUPPORT · off, app, link or mail" inline>
          <span className="tabular text-[13px] text-ink-2">{modules.support}</span>
          <StatusDot state={modules.support === "off" ? "cancelled" : "approved"} />
        </Row>
        <Row name="Documentation" hint="HEKATE_DOCS_URL · where Help goes">
          <span className="truncate text-[13px] text-ink-2">{modules.docsUrl}</span>
        </Row>
        <Row name="Status page" hint="HEKATE_STATUS_URL · linked from Help when set">
          <span className="truncate text-[13px] text-ink-2">{modules.statusUrl ?? "None"}</span>
        </Row>
      </Section>
      <Section
        title="Security"
        intro="What every workspace must do, whatever its own settings say."
      >
        <SwitchRow
          name="Require a second factor for every account"
          hint={
            env.requireSecondFactor
              ? "On for the whole instance by REQUIRE_SECOND_FACTOR in the environment."
              : "A passkey, a security key or a code app. People without one are asked at their next sign-in."
          }
          checked={env.requireSecondFactor || settings.security.requireSecondFactor}
          disabled={env.requireSecondFactor || save.isPending}
          onChange={(on) =>
            save.mutate({
              ...settings,
              security: { ...settings.security, requireSecondFactor: on },
            })
          }
        />
        <Row
          name="Operators sign in with a passkey or security key"
          hint="OPERATOR_SECURITY_KEY in the environment."
          inline
        >
          <span className="text-[13px] text-ink-2">{env.operatorSecurityKey ? "On" : "Off"}</span>
        </Row>
        <Row name="Sessions end after" hint="Unused for that long, a session signs out." inline>
          <span className="tabular text-[13px] text-ink-2">{env.sessionDays} days</span>
        </Row>
        <Row
          name="Password rules"
          hint={
            env.passwordLeakCheck
              ? "Twelve characters or more, checked against known leaks."
              : "Twelve characters or more. PASSWORD_LEAK_CHECK turns on the check against known leaks."
          }
          inline
        >
          <span className="text-[13px] text-ink-2">
            12+{env.passwordLeakCheck ? " · leak check" : ""}
          </span>
        </Row>
      </Section>
      <Section
        title="Defaults for new workspaces"
        intro="What a workspace starts with when an operator makes it. Its owner may change how long guest links last; only an operator changes its limits."
      >
        <Row
          name="Guest links last"
          hint="How long a guest's link works before a new one is needed."
        >
          <Select
            aria-label="Guest links last"
            value={settings.defaults.guestLinkDays}
            disabled={save.isPending}
            onChange={(e) =>
              save.mutate({
                ...settings,
                defaults: {
                  ...settings.defaults,
                  guestLinkDays: Number(
                    e.target.value,
                  ) as InstanceSettings["defaults"]["guestLinkDays"],
                },
              })
            }
            className="w-40"
          >
            {guestLinkDays.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </Select>
        </Row>
        <Row
          name="Storage quota"
          hint="Uploads are refused at it; the workspace is warned from 90%."
        >
          <QuotaSelect
            value={settings.defaults.storageQuota}
            disabled={save.isPending}
            onChange={(storageQuota) =>
              save.mutate({ ...settings, defaults: { ...settings.defaults, storageQuota } })
            }
          />
        </Row>
        <Row name="Member limit" hint="Invitations waiting take a place too.">
          <MemberLimitSelect
            value={settings.defaults.memberLimit}
            disabled={save.isPending}
            onChange={(memberLimit) =>
              save.mutate({ ...settings, defaults: { ...settings.defaults, memberLimit } })
            }
          />
        </Row>
      </Section>
      <Section
        title="Logs"
        intro="How long each log keeps its rows; a job trims them once a day, and says what it trimmed."
      >
        {(
          [
            [
              "audit",
              "Audit",
              "Every action, operators' and in every workspace, downloads among them.",
            ],
            ["auth", "Authentication", "Every sign-in, refusal and lockout."],
            ["mail", "Email", "Every message handed to instance mail."],
            [
              "webhooks",
              "Webhooks",
              "Every event the workspaces' channels were sent, with each delivery.",
            ],
          ] as const
        ).map(([kind, name, hint]) => (
          <Row key={kind} name={name} hint={hint}>
            <Select
              aria-label={`Keep the ${name.toLowerCase()} log for`}
              value={settings.logs[kind] ?? ""}
              disabled={save.isPending}
              onChange={(e) =>
                save.mutate({
                  ...settings,
                  logs: {
                    ...settings.logs,
                    [kind]: e.target.value ? (Number(e.target.value) as LogKeepDays) : null,
                  },
                })
              }
              className="w-40"
            >
              {logKeepDays.map((d) => (
                <option key={d} value={d}>
                  {d === 365 ? "A year" : d === 730 ? "Two years" : `${d} days`}
                </option>
              ))}
              <option value="">For good</option>
            </Select>
          </Row>
        ))}
      </Section>
      <Section title="Address and mail" intro="Set in the environment at start.">
        <Row name="Address" hint="PUBLIC_URL" inline>
          <span className="truncate text-[13px] text-ink-2">{env.publicUrl}</span>
        </Row>
        <Row
          name="Workspace subdomains"
          hint={
            env.subdomains
              ? "WORKSPACE_SUBDOMAINS · each workspace answers at its own name; single sign-on reads the workspace from it."
              : "WORKSPACE_SUBDOMAINS · every workspace is at the address above."
          }
          inline
        >
          <span className="truncate text-[13px] text-ink-2">{env.subdomains ?? "Off"}</span>
        </Row>
        <Row name="Instance mail" hint={mailHints[env.mail]} inline>
          <span className="text-[13px] text-ink-2">{mailNames[env.mail]}</span>
          <Button
            variant="secondary"
            size="md"
            disabled={mailTest.isPending}
            onClick={() => mailTest.mutate()}
          >
            Test
          </Button>
        </Row>
        {mailTest.isSuccess && (
          <Row
            name="Sent"
            hint={
              mailTest.data.mail === "smtp"
                ? `A test message went to ${mailTest.data.to}. If it does not arrive, look in the mail server's log.`
                : `A test message to ${mailTest.data.to} was written to the server's log.`
            }
          />
        )}
        {mailTest.isError && <Row name="Not sent" hint={mailTest.error.message} />}
        {env.bounces && (
          <Row
            name="Bounce reports"
            hint={
              env.bounces.secretSet
                ? `${mailProviders[env.bounces.provider].label} reports to ${env.bounces.url}; mail stops going to addresses that bounce for good or complain.`
                : `Set MAIL_WEBHOOK_SECRET, then point ${mailProviders[env.bounces.provider].label}'s webhook at ${env.bounces.url}, so mail stops going to addresses that bounce.`
            }
          >
            <Button variant="secondary" size="md" onClick={() => setBounced(true)}>
              Bounced addresses…
            </Button>
          </Row>
        )}
      </Section>
      {bounced && <SuppressionsDialog scope="instance" onClose={() => setBounced(false)} />}
      <Danger>
        <Row
          name="Maintenance mode"
          hint={
            maintenance.on
              ? "On: everyone sees the notice, and uploads and jobs wait. Nothing is lost."
              : "Everyone sees a notice; uploads and jobs wait until it is over. Nothing is lost."
          }
        >
          <Button
            variant={maintenance.on ? "primary" : "secondary"}
            size="md"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({
                ...settings,
                maintenance: { on: !maintenance.on, message: words.trim() },
              })
            }
          >
            {maintenance.on ? "Turn off" : "Turn on"}
          </Button>
        </Row>
        <Row name="Notice" hint="Shown to everyone while it is on, beside that it is." stacked>
          <div className="flex w-full flex-col gap-2 @xl/app:flex-row">
            <Input
              aria-label="Maintenance notice"
              value={words}
              maxLength={280}
              placeholder="Back by 18:00"
              className="min-w-0 flex-1"
              onChange={(e) => setMessage(e.target.value)}
            />
            {maintenance.on && (
              <Button
                variant="secondary"
                size="md"
                disabled={save.isPending || words.trim() === maintenance.message}
                onClick={() =>
                  save.mutate({ ...settings, maintenance: { on: true, message: words.trim() } })
                }
              >
                Save notice
              </Button>
            )}
          </div>
        </Row>
        {save.isError && <Row name="Not changed" hint={save.error.message} />}
      </Danger>
    </>
  );
}

/**
 * System information (#158), as the prototype has it: the release running and its build, the
 * update channel, releases newer than this one, every release the instance has run, and what it
 * runs on. Every release is a new image; nothing is patched in place.
 */
function SystemInformation() {
  const client = useQueryClient();
  // A check asked for runs as a job: read again every few seconds until it has been done.
  const [checking, setChecking] = useState<{ since: string | null; until: number } | null>(null);
  const { data, error } = useQuery({
    ...instanceSystemQuery,
    refetchInterval: checking ? 3_000 : false,
  });
  useEffect(() => {
    if (!checking || !data) return;
    if (data.check.checkedAt !== checking.since || Date.now() > checking.until) setChecking(null);
  }, [checking, data]);
  const { data: own } = useQuery(instanceOwnSettingsQuery);
  const channel = useMutation({
    mutationFn: async (next: UpdateChannel) => {
      if (!own) throw new Error("The settings have not loaded yet");
      return json<{ settings: InstanceSettings; environment: InstanceEnvironment }>(
        await api.instance.settings.$put({
          json: { ...own.settings, updates: { channel: next } },
        }),
      );
    },
    onSuccess: (next) => {
      client.setQueryData(instanceOwnSettingsQuery.queryKey, next);
      void client.invalidateQueries({ queryKey: instanceSystemQuery.queryKey });
    },
  });
  const check = useMutation({
    mutationFn: async () => {
      const res = await api.instance.system.check.$post();
      if (!res.ok) await json(res);
    },
    // Until the last check's time changes, or two minutes pass (a held or busy worker).
    onSuccess: () =>
      setChecking({ since: data?.check.checkedAt ?? null, until: Date.now() + 120_000 }),
  });
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return null;
  const built = data.build === "dev" ? "A development build" : `Build ${data.build.slice(0, 12)}`;
  return (
    <>
      <Section title="This instance">
        <Row name="Version" hint={built} inline>
          <span className="tabular text-[13px] text-ink-2">{data.version}</span>
        </Row>
        <Row
          name="Update channel"
          hint="Stable offers releases; Beta offers their release candidates too."
        >
          <Select
            aria-label="Update channel"
            value={own?.settings.updates.channel ?? data.channel}
            disabled={!own || channel.isPending}
            onChange={(e) => channel.mutate(e.target.value as UpdateChannel)}
            className="w-36"
          >
            {updateChannels.map((c) => (
              <option key={c} value={c}>
                {c === "stable" ? "Stable" : "Beta"}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          name="Last check"
          hint={
            !data.check.on
              ? "Off: set HEKATE_UPDATE_CHECK=true to read the project's releases once a day. Nothing about the instance is sent."
              : data.check.failed
                ? `The last check failed: ${data.check.failed}`
                : "Once a day, from the project's public releases. Nothing about the instance is sent."
          }
        >
          {data.check.on && (
            <>
              <span className="text-[13px] text-ink-2">
                {data.check.checkedAt ? ago(data.check.checkedAt) : "Not yet"}
              </span>
              <Button
                variant="secondary"
                size="md"
                disabled={check.isPending || checking !== null}
                onClick={() => check.mutate()}
              >
                {checking ? "Checking" : "Check now"}
              </Button>
            </>
          )}
        </Row>
        {(channel.isError || check.isError) && (
          <Row name="Not done" hint={(channel.error ?? check.error)?.message} />
        )}
      </Section>
      <Section
        title="Available"
        intro="Every release is a new image: pull it and restart, and migrations run on start. Nothing is patched in place."
      >
        {data.available.length === 0 ? (
          <Row
            name={data.check.on ? "Up to date" : "Not checked"}
            hint={
              data.check.on
                ? `No release on the ${data.channel} channel is newer than ${data.version}.`
                : "Release checks are off."
            }
          />
        ) : (
          data.available.map((r) => (
            <Row
              key={r.version}
              name={
                <span className="flex items-center gap-2">
                  {r.name}
                  {r.prerelease && (
                    <span className="rounded-chip border border-line px-1.5 text-[11px] text-ink-3">
                      candidate
                    </span>
                  )}
                </span>
              }
              hint={`${since.format(new Date(r.publishedAt))}${r.notes ? ` · ${r.notes.split("\n")[0]}` : ""}`}
            >
              <Button variant="ghost" size="md" asChild>
                <a href={r.url} target="_blank" rel="noopener noreferrer">
                  Release notes
                </a>
              </Button>
              <Button variant="secondary" size="md" asChild>
                <a href={`${docsUrl}/operate/upgrades/`} target="_blank" rel="noopener noreferrer">
                  How to upgrade
                </a>
              </Button>
            </Row>
          ))
        )}
      </Section>
      <Section title="History" intro="Every release this instance has run.">
        {data.history.map((h) => (
          <Row
            key={h.version}
            name={<span className="tabular">{h.version}</span>}
            hint={`First started ${since.format(new Date(h.firstStartedAt))}`}
            inline
          />
        ))}
      </Section>
      <Section title="Environment">
        {data.environment.map((e) => (
          <Row key={e.name} name={e.name} inline>
            <span className="tabular text-[13px] text-ink-2">{e.value}</span>
          </Row>
        ))}
      </Section>
    </>
  );
}

const logTime = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const logLabels: Record<LogKind, string> = {
  audit: "Audit",
  auth: "Authentication",
  mail: "Email",
  webhooks: "Webhooks",
  gateway: "Gateway",
};
const rangeLabels: Record<LogRange, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};
const logNotes: Record<LogKind, string> = {
  audit:
    "Every action an operator took on the instance, and every change in a workspace with the files people downloaded. Streams and page renders stay in each workspace's access log.",
  auth: "Every sign-in, refusal and lockout, with the address and the browser. After four wrong passwords each try waits longer, and ten in fifteen minutes lock the account for fifteen.",
  mail: "Every message handed to instance mail, and what came back. Without SMTP, messages are written to the server's log.",
  webhooks:
    "Every delivery to a workspace's channels and its attempts. A channel that keeps failing pauses itself for five minutes; Debug tools send a delivery again.",
  gateway:
    "Every event from the billing gateway, with what it meant here: invoices, subscriptions, trials and payouts. Debug tools take one again.",
};
const deliveryStatusLabels: Record<WebhookLogRow["status"], string> = {
  pending: "Waiting",
  sending: "Sending",
  delivered: "Delivered",
  failed: "Given up",
  skipped: "Not sent",
};

/** What came of a delivery: its status, and what the receiver last said. */
const deliveryResult = (r: WebhookLogRow) =>
  [deliveryStatusLabels[r.status], r.result].filter(Boolean).join(" · ");
const authMethodLabels: Record<AuthLogRow["method"], string> = {
  password: "Password",
  passkey: "Passkey",
  second_factor: "Second factor",
  directory: "Directory",
  sso: "Single sign-on",
  guest_link: "Guest link",
  guest_code: "Guest code",
};

/** What came of a sign-in, in words, with why when it was refused. */
const authResult = (r: AuthLogRow) =>
  r.result === "signed_in"
    ? "Signed in"
    : `${r.result === "locked" ? "Locked" : "Refused"}${r.reason ? `: ${r.reason}` : ""}`;

const mailResults: Record<MailLogRow["result"], string> = {
  sent: "Sent",
  failed: "Refused",
  logged: "Written to the log",
  bounced: "Bounced",
  suppressed: "Not sent: it bounced before",
};

/** What an audit row did, in words: an operator's action, or a workspace's. */
const auditAction = (r: AuditLogRow) =>
  r.source === "instance"
    ? `${r.target ?? ""} ${instanceActions[r.action] ?? r.action}`.trim()
    : (actionCopy[r.action] ?? r.action);

/**
 * Logs (#157), as the prototype has them: what people and operators did, and the mail the
 * instance sent, as tables to search, narrow and export. More kinds arrive with what writes them.
 */
function Logs() {
  const [kind, setKind] = useState<LogKind>("audit");
  // The billing gateway's log only where billing is on (#178).
  const { data: own } = useQuery(instanceOwnSettingsQuery);
  const kinds = logKinds.filter(
    (k) => k !== "gateway" || (own && own.environment.modules.billing !== "off"),
  );
  const [q, setQ] = useState("");
  const search = useDeferredValue(q.trim());
  const [range, setRange] = useState<LogRange>("24h");
  const [workspace, setWorkspace] = useState("");
  const filters = {
    range,
    ...(search ? { q: search } : {}),
    ...(kind !== "mail" && workspace ? { workspace } : {}),
  };
  // Live: read again every few seconds, the newest arriving at the top.
  const [live, setLive] = useState(false);
  const log = useInfiniteQuery({
    ...instanceLogQuery(kind, filters),
    refetchInterval: live ? 5_000 : false,
  });
  // Every workspace, for the filter: the pages read one after another until there are no more.
  const workspaces = useInfiniteQuery(instanceWorkspacesQuery({}));
  useEffect(() => {
    if (workspaces.hasNextPage && !workspaces.isFetchingNextPage) void workspaces.fetchNextPage();
  }, [workspaces.hasNextPage, workspaces.isFetchingNextPage, workspaces.fetchNextPage]);
  const rows: (AuditLogRow | AuthLogRow | MailLogRow | WebhookLogRow | GatewayLogRow)[] =
    log.data?.pages.flatMap(
      (p): (AuditLogRow | AuthLogRow | MailLogRow | WebhookLogRow | GatewayLogRow)[] => p.rows,
    ) ?? [];
  const exportUrl = `/api/instance/logs/${kind}/export?${new URLSearchParams(logQueryString(filters))}`;
  const body = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          className="w-full @xl/app:w-64"
        />
        <Select
          aria-label="Range"
          value={range}
          onChange={(e) => setRange(e.target.value as LogRange)}
          className="w-40"
        >
          {logRanges.map((r) => (
            <option key={r} value={r}>
              {rangeLabels[r]}
            </option>
          ))}
        </Select>
        {kind !== "mail" && (
          <Select
            aria-label="Workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            className="w-48"
          >
            <option value="">Any workspace</option>
            {workspaces.data?.pages
              .flatMap((p) => p.workspaces)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
          </Select>
        )}
        <Button
          variant={live ? "primary" : "ghost"}
          size="md"
          aria-pressed={live}
          onClick={() => setLive((on) => !on)}
          className="ml-auto"
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full bg-current", !live && "opacity-50")}
          />
          Live
        </Button>
        <Button variant="secondary" size="md" asChild>
          <a href={exportUrl} download>
            <Icon name="download" size={14} />
            Export
          </a>
        </Button>
      </div>
      <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1">
        {log.isPending ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">Loading</p>
        ) : log.isError ? (
          <p className="m-0 px-4 py-3 text-[13px] text-signal">{log.error.message}</p>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <Empty
              title="Nothing in this range"
              text={search ? "Nothing matches the search." : "Try a longer range."}
            />
          </div>
        ) : kind === "audit" ? (
          (rows as AuditLogRow[]).map((r) => (
            <div
              key={r.id}
              data-log-entry
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] @3xl/app:grid-cols-[150px_minmax(0,1fr)_170px_minmax(0,1fr)] @6xl/app:grid-cols-[150px_minmax(0,1fr)_170px_minmax(0,1fr)_130px]"
            >
              <span className="tabular text-ink-3">{logTime.format(new Date(r.at))}</span>
              <span className="justify-self-end truncate text-ink-3 @3xl/app:order-3 @3xl/app:justify-self-start">
                {r.workspace?.name ?? "Instance"}
              </span>
              <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-2 @3xl/app:col-span-1">
                <span className="truncate text-ink-2">{r.who}</span>
              </span>
              <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-4 @3xl/app:col-span-1">
                <span className="truncate text-ink">{auditAction(r)}</span>
                {r.source === "workspace" && r.target && (
                  <span className="truncate text-[12px] text-ink-3">{r.target}</span>
                )}
              </span>
              <span className="tabular hidden truncate text-ink-3 @6xl/app:order-5 @6xl/app:block">
                {r.ipAddress ?? ""}
              </span>
            </div>
          ))
        ) : kind === "auth" ? (
          (rows as AuthLogRow[]).map((r) => (
            <div
              key={r.id}
              data-log-entry
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] @3xl/app:grid-cols-[150px_minmax(0,1fr)_130px_minmax(0,1fr)] @6xl/app:grid-cols-[150px_minmax(0,1fr)_130px_minmax(0,1fr)_200px]"
            >
              <span className="tabular text-ink-3">{logTime.format(new Date(r.at))}</span>
              <span className="justify-self-end text-ink-3 @3xl/app:order-3 @3xl/app:justify-self-start">
                {authMethodLabels[r.method]}
              </span>
              <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-2 @3xl/app:col-span-1">
                <span className="truncate text-ink-2">{r.account}</span>
                {r.workspace && (
                  <span className="truncate text-[12px] text-ink-3">{r.workspace.name}</span>
                )}
              </span>
              <span
                className={cn(
                  "col-span-2 truncate @3xl/app:order-4 @3xl/app:col-span-1",
                  r.result === "signed_in" ? "text-ink" : "text-signal",
                )}
                title={authResult(r)}
              >
                {authResult(r)}
              </span>
              <span className="tabular hidden truncate text-ink-3 @6xl/app:order-5 @6xl/app:block">
                {[r.ipAddress, shortAgent(r.userAgent)].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))
        ) : kind === "webhooks" ? (
          (rows as WebhookLogRow[]).map((r) => <WebhookEntry key={r.id} row={r} />)
        ) : kind === "gateway" ? (
          (rows as GatewayLogRow[]).map((r) => <GatewayEntry key={r.id} row={r} />)
        ) : (
          (rows as MailLogRow[]).map((r) => (
            <div
              key={r.id}
              data-log-entry
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] @3xl/app:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.4fr)_150px]"
            >
              <span className="tabular text-ink-3">{logTime.format(new Date(r.at))}</span>
              <span
                className={cn(
                  "justify-self-end @3xl/app:order-4 @3xl/app:justify-self-start",
                  r.result === "failed" || r.result === "bounced" ? "text-signal" : "text-ink-3",
                )}
              >
                {mailResults[r.result]}
              </span>
              <span className="col-span-2 truncate text-ink-2 @3xl/app:order-2 @3xl/app:col-span-1">
                {r.to}
              </span>
              <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-3 @3xl/app:col-span-1">
                <span className="truncate text-ink">{r.subject}</span>
                {r.error && (
                  <span className="truncate text-[12px] text-signal" title={r.error}>
                    {r.error}
                  </span>
                )}
              </span>
            </div>
          ))
        )}
        {log.hasNextPage && (
          <div className="px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        )}
      </div>
      <p className="m-0 text-[12px] text-ink-3">{logNotes[kind]}</p>
    </>
  );
  return (
    <Tabs value={kind} onValueChange={(v) => setKind(v as LogKind)}>
      <TabsList>
        {kinds.map((k) => (
          <TabsTrigger key={k} value={k}>
            {logLabels[k]}
          </TabsTrigger>
        ))}
      </TabsList>
      {kinds.map((k) => (
        <TabsContent key={k} value={k} className="mt-4 flex flex-col gap-4">
          {k === kind && body}
        </TabsContent>
      ))}
    </Tabs>
  );
}

const serviceNames: Record<HealthService["name"], string> = {
  api: "API",
  database: "Database",
  worker: "Worker",
  mail: "Mail",
};

const serviceDot: Record<CheckState, ReviewState> = {
  ok: "approved",
  failed: "changes_requested",
  stale: "changes_requested",
  off: "cancelled",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const share = (a: HealthAmount | null) => (a && a.total > 0 ? a.used / a.total : null);
const percent = (v: number | null) => (v === null ? "…" : `${Math.round(v * 100)}%`);
const amount = (a: HealthAmount | null) =>
  a ? `${formatBytes(a.used)} of ${formatBytes(a.total)}` : "Could not be read";
const figure = (v: number) =>
  Number.isInteger(v) || v >= 100 ? Math.round(v).toLocaleString("en-GB") : v.toFixed(1);

/** What a service's row says of it. */
function serviceHint(s: HealthService): string {
  switch (s.name) {
    case "api":
      return `${
        s.p95Seconds === null
          ? "Nothing asked in the last hour"
          : `p95 ${Math.round(s.p95Seconds * 1000)} ms in the slowest minute of the last hour`
      } · ${plural(s.replicas, "replica")}`;
    case "database":
      if (s.state !== "ok") return "Not answering";
      return [
        s.version && `PostgreSQL ${s.version}`,
        s.bytes !== null && formatBytes(s.bytes),
        s.connections && `${s.connections.used} of ${s.connections.total} connections`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "worker":
      if (s.state === "stale")
        return "No job finished in the last ten minutes: is a worker running?";
      if (s.state === "failed") return "Its queue could not be read";
      return `ffmpeg ${s.ffmpeg ?? "unknown"} · ${plural(s.lanes.total, "lane")} · ${s.lanes.used} busy`;
    case "mail":
      return s.state === "ok"
        ? "SMTP: the mail server answers"
        : s.state === "failed"
          ? "SMTP: the mail server does not answer"
          : "Off: messages go to the server's log";
  }
}

/** The last instance-wide run, and what runs found that is still open. */
function reconciliationHint({ last, runningSince, open }: HealthStorage["reconciliation"]): string {
  const run = [
    runningSince && `Running since ${ago(runningSince)}`,
    last ? `last finished ${ago(last.finishedAt)}` : !runningSince && "not run yet",
  ]
    .filter(Boolean)
    .join("; ");
  const found = [
    open.missingObjects > 0 && `${plural(open.missingObjects, "missing object")}`,
    open.orphanObjects > 0 && `${plural(open.orphanObjects, "object")} nothing claims`,
    open.unreferencedBlobs > 0 && `${plural(open.unreferencedBlobs, "record")} nothing uses`,
  ].filter(Boolean);
  return `Every backend against the database, each night. ${run.charAt(0).toUpperCase()}${run.slice(1)}; ${
    found.length ? found.join(", ") : "nothing found"
  }.`;
}

/**
 * System health (#156), as the prototype has it: the machine now, the last hour or day from the
 * minutes each process measures (kept a day), the services, and every metric Prometheus reads.
 * Read again every 15 seconds.
 */
function SystemHealthPage() {
  const [range, setRange] = useState<HealthRange>("24h");
  const { data, error, dataUpdatedAt } = useQuery({
    ...instanceHealthQuery(range),
    placeholderData: keepPreviousData,
  });
  const client = useQueryClient();
  const reconcile = useMutation({
    mutationFn: async () => {
      const res = await api.instance.health.reconcile.$post();
      if (!res.ok) await json(res);
    },
    // Read again soon after, so the run shows under way.
    onSuccess: () =>
      setTimeout(() => void client.invalidateQueries({ queryKey: ["instance", "health"] }), 3_000),
  });
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return null;
  const { now, series } = data;
  const when = (i: number) => {
    const minutes = (series.requestsPerMinute.length - 1 - i) * series.step;
    if (minutes === 0) return "now";
    return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
  };
  const refreshed = Math.max(0, Math.round((clock - dataUpdatedAt) / 1000));
  return (
    <>
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="eyebrow m-0">Now</h2>
          <span className="tabular text-[12px] text-ink-3">refreshed {refreshed} s ago</span>
        </div>
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-4">
          <Gauge
            label="CPU"
            value={now.cpu?.share ?? null}
            text={percent(now.cpu?.share ?? null)}
            hint={
              now.cpu
                ? `${plural(now.cpu.cores, "core")} · ${plural(now.lanes.used, "lane")} busy`
                : "Measured after the first minute"
            }
          />
          <Gauge
            label="Memory"
            value={share(now.memory)}
            text={percent(share(now.memory))}
            hint={amount(now.memory)}
          />
          <Gauge
            label="Disk"
            value={share(now.disk)}
            text={percent(share(now.disk))}
            hint={amount(now.disk)}
          />
          <Gauge
            label="Database connections"
            value={share(now.connections)}
            text={now.connections ? String(now.connections.used) : "…"}
            hint={now.connections ? `of ${now.connections.total}` : "Could not be read"}
          />
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="eyebrow m-0">{range === "1h" ? "The last hour" : "The last 24 hours"}</h2>
          <Select
            aria-label="Range"
            value={range}
            onChange={(e) => setRange(e.target.value as HealthRange)}
            className="h-7 w-36 text-[12px]"
          >
            <option value="1h">Last hour</option>
            <option value="24h">Last 24 hours</option>
          </Select>
        </div>
        <div className="grid gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-3">
          <Spark
            label="Requests per minute"
            points={series.requestsPerMinute}
            format={figure}
            when={when}
            hint="hekate_http_requests_total"
          />
          <Spark
            label="p95 latency"
            points={series.p95Ms}
            format={(v) => `${Math.round(v)} ms`}
            when={when}
            hint="hekate_http_request_duration_seconds"
          />
          <Spark
            label="Error rate"
            points={series.errorRate}
            format={(v) => `${v.toFixed(v < 1 ? 2 : 1)}%`}
            when={when}
            hint="hekate_http_errors_total / requests"
          />
          <Spark
            label="Queue depth"
            points={series.jobsWaiting}
            format={figure}
            when={when}
            hint="hekate_jobs_waiting"
          />
          <Spark
            label="Worker lanes busy"
            points={series.lanesBusy}
            format={figure}
            when={when}
            max={series.lanes}
            hint={`hekate_worker_lanes_busy of ${series.lanes}`}
          />
          <Spark
            label="Uploads"
            points={series.uploadBytesPerHour}
            format={(v) => `${formatBytes(Math.round(v))}/h`}
            when={when}
            hint="hekate_uploads_bytes_total"
          />
        </div>
      </section>
      <Section title="Services" intro="Every part of the machine, checked every 15 seconds.">
        {data.services.map((s) => (
          <Row key={s.name} name={serviceNames[s.name]} hint={serviceHint(s)} inline>
            <StatusDot state={serviceDot[s.state]} />
          </Row>
        ))}
      </Section>
      <Section
        title="Storage"
        intro="Every object is encrypted with its own key before it is written; a backend only ever holds ciphertext."
      >
        {data.storage.backends.map((b) => (
          <Row
            key={b.name}
            name={b.name}
            hint={
              // A path or bucket has no spaces to break at: on a phone it breaks anywhere.
              <span className="[overflow-wrap:anywhere]">
                {[
                  b.where,
                  b.isDefault && "new objects",
                  `${formatBytes(b.storedBytes)} stored`,
                  b.disk && `disk ${amount(b.disk)}`,
                  b.state !== "ok" && "not answering",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            }
          >
            {b.disk && (
              <span className="flex w-56 items-center gap-3">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      // As the Disk gauge: signal once it is nearly full.
                      (share(b.disk) ?? 0) >= 0.85 ? "bg-signal" : "bg-node-review",
                    )}
                    style={{ width: `${(share(b.disk) ?? 0) * 100}%` }}
                  />
                </span>
                <span className="tabular w-9 text-right text-[12px] text-ink-3">
                  {percent(share(b.disk))}
                </span>
              </span>
            )}
            <StatusDot state={serviceDot[b.state]} />
          </Row>
        ))}
        <Row
          name="Master key"
          hint={`Set in the environment; wraps ${plural(data.storage.masterKey.workspaceKeys, "workspace key")}.${
            data.storage.masterKey.previous > 0
              ? ` ${plural(data.storage.masterKey.previous, "earlier key")} still configured: once the server has started with the new one, remove MASTER_KEYS_PREVIOUS.`
              : ""
          }`}
        >
          <Button variant="secondary" size="md" asChild>
            <a href={`${docsUrl}/operate/keys/`} target="_blank" rel="noopener noreferrer">
              How to rotate
            </a>
          </Button>
        </Row>
        <Row name="Reconciliation" hint={reconciliationHint(data.storage.reconciliation)}>
          <Button
            variant="ghost"
            size="md"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            Run now
          </Button>
        </Row>
        {reconcile.isSuccess && (
          <Row name="Asked" hint="It runs in the background; this page shows it under way." />
        )}
        {reconcile.isError && <Row name="Not run" hint={reconcile.error.message} />}
      </Section>
      <Section
        title="Metrics"
        intro="Everything above, and more, is exported for Prometheus at /metrics, read with the bearer token in METRICS_TOKEN. Grafana dashboards ship in the repository."
      >
        {data.metrics.map((m) => (
          <Row
            key={m.name}
            name={<span className="tabular text-[13px]">{m.name}</span>}
            hint={m.help}
          >
            <span className="text-[12px] text-ink-3">
              {m.type}
              {m.labels.length > 0 && ` · ${m.labels.join(", ")}`}
            </span>
          </Row>
        ))}
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
          <WorkspaceProjects id={id} operator={operator} />
        </TabsContent>
        <TabsContent value="storage" className="flex flex-col gap-6 pt-6">
          <WorkspaceStorage id={id} operator={operator} />
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

/**
 * An operator moves a project to another workspace (#240), without the approval and acceptance
 * its members would need, confirmed with its name and their own password.
 */
function OperatorMove({
  from,
  project,
  onClose,
}: {
  from: string;
  project: { id: string; name: string };
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const found = useInfiniteQuery(instanceWorkspacesQuery({ q: useDeferredValue(q) }));
  const options = (found.data?.pages.flatMap((p) => p.workspaces) ?? []).filter(
    (w) => w.id !== from && w.state === "active",
  );
  const [to, setTo] = useState("");
  const chosen = options.find((w) => w.id === to) ?? options[0] ?? null;
  const move = useOperatorMove(from);
  return (
    <ConfirmStep
      title={`Move ${project.name} to another workspace?`}
      description="It moves at once, without its members' approval or the other workspace's acceptance. Both workspaces' logs and owners hear of it, and members who are not in the other workspace lose their place in it."
      projectName={project.name}
      action="Move now"
      pending={move.isPending}
      error={move.error}
      onClose={onClose}
      onConfirm={(input) =>
        chosen &&
        move.mutate({ projectId: project.id, to: chosen.id, ...input }, { onSuccess: onClose })
      }
    >
      <Field label="Find the workspace">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or address" />
      </Field>
      <Field label="Move it to">
        <Select
          value={chosen?.id ?? ""}
          onChange={(e) => setTo(e.target.value)}
          disabled={options.length === 0}
        >
          {options.length === 0 && <option value="">No workspace matches</option>}
          {options.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.slug})
            </option>
          ))}
        </Select>
      </Field>
    </ConfirmStep>
  );
}

function WorkspaceProjects({ id, operator }: { id: string; operator: boolean }) {
  const { data: projects, isSuccess } = useQuery(instanceProjectsQuery(id));
  const [moving, setMoving] = useState<{ id: string; name: string } | null>(null);
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
          <span className="flex items-center gap-2">
            <span className="text-[12px] text-ink-3">{p.archived ? "archived" : "active"}</span>
            {operator && (
              <ActionMenu
                label={p.name}
                actions={[
                  {
                    label: "Move to another workspace…",
                    onSelect: () => setMoving({ id: p.id, name: p.name }),
                  },
                ]}
              />
            )}
          </span>
        </Row>
      ))}
      {moving && <OperatorMove from={id} project={moving} onClose={() => setMoving(null)} />}
    </Section>
  );
}

function WorkspaceStorage({ id, operator }: { id: string; operator: boolean }) {
  const { data: s } = useQuery(instanceStorageQuery(id));
  const setLimits = useWorkspaceLimits(id);
  if (!s) return null;
  const { limits } = s.usage;
  return (
    <>
      <Section
        title="Quota"
        intro="Uploads are refused at the storage quota and invitations at the member limit; the workspace is warned from 90%. Lowering one removes nothing."
      >
        <UsageRows usage={s.usage} />
        {operator && (
          <>
            <Row name="Storage quota" inline>
              <QuotaSelect
                value={limits.storageQuota}
                disabled={setLimits.isPending}
                onChange={(storageQuota) => setLimits.mutate({ ...limits, storageQuota })}
              />
            </Row>
            <Row name="Member limit" inline>
              <MemberLimitSelect
                value={limits.memberLimit}
                disabled={setLimits.isPending}
                onChange={(memberLimit) => setLimits.mutate({ ...limits, memberLimit })}
              />
            </Row>
          </>
        )}
        {setLimits.error && (
          <p role="alert" className="m-0 px-4 py-2 text-[13px] text-signal">
            {setLimits.error.message}
          </p>
        )}
      </Section>
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

/** How instance mail goes out (#71), named, and the settings that say so. */
const mailNames: Record<InstanceMail, string> = {
  smtp: "SMTP",
  microsoft: "Microsoft 365",
  mailcoach: "Mailcoach",
  log: "Log only",
};
const mailHints: Record<InstanceMail, string> = {
  smtp: "Sent over SMTP (SMTP_URL).",
  microsoft: "Sent through Microsoft Graph as the sender's mailbox (MAIL_GRAPH_*).",
  mailcoach: "Sent through Mailcoach's transactional API (MAIL_MAILCOACH_*).",
  log: "Written to the server's log: set SMTP_URL, or a provider's settings, to send it.",
};
