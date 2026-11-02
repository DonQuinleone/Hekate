import {
  type BillingWorkspaceRow,
  currencyPlaces,
  featureNames,
  formatBytes,
  formatMoney,
  minorUnits,
  monthlyAmount,
  type Plan,
  type PlanFeature,
  type PlanInput,
  type PromoCode,
  type PromoCodeInput,
  planFeatures,
  planSummary,
  promoRefusal,
  promoSummary,
  type SupportSeverity,
  supportSeverities,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Icon } from "~/components/icons";
import { Failed, Loading } from "~/components/ui/states";
import { formatDates } from "~/lib/locale";
import {
  instanceBillingQuery,
  instanceOwnSettingsQuery,
  instancePlansQuery,
  instancePromosQuery,
  promoUsesQuery,
  useApplyPromo,
  useEndPromo,
  useIssueCredit,
  usePutWorkspacePlan,
  useRetirePlan,
  useSavePlan,
  useSavePromo,
  useSendLatestInvoice,
  useWaive,
} from "~/lib/queries";
import { TileGrid } from "./billing";
import { Gateways } from "./instance-billing-gateways";
import { Reports } from "./instance-billing-reports";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Choice, ChoiceCard } from "./ui/choice";
import { DateField } from "./ui/date-field";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select, Textarea } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { type ReviewState, StatusDot } from "./ui/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { MemberLimitSelect, QuotaSelect } from "./usage";

/**
 * The instance's Billing section (#180), as the prototype has it: what the workspaces pay and
 * owe, the plans they can be on, and the promo codes. The operators', with billing on.
 */

const shortDate = formatDates({ day: "numeric", month: "short" });
const longDate = formatDates({ day: "numeric", month: "long" });
const fullDate = formatDates({ day: "numeric", month: "short", year: "numeric" });
const day = 86_400_000;
const daysSince = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / day));
const daysUntil = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / day));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const per = { month: "a month", year: "a year" } as const;
const priceWords = (price: Plan["price"]) =>
  price ? `${formatMoney(price.amount, price.currency)} ${per[price.interval]}` : "by agreement";

const severityNames: Record<SupportSeverity, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
  emergency: "Emergency",
};

/** The instance's currency (#180), which new prices start in. */
const useInstanceCurrency = () =>
  useQuery(instanceOwnSettingsQuery).data?.settings.billing.currency ?? "GBP";

type BillingTab = "overview" | "plans" | "promos" | "gateways" | "reports";

export function InstanceBilling() {
  const [tab, setTab] = useState<BillingTab>("overview");
  // Read now, so the editors start in the instance's currency.
  useQuery(instanceOwnSettingsQuery);
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as BillingTab)}>
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="plans">Plans</TabsTrigger>
        <TabsTrigger value="promos">Promo codes</TabsTrigger>
        <TabsTrigger value="gateways">Gateways</TabsTrigger>
        <TabsTrigger value="reports">Reports</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="flex flex-col gap-6 pt-6">
        <Overview />
      </TabsContent>
      <TabsContent value="plans" className="flex flex-col gap-6 pt-6">
        <Plans />
      </TabsContent>
      <TabsContent value="promos" className="flex flex-col gap-6 pt-6">
        <Promos />
      </TabsContent>
      <TabsContent value="gateways" className="flex flex-col gap-6 pt-6">
        <Gateways />
      </TabsContent>
      <TabsContent value="reports" className="flex flex-col gap-6 pt-6">
        <Reports />
      </TabsContent>
    </Tabs>
  );
}

/** What the workspaces pay, who is on trial, who owes, and each workspace's next invoice. */
function Overview() {
  const { data, error, refetch } = useQuery(instanceBillingQuery);
  const [changing, setChanging] = useState<BillingWorkspaceRow | null>(null);
  const [waiving, setWaiving] = useState<BillingWorkspaceRow | null>(null);
  const [applying, setApplying] = useState<BillingWorkspaceRow | null>(null);
  const [crediting, setCrediting] = useState<BillingWorkspaceRow | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  if (error) return <Failed what="Billing" error={error} retry={refetch} />;
  if (!data) return <Loading />;
  const [main, ...others] = data.revenue;
  const { trials, overdue, nextPayout } = data;
  return (
    <>
      <TileGrid
        tiles={[
          {
            label: "Monthly revenue",
            value: main ? formatMoney(main.amount, main.currency) : formatMoney(0, "GBP"),
            hint:
              others.length > 0
                ? `and ${others.map((o) => formatMoney(o.amount, o.currency)).join(", ")}`
                : [
                    plural(data.paying, "workspace"),
                    data.custom > 0 ? `${data.custom} custom` : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
          },
          {
            label: "On trial",
            value: String(trials.count),
            hint: trials.soonestEnd
              ? `converts in ${plural(daysUntil(trials.soonestEnd), "day")}`
              : "none converting",
          },
          {
            label: "Overdue",
            value: String(overdue.count),
            hint: overdue.longest
              ? `${overdue.longest.name} · ${plural(daysSince(overdue.longest.since), "day")}`
              : "nothing owed",
            flag: overdue.count > 0,
          },
          { label: "Failed payments", value: String(data.failedPayments), hint: "this month" },
          {
            label: "Next payout",
            value: nextPayout ? formatMoney(nextPayout.amount, nextPayout.currency) : "None",
            hint: nextPayout
              ? `${shortDate.format(new Date(nextPayout.arrivesAt))} · Stripe`
              : data.gateway
                ? "none due"
                : "invoices by hand",
          },
        ]}
      />
      <Section
        title="Workspaces"
        intro="Each with its plan, its next invoice and anything overdue."
      >
        {notice && (
          <p
            role={notice.failed ? "alert" : "status"}
            className={`m-0 px-4 py-3 text-[13px] ${notice.failed ? "text-signal" : "text-ink-2"}`}
          >
            {notice.text}
          </p>
        )}
        {data.workspaces.length === 0 ? (
          <Row name="No workspaces yet" hint="Each appears here with its plan once it is made." />
        ) : (
          data.workspaces.map((w) => (
            <WorkspaceRow
              key={w.id}
              workspace={w}
              gateway={data.gateway !== null}
              onChangePlan={() => setChanging(w)}
              onApplyPromo={() => setApplying(w)}
              onCredit={() => setCrediting(w)}
              onSent={setNotice}
              onWaive={() => setWaiving(w)}
            />
          ))
        )}
      </Section>
      {changing && <ChangeWorkspacePlan workspace={changing} onClose={() => setChanging(null)} />}
      {applying && (
        <ApplyPromo
          workspace={applying}
          onClose={() => setApplying(null)}
          onApplied={(text) => setNotice({ text })}
        />
      )}
      {crediting && (
        <IssueCredit
          workspace={crediting}
          onClose={() => setCrediting(null)}
          onIssued={(text) => setNotice({ text })}
        />
      )}
      {waiving && <Waive workspace={waiving} onClose={() => setWaiving(null)} />}
    </>
  );
}

const owes = (w: BillingWorkspaceRow) => Boolean(w.pastDueSince || w.overdue || w.dunningSuspended);

/** A workspace's standing as its dot shows it: owing in signal, on trial open, paying filled. */
function dotOf(w: BillingWorkspaceRow): ReviewState {
  if (owes(w)) return "changes_requested";
  if (w.status === "trial") return "in_review";
  if (!w.plan || w.status === "cancelled") return "cancelled";
  return "approved";
}

/** Its plan and what comes next, in a line, with any credit held for its next invoice by hand. */
export function workspaceBillingLine(w: BillingWorkspaceRow): string {
  return [
    standingOf(w),
    ...w.credits.map((c) => `${formatMoney(c.amount, c.currency)} credit held`),
  ].join(" · ");
}

function standingOf(w: BillingWorkspaceRow): string {
  const plan = w.plan?.name ?? "No plan";
  if (owes(w)) {
    const since = w.pastDueSince ?? w.overdue?.dueAt;
    const what = w.overdue?.number ?? "A payment";
    return [
      plan,
      since ? `${what} overdue ${plural(daysSince(since), "day")}` : "owing",
      w.dunningSuspended ? "suspended" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  if (!w.plan) return "No plan · everything included";
  if (w.status === "trial")
    return w.trialEndsAt
      ? `${plan} trial · converts ${longDate.format(new Date(w.trialEndsAt))}`
      : `${plan} trial`;
  if (w.cancelsAt) return `${plan} · ends ${longDate.format(new Date(w.cancelsAt))}`;
  if (w.status === "cancelled") return `${plan} · cancelled`;
  if (w.renewsAt) return `${plan} · next invoice ${longDate.format(new Date(w.renewsAt))}`;
  return w.price ? plan : `${plan} · invoiced by hand`;
}

/**
 * What an operator can do for a workspace (#445), only what applies: a code needs a subscription
 * on a priced plan, a credit goes to the gateway's balance or the next invoice by hand, and only
 * the gateway's invoices are sent from here.
 */
export function workspaceActionsOf(w: BillingWorkspaceRow, gateway: boolean) {
  const paysThroughGateway = gateway && w.subscribed;
  return {
    promo: paysThroughGateway && w.price !== null,
    credit: paysThroughGateway || (!w.subscribed && w.plan !== null),
    send: w.latestInvoice !== null,
    waive: owes(w),
  };
}

function WorkspaceRow({
  workspace: w,
  gateway,
  onChangePlan,
  onApplyPromo,
  onCredit,
  onSent,
  onWaive,
}: {
  workspace: BillingWorkspaceRow;
  gateway: boolean;
  onChangePlan: () => void;
  onApplyPromo: () => void;
  onCredit: () => void;
  onSent: (notice: { text: string; failed?: boolean }) => void;
  onWaive: () => void;
}) {
  const send = useSendLatestInvoice(w.id);
  const can = workspaceActionsOf(w, gateway);
  const sendLatest = () =>
    send.mutate(undefined, {
      onSuccess: ({ number, sent }) =>
        onSent({
          text: `${number ?? "The latest invoice"} is on its way to ${plural(sent, "owner")} of ${w.name}.`,
        }),
      onError: (error) => onSent({ text: error.message, failed: true }),
    });
  return (
    <Row
      name={
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot state={dotOf(w)} />
          <span className="truncate">{w.name}</span>
        </span>
      }
      hint={workspaceBillingLine(w)}
      inline
    >
      {w.price && (
        <span className="tabular hidden text-[13px] text-ink-2 @3xl/app:inline">
          {formatMoney(w.price.amount, w.price.currency)}
        </span>
      )}
      <ActionMenu
        always
        label={w.name}
        actions={[
          { label: "Change plan…", onSelect: onChangePlan },
          ...(can.promo ? [{ label: "Apply a promo code…", onSelect: onApplyPromo }] : []),
          ...(can.credit ? [{ label: "Issue a credit…", onSelect: onCredit }] : []),
          ...(can.send ? [{ label: "Send the latest invoice", onSelect: sendLatest }] : []),
          ...(can.waive
            ? ["divider" as const, { label: "Waive and reinstate…", onSelect: onWaive }]
            : []),
        ]}
      />
    </Row>
  );
}

/** An operator puts a workspace on another plan, hidden ones included. */
function ChangeWorkspacePlan({
  workspace: w,
  onClose,
}: {
  workspace: BillingWorkspaceRow;
  onClose: () => void;
}) {
  const { data } = useQuery(instancePlansQuery);
  const put = usePutWorkspacePlan(w.id);
  const plans = byPrice((data?.plans ?? []).filter((p) => !p.retiredAt));
  const [planId, setPlanId] = useState<string>(w.plan?.id ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    put.mutate({ planId: planId || null }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title="Change plan"
      description={
        w.subscribed
          ? `${w.name} pays through Stripe: its subscription moves too, the difference pro-rated.`
          : `${w.name} takes the plan's limits at once.`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="workspace-plan"
            disabled={put.isPending || planId === (w.plan?.id ?? "")}
          >
            Change plan
          </Button>
        </>
      }
    >
      <form id="workspace-plan" onSubmit={submit} className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Plan" className="flex flex-col gap-2">
          {plans.map((p) => (
            <ChoiceCard
              key={p.id}
              name="plan"
              value={p.id}
              checked={planId === p.id}
              onChange={() => setPlanId(p.id)}
              title={
                <>
                  {p.name}
                  <span className="tabular text-[12px] font-normal text-ink-3">
                    {priceWords(p.price)}
                  </span>
                  {p.hidden && <span className="text-[11px] font-normal text-ink-3">hidden</span>}
                  {/* Told apart from a choice by its word, not its highlight alone (#694). */}
                  {p.id === w.plan?.id && (
                    <span className="text-[11px] font-normal text-ink-2">Current</span>
                  )}
                </>
              }
              hint={planSummary(p, formatBytes)}
            />
          ))}
          {!w.subscribed && (
            <ChoiceCard
              name="plan"
              value=""
              checked={planId === ""}
              onChange={() => setPlanId("")}
              title={
                <>
                  No plan
                  {!w.plan && <span className="text-[11px] font-normal text-ink-2">Current</span>}
                </>
              }
              hint="Nothing limited, everything included, nothing charged."
            />
          )}
        </div>
        {put.isError && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {put.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * An operator applies one of the instance's codes to a workspace's subscription (#445): the
 * codes that apply to its plan now, as choices, since the operators keep them.
 */
function ApplyPromo({
  workspace: w,
  onClose,
  onApplied,
}: {
  workspace: BillingWorkspaceRow;
  onClose: () => void;
  onApplied: (notice: string) => void;
}) {
  const { data } = useQuery(instancePromosQuery);
  const apply = useApplyPromo(w.id);
  const [code, setCode] = useState("");
  const plan = w.plan;
  const currency = w.price?.currency ?? "";
  const now = new Date();
  const codes = (data?.promos ?? []).filter(
    (p) => plan && promoRefusal(p, { planId: plan.id, currency, now }) === null,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    apply.mutate(code, {
      onSuccess: (applied) => {
        onApplied(`${applied.code} now applies to the subscription of ${w.name}.`);
        onClose();
      },
    });
  };
  return (
    <Dialog
      title="Apply a promo code"
      description={`Its subscription to ${plan?.name ?? "its plan"} takes the code's discount from its next invoice, and the code counts a use.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="workspace-promo"
            disabled={!code || apply.isPending}
          >
            Apply code
          </Button>
        </>
      }
    >
      <form id="workspace-promo" onSubmit={submit} className="flex flex-col gap-3">
        {!data ? null : codes.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-2">
            None of the instance's codes applies to {plan?.name ?? "its plan"} now. Add one under
            Promo codes.
          </p>
        ) : (
          <div role="radiogroup" aria-label="Code" className="flex flex-col gap-2">
            {codes.map((p) => (
              <ChoiceCard
                key={p.id}
                name="code"
                value={p.code}
                checked={code === p.code}
                onChange={() => setCode(p.code)}
                title={<span className="tabular">{p.code}</span>}
                hint={promoSummary(p, (iso) => fullDate.format(new Date(iso)))}
              />
            ))}
          </div>
        )}
        {apply.isError && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {apply.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/**
 * A credit toward what a workspace next owes (#445): Stripe takes it off the next invoice of one
 * paying through it, in the currency it bills; the next invoice by hand takes it off otherwise.
 */
function IssueCredit({
  workspace: w,
  onClose,
  onIssued,
}: {
  workspace: BillingWorkspaceRow;
  onClose: () => void;
  onIssued: (notice: string) => void;
}) {
  const issue = useIssueCredit(w.id);
  const instanceCurrency = useInstanceCurrency();
  const [amount, setAmount] = useState("");
  // In the currency the workspace is billed in, or the instance's, set under Gateways (#694).
  const currency = w.price?.currency ?? instanceCurrency;
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const minor = minorUnits(amount, currency);
    if (!minor) return setProblem(`An amount in ${currency}, such as 20.00`);
    setProblem(null);
    issue.mutate(
      { amount: minor, currency, reason },
      {
        onSuccess: ({ credit }) => {
          const money = formatMoney(credit.amount, credit.currency);
          onIssued(
            credit.source === "manual"
              ? `${money} comes off the next invoice by hand for ${w.name}.`
              : `${money} is credited to ${w.name} at Stripe, for its next invoice.`,
          );
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      title="Issue a credit"
      description={
        w.subscribed
          ? `Stripe takes it off the next invoice for ${w.name}.`
          : `It comes off the next invoice made by hand for ${w.name}, as a line of its own.`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="workspace-credit"
            disabled={!amount.trim() || !reason.trim() || issue.isPending}
          >
            Issue credit
          </Button>
        </>
      }
    >
      <form id="workspace-credit" onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-3">
          <Field label={`Amount in ${currency}`} className="w-36">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="tabular"
              autoFocus
            />
          </Field>
        </div>
        <Field
          label="Why"
          hint={
            w.subscribed
              ? "Kept with the instance's events, and given to Stripe as its description."
              : "Kept with the instance's events."
          }
        >
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
        {(problem || issue.isError) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {problem ?? issue.error?.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Letting a workspace off what it owes, and opening it again if dunning suspended it. */
function Waive({ workspace: w, onClose }: { workspace: BillingWorkspaceRow; onClose: () => void }) {
  const waive = useWaive(w.id);
  // What is let off, named in the dialog and on its button (#694).
  const owed = (w.owed ?? []).map((o) => formatMoney(o.amount, o.currency)).join(" and ");
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    waive.mutate(reason, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={owed ? `Waive ${owed} for ${w.name}?` : `Waive what ${w.name} owes?`}
      description={
        w.subscribed
          ? "Its open invoices are voided, at Stripe too, and nothing more is collected on them."
          : "Its open invoices are voided, and nothing more is collected on them."
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            type="submit"
            form="waive"
            disabled={!reason.trim() || waive.isPending}
          >
            {[owed ? `Waive ${owed}` : "Waive", w.dunningSuspended && "and reinstate"]
              .filter(Boolean)
              .join(" ")}
          </Button>
        </>
      }
    >
      <form id="waive" onSubmit={submit} className="flex flex-col gap-3">
        <p className="m-0 text-[13px] text-ink-2">
          {w.dunningSuspended
            ? "Dunning ends, and the workspace opens again at once. "
            : w.pastDueSince
              ? "Dunning ends, so its owners are warned no more. "
              : ""}
          Its plan carries on as before.
        </p>
        <Field label="Why" hint="Kept with the instance's events.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
        {waive.isError && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {waive.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** The plans workspaces can be on: their prices, limits and what they include. */
function Plans() {
  const { data, error, refetch } = useQuery(instancePlansQuery);
  const save = useSavePlan();
  const retire = useRetirePlan();
  const [editing, setEditing] = useState<{ plan: Plan | null; copy?: boolean } | null>(null);
  const [retiring, setRetiring] = useState<Plan | null>(null);
  if (error) return <Failed what="The plans" error={error} retry={refetch} />;
  if (!data) return <Loading />;
  const plans = byPrice(data.plans.filter((p) => !p.retiredAt));
  const retired = data.plans.filter((p) => p.retiredAt);
  const toggleHidden = (p: Plan) =>
    save.mutate({ id: p.id, input: { ...inputOf(p), hidden: !p.hidden } });
  return (
    <>
      <Section
        intro="What workspaces can be on. Prices, limits and which support severities each unlocks are the instance's to set."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing({ plan: null })}>
            <Icon name="plus" size={14} />
            New plan
          </Button>
        }
      >
        {plans.length === 0 ? (
          <Row
            name="No plans yet"
            hint="Add one, and workspaces can choose it from their Billing settings."
          />
        ) : (
          plans.map((p) => (
            <Row
              key={p.id}
              name={
                <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                  {p.name}
                  <span className="tabular text-[12px] text-ink-3">{priceWords(p.price)}</span>
                  {p.hidden && <span className="text-[12px] text-ink-3">hidden</span>}
                </span>
              }
              hint={planLine(p)}
              inline
            >
              <ActionMenu
                always
                label={p.name}
                actions={[
                  { label: "Edit limits and price…", onSelect: () => setEditing({ plan: p }) },
                  { label: "Duplicate…", onSelect: () => setEditing({ plan: p, copy: true }) },
                  {
                    label: p.hidden ? "Offer to new sign-ups" : "Hide from new sign-ups",
                    onSelect: () => toggleHidden(p),
                  },
                  "divider",
                  { label: "Retire…", danger: true, onSelect: () => setRetiring(p) },
                ]}
              />
            </Row>
          ))
        )}
      </Section>
      {save.isError && !editing && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {save.error.message}
        </p>
      )}
      {retired.length > 0 && (
        <Section
          title="Retired"
          intro="Nobody is put on these again; those on them stay until moved."
        >
          {retired.map((p) => (
            <Row
              key={p.id}
              name={
                <span className="flex items-center gap-2">
                  {p.name}
                  <span className="tabular text-[12px] text-ink-3">{priceWords(p.price)}</span>
                </span>
              }
              hint={`Retired ${fullDate.format(new Date(p.retiredAt ?? ""))} · ${plural(p.workspaces, "workspace")}`}
            />
          ))}
        </Section>
      )}
      {editing && (
        <PlanEditor
          plan={editing.plan}
          copy={editing.copy ?? false}
          onClose={() => setEditing(null)}
        />
      )}
      {retiring && (
        <Dialog
          title={`Retire ${retiring.name}?`}
          description="Nobody is put on it again, and it cannot be brought back."
          width="sm"
          onClose={() => setRetiring(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setRetiring(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={retire.isPending}
                onClick={() => retire.mutate(retiring.id, { onSuccess: () => setRetiring(null) })}
              >
                Retire
              </Button>
            </>
          }
        >
          <p className="m-0 text-[13px] text-ink-2">
            {retiring.workspaces > 0
              ? `The ${plural(retiring.workspaces, "workspace")} on it stay on it, at its price, until moved to another plan.`
              : "No workspace is on it."}
          </p>
          {retire.isError && (
            <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
              {retire.error.message}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}

/** Cheapest first, as a price list reads; plans by agreement last. */
const byPrice = (plans: Plan[]) =>
  [...plans].sort(
    (a, b) =>
      (a.price ? monthlyAmount(a.price) : Number.POSITIVE_INFINITY) -
        (b.price ? monthlyAmount(b.price) : Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );

/** An amount in the currency's minor unit as it is typed: `49.00`, `4900` for yen. */
const typedAmount = (amount: number, currency: string) => {
  const places = currencyPlaces(currency);
  return (amount / 10 ** places).toFixed(places);
};

/** A plan's limits, what it includes and who is on it, in a line. */
function planLine(p: Plan): string {
  const highest = [...p.severities].sort(
    (a, b) => supportSeverities.indexOf(b) - supportSeverities.indexOf(a),
  )[0];
  return [
    planSummary(p, formatBytes),
    highest ? `support up to ${severityNames[highest]}` : "no support requests",
    p.workspaces === 0 ? "no workspaces yet" : plural(p.workspaces, "workspace"),
  ].join(" · ");
}

const inputOf = (p: Plan): PlanInput => ({
  key: p.key,
  name: p.name,
  price: p.price,
  storageQuota: p.storageQuota,
  memberLimit: p.memberLimit,
  projectLimit: p.projectLimit,
  features: p.features,
  severities: p.severities,
  hidden: p.hidden,
});

const keyFrom = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

/** The project limits a plan offers, and whatever is set now. */
const projectLimits = [1, 3, 5, 10, 25, 50, 100] as const;
function ProjectLimitSelect({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const offered: number[] = [...projectLimits];
  if (value !== null && !offered.includes(value)) offered.push(value);
  return (
    <Select
      aria-label="Project limit"
      value={value === null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
      className="w-40"
    >
      {offered
        .sort((a, b) => a - b)
        .map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      <option value="">No limit</option>
    </Select>
  );
}

/** Adding a plan, or changing one: its name, price, limits and what it includes. */
function PlanEditor({
  plan,
  copy,
  onClose,
}: {
  plan: Plan | null;
  copy: boolean;
  onClose: () => void;
}) {
  const save = useSavePlan();
  const editing = plan && !copy ? plan : null;
  const [name, setName] = useState(plan ? (copy ? `${plan.name} copy` : plan.name) : "");
  const [key, setKey] = useState(plan ? (copy ? `${plan.key}-copy`.slice(0, 32) : plan.key) : "");
  const [keyTouched, setKeyTouched] = useState(Boolean(plan));
  const [priced, setPriced] = useState(plan ? plan.price !== null : true);
  const instanceCurrency = useInstanceCurrency();
  // The instance's currency, set under Gateways (#694); a plan priced in another keeps it.
  const currency = plan?.price?.currency ?? instanceCurrency;
  const [amount, setAmount] = useState(
    plan?.price ? typedAmount(plan.price.amount, plan.price.currency) : "",
  );
  const [interval, setInterval] = useState<"month" | "year">(plan?.price?.interval ?? "month");
  const [storageQuota, setStorageQuota] = useState<number | null>(plan?.storageQuota ?? null);
  const [memberLimit, setMemberLimit] = useState<number | null>(plan?.memberLimit ?? null);
  const [projectLimit, setProjectLimit] = useState<number | null>(plan?.projectLimit ?? null);
  const [features, setFeatures] = useState<PlanFeature[]>(plan?.features ?? []);
  const [severities, setSeverities] = useState<SupportSeverity[]>(
    plan?.severities ?? ["low", "normal"],
  );
  const [hidden, setHidden] = useState(plan?.hidden ?? false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = <T,>(list: T[], item: T) =>
    list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const minor = priced ? minorUnits(amount, currency) : null;
    if (priced && minor === null) return setProblem(`A price in ${currency}, such as 49.00`);
    setProblem(null);
    save.mutate(
      {
        id: editing?.id,
        input: {
          key,
          name,
          price: priced && minor !== null ? { amount: minor, currency, interval } : null,
          storageQuota,
          memberLimit,
          projectLimit,
          features: planFeatures.filter((f) => features.includes(f)),
          severities: supportSeverities.filter((s) => severities.includes(s)),
          hidden,
        },
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      title={editing ? `Edit ${editing.name}` : "New plan"}
      description={
        editing && editing.workspaces > 0
          ? `Its ${plural(editing.workspaces, "workspace")} take the new limits at once; a new price applies from their next invoice.`
          : "Workspaces choose it from their Billing settings, unless it is hidden."
      }
      width="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="plan-editor"
            disabled={!name.trim() || !key || save.isPending}
          >
            {editing ? "Save plan" : "Add plan"}
          </Button>
        </>
      }
    >
      <form id="plan-editor" onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 @3xl/app:grid-cols-2">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(keyFrom(e.target.value));
              }}
              autoFocus
            />
          </Field>
          <Field label="Key" hint="Short and stable, for the gateway and reports.">
            <Input
              value={key}
              onChange={(e) => {
                setKeyTouched(true);
                setKey(e.target.value.toLowerCase());
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </div>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] text-ink-2">Price</legend>
          <div className="flex flex-col gap-2">
            <Choice type="radio" name="priced" checked={priced} onChange={() => setPriced(true)}>
              Fixed price
            </Choice>
            <Choice
              type="radio"
              name="priced"
              checked={!priced}
              onChange={() => setPriced(false)}
              hint="Invoiced by hand; workspaces cannot choose it themselves."
            >
              By agreement
            </Choice>
          </div>
          {priced && (
            <div className="flex flex-wrap gap-3">
              <Field
                label={`Amount in ${currency}`}
                hint="The currency is the instance's, set under Gateways."
                className="w-56"
              >
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="tabular"
                />
              </Field>
              <Field label="Every" className="w-32">
                <Select
                  value={interval}
                  onChange={(e) => setInterval(e.target.value as "month" | "year")}
                >
                  <option value="month">Month</option>
                  <option value="year">Year</option>
                </Select>
              </Field>
            </div>
          )}
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <Field label="Storage">
            <QuotaSelect value={storageQuota} onChange={setStorageQuota} />
          </Field>
          <Field label="Members">
            <MemberLimitSelect value={memberLimit} onChange={setMemberLimit} />
          </Field>
          {/* A select like the other limits (#694). */}
          <Field label="Projects">
            <ProjectLimitSelect value={projectLimit} onChange={setProjectLimit} />
          </Field>
        </div>
        <div className="grid gap-4 @3xl/app:grid-cols-2">
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] text-ink-2">Includes</legend>
            {planFeatures.map((f) => (
              <Choice
                key={f}
                checked={features.includes(f)}
                onChange={() => setFeatures(toggle(features, f))}
              >
                {featureNames[f]}
              </Choice>
            ))}
          </fieldset>
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] text-ink-2">Support requests marked</legend>
            {supportSeverities.map((s) => (
              <Choice
                key={s}
                checked={severities.includes(s)}
                onChange={() => setSeverities(toggle(severities, s))}
              >
                {severityNames[s]}
              </Choice>
            ))}
          </fieldset>
        </div>
        <Choice
          checked={hidden}
          onChange={() => setHidden(!hidden)}
          hint="Kept from workspaces' choices; only operators put a workspace on it."
        >
          Hide from new sign-ups
        </Choice>
        {(problem || save.isError) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {problem ?? save.error?.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** A code's state as its dot shows it: live filled, ended or used up dashed. */
const promoLive = (p: PromoCode) =>
  !p.endedAt &&
  !(p.until && new Date(p.until) <= new Date()) &&
  !(p.maxUses !== null && p.uses >= p.maxUses);

/** The promo codes: a percentage or an amount off, for some months, for the first so many. */
function Promos() {
  const { data, error, refetch } = useQuery(instancePromosQuery);
  const plans = useQuery(instancePlansQuery).data?.plans ?? [];
  const end = useEndPromo();
  const [editing, setEditing] = useState<{ promo: PromoCode | null } | null>(null);
  const [uses, setUses] = useState<PromoCode | null>(null);
  const [ending, setEnding] = useState<PromoCode | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (error) return <Failed what="The promo codes" error={error} retry={refetch} />;
  if (!data) return <Loading />;
  const nameOf = new Map(plans.map((p) => [p.id, p.name]));
  const forPlans = (p: PromoCode) =>
    p.planIds.length === 0
      ? "any plan"
      : p.planIds.map((id) => nameOf.get(id) ?? "a plan gone").join(" and ");
  return (
    <>
      <Section
        intro="A percentage or an amount off, for a number of months, for the first so many who use it, until a date."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing({ promo: null })}>
            <Icon name="plus" size={14} />
            New code
          </Button>
        }
      >
        {data.promos.length === 0 ? (
          <Row
            name="No codes yet"
            hint="Add one, and owners can give it when they choose a plan."
          />
        ) : (
          data.promos.map((p) => (
            <Row
              key={p.id}
              name={
                <span className="flex items-center gap-2">
                  <StatusDot state={promoLive(p) ? "approved" : "cancelled"} />
                  <span className="tabular">{p.code}</span>
                  {copied === p.id && (
                    <span role="status" className="text-[12px] text-ink-3">
                      Copied
                    </span>
                  )}
                </span>
              }
              hint={`${promoSummary(p, (iso) => fullDate.format(new Date(iso)))} · ${forPlans(p)}`}
              inline
            >
              <ActionMenu
                always
                label={p.code}
                actions={[
                  {
                    label: "Copy the code",
                    onSelect: () =>
                      void navigator.clipboard?.writeText(p.code).then(() => {
                        setCopied(p.id);
                        setTimeout(() => setCopied(null), 1500);
                      }),
                  },
                  { label: "Edit…", onSelect: () => setEditing({ promo: p }) },
                  { label: "Who used it", onSelect: () => setUses(p) },
                  ...(p.endedAt
                    ? []
                    : [
                        "divider" as const,
                        { label: "End now…", danger: true, onSelect: () => setEnding(p) },
                      ]),
                ]}
              />
            </Row>
          ))
        )}
      </Section>
      {editing && (
        <PromoEditor promo={editing.promo} plans={plans} onClose={() => setEditing(null)} />
      )}
      {uses && <PromoUses promo={uses} onClose={() => setUses(null)} />}
      {ending && (
        <Dialog
          title={`End ${ending.code} now?`}
          description="Nobody can use it again. Subscriptions that have it keep their discount."
          width="sm"
          onClose={() => setEnding(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setEnding(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={end.isPending}
                onClick={() => end.mutate(ending.id, { onSuccess: () => setEnding(null) })}
              >
                End now
              </Button>
            </>
          }
        >
          <p className="m-0 text-[13px] text-ink-2">
            {ending.uses > 0
              ? `Its ${plural(ending.uses, "use")} so far stand; a checkout already open with it may still be paid with it.`
              : "Nobody has used it yet."}
          </p>
          {end.isError && (
            <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
              {end.error.message}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}

const isoDay = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

/** Adding a code, or changing one: the change applies to its uses from now. */
function PromoEditor({
  promo,
  plans,
  onClose,
}: {
  promo: PromoCode | null;
  plans: Plan[];
  onClose: () => void;
}) {
  const save = useSavePromo();
  const [code, setCode] = useState(promo?.code ?? "");
  const [kind, setKind] = useState<"percent" | "amount">(
    promo?.amountOff !== null && promo?.amountOff !== undefined ? "amount" : "percent",
  );
  const [percent, setPercent] = useState(promo?.percentOff ? String(promo.percentOff) : "");
  const instanceCurrency = useInstanceCurrency();
  // The instance's currency, set under Gateways (#694); a code made in another keeps it.
  const currency = promo?.currency ?? instanceCurrency;
  const [amount, setAmount] = useState(
    promo?.amountOff && promo.currency ? typedAmount(promo.amountOff, promo.currency) : "",
  );
  const [months, setMonths] = useState(promo?.months ? String(promo.months) : "");
  const [maxUses, setMaxUses] = useState(promo?.maxUses ? String(promo.maxUses) : "");
  const [until, setUntil] = useState(isoDay(promo?.until ?? null));
  const [planIds, setPlanIds] = useState<string[]>(promo?.planIds ?? []);
  const [problem, setProblem] = useState<string | null>(null);
  const whole = (typed: string) => (typed.trim() ? Number(typed) : null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const amountOff = kind === "amount" ? minorUnits(amount, currency) : null;
    if (kind === "amount" && amountOff === null)
      return setProblem(`An amount in ${currency}, such as 20.00`);
    const input: PromoCodeInput = {
      code,
      percentOff: kind === "percent" ? whole(percent) : null,
      amountOff,
      currency: kind === "amount" ? currency : null,
      months: whole(months),
      maxUses: whole(maxUses),
      // The end of the day chosen, in the operator's own time.
      until: until ? new Date(`${until}T23:59:59`).toISOString() : null,
      planIds,
    };
    setProblem(null);
    save.mutate({ id: promo?.id, input }, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={promo ? `Edit ${promo.code}` : "New promo code"}
      description={
        promo && promo.uses > 0
          ? "A change applies to its uses from now; subscriptions that have it keep what they were given."
          : "Owners give it when they choose a plan."
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="promo-editor"
            disabled={!code.trim() || save.isPending}
          >
            {promo ? "Save code" : "Add code"}
          </Button>
        </>
      }
    >
      <form id="promo-editor" onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Code" hint="Letters, digits and hyphens, as people type it.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoComplete="off"
            spellCheck={false}
            className="tabular w-56 uppercase"
            autoFocus
          />
        </Field>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-2 p-0 text-[13px] text-ink-2">Off</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Choice
              type="radio"
              name="off"
              checked={kind === "percent"}
              onChange={() => setKind("percent")}
            >
              A percentage
            </Choice>
            <Choice
              type="radio"
              name="off"
              checked={kind === "amount"}
              onChange={() => setKind("amount")}
            >
              An amount
            </Choice>
          </div>
          {kind === "percent" ? (
            <Field label="Percent" className="w-28">
              <Input
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
                inputMode="numeric"
                className="tabular"
              />
            </Field>
          ) : (
            <Field label={`Amount in ${currency}`} className="w-36">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                className="tabular"
              />
            </Field>
          )}
        </fieldset>
        <div className="flex flex-wrap gap-3">
          <Field label="For months" hint="Empty for as long as it lasts." className="w-40">
            <Input
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              inputMode="numeric"
              className="tabular"
            />
          </Field>
          <Field label="Uses" hint="Empty for no limit." className="w-32">
            <Input
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              inputMode="numeric"
              className="tabular"
            />
          </Field>
          <Field label="Until" hint="Empty for no end." className="w-44">
            <DateField value={until} onChange={setUntil} />
          </Field>
        </div>
        {plans.length > 0 && (
          <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
            <legend className="mb-2 p-0 text-[13px] text-ink-2">
              For plans <span className="text-ink-3">(none chosen: any)</span>
            </legend>
            {plans
              .filter((p) => !p.retiredAt && p.price)
              .map((p) => (
                <Choice
                  key={p.id}
                  checked={planIds.includes(p.id)}
                  onChange={() =>
                    setPlanIds(
                      planIds.includes(p.id)
                        ? planIds.filter((x) => x !== p.id)
                        : [...planIds, p.id],
                    )
                  }
                >
                  {p.name}
                </Choice>
              ))}
          </fieldset>
        )}
        {(problem || save.isError) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {problem ?? save.error?.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

const useWords = { held: "checkout open", taken: "paid", released: "checkout lapsed" } as const;

/** Who used a code: each workspace, the plan, and whether its checkout was paid. */
function PromoUses({ promo, onClose }: { promo: PromoCode; onClose: () => void }) {
  const { data, error, refetch } = useQuery(promoUsesQuery(promo.id));
  return (
    <Dialog
      title={`Who used ${promo.code}`}
      description={promoSummary(promo, (iso) => fullDate.format(new Date(iso)))}
      onClose={onClose}
    >
      {error ? (
        <Failed what="Its uses" error={error} retry={refetch} size="panel" className="px-0" />
      ) : !data ? (
        <Loading size="panel" className="px-0" />
      ) : data.uses.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-2">Nobody yet.</p>
      ) : (
        <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line">
          {data.uses.map((u) => (
            <Row
              key={`${u.workspace.id}${u.at}`}
              name={u.workspace.name}
              hint={[u.plan, useWords[u.status], fullDate.format(new Date(u.at))]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}
