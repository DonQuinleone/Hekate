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
  promoSummary,
  type SupportSeverity,
  supportSeverities,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Icon } from "~/components/icons";
import { formatDates } from "~/lib/locale";
import {
  instanceBillingQuery,
  instanceOwnSettingsQuery,
  instancePlansQuery,
  instancePromosQuery,
  promoUsesQuery,
  useEndPromo,
  usePutWorkspacePlan,
  useRetirePlan,
  useSavePlan,
  useSavePromo,
  useWaive,
} from "~/lib/queries";
import { TileGrid } from "./billing";
import { Gateways } from "./instance-billing-gateways";
import { Reports } from "./instance-billing-reports";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Choice, ChoiceCard } from "./ui/choice";
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
  const { data, error } = useQuery(instanceBillingQuery);
  const [changing, setChanging] = useState<BillingWorkspaceRow | null>(null);
  const [waiving, setWaiving] = useState<BillingWorkspaceRow | null>(null);
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!data) return null;
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
        {data.workspaces.length === 0 ? (
          <Row name="No workspaces yet" hint="Each appears here with its plan once it is made." />
        ) : (
          data.workspaces.map((w) => (
            <WorkspaceRow
              key={w.id}
              workspace={w}
              onChangePlan={() => setChanging(w)}
              onWaive={() => setWaiving(w)}
            />
          ))
        )}
      </Section>
      {changing && <ChangeWorkspacePlan workspace={changing} onClose={() => setChanging(null)} />}
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

/** Its plan and what comes next, in a line. */
export function workspaceBillingLine(w: BillingWorkspaceRow): string {
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

function WorkspaceRow({
  workspace: w,
  onChangePlan,
  onWaive,
}: {
  workspace: BillingWorkspaceRow;
  onChangePlan: () => void;
  onWaive: () => void;
}) {
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
          ...(owes(w)
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
              title="No plan"
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

/** Letting a workspace off what it owes, and opening it again if dunning suspended it. */
function Waive({ workspace: w, onClose }: { workspace: BillingWorkspaceRow; onClose: () => void }) {
  const waive = useWaive(w.id);
  const [reason, setReason] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    waive.mutate(reason, { onSuccess: onClose });
  };
  return (
    <Dialog
      title={`Waive what ${w.name} owes?`}
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
            variant="primary"
            type="submit"
            form="waive"
            disabled={!reason.trim() || waive.isPending}
          >
            {w.dunningSuspended ? "Waive and reinstate" : "Waive"}
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
  const { data, error } = useQuery(instancePlansQuery);
  const save = useSavePlan();
  const retire = useRetirePlan();
  const [editing, setEditing] = useState<{ plan: Plan | null; copy?: boolean } | null>(null);
  const [retiring, setRetiring] = useState<Plan | null>(null);
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!data) return null;
  const plans = byPrice(data.plans.filter((p) => !p.retiredAt));
  const retired = data.plans.filter((p) => p.retiredAt);
  const toggleHidden = (p: Plan) =>
    save.mutate({ id: p.id, input: { ...inputOf(p), hidden: !p.hidden } });
  return (
    <>
      <Section
        title="Plans"
        intro="What workspaces can be on. Prices, limits and which support severities each unlocks are the instance's to set."
        action={
          <Button variant="primary" size="md" onClick={() => setEditing({ plan: null })}>
            <Icon name="plus" size={14} />
            Plan
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
                  { label: "Duplicate", onSelect: () => setEditing({ plan: p, copy: true }) },
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
              <Button variant="ghost" onClick={() => setRetiring(null)}>
                Keep it
              </Button>
              <Button
                variant="primary"
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
  const [currency, setCurrency] = useState(plan?.price?.currency ?? instanceCurrency);
  const [amount, setAmount] = useState(
    plan?.price ? typedAmount(plan.price.amount, plan.price.currency) : "",
  );
  const [interval, setInterval] = useState<"month" | "year">(plan?.price?.interval ?? "month");
  const [storageQuota, setStorageQuota] = useState<number | null>(plan?.storageQuota ?? null);
  const [memberLimit, setMemberLimit] = useState<number | null>(plan?.memberLimit ?? null);
  const [projectLimit, setProjectLimit] = useState(
    plan?.projectLimit ? String(plan.projectLimit) : "",
  );
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
    const projects = projectLimit.trim() ? Number(projectLimit) : null;
    if (projects !== null && (!Number.isInteger(projects) || projects < 1))
      return setProblem("A whole number of projects, or none for no limit");
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
          projectLimit: projects,
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
              A price
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
              <Field label="Amount" className="w-32">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="tabular"
                />
              </Field>
              <Field label="Currency" className="w-24">
                <Input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                  className="uppercase"
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
          <Field label="Projects" hint="Empty for no limit." className="w-32">
            <Input
              value={projectLimit}
              onChange={(e) => setProjectLimit(e.target.value)}
              inputMode="numeric"
              className="tabular"
            />
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
  const { data, error } = useQuery(instancePromosQuery);
  const plans = useQuery(instancePlansQuery).data?.plans ?? [];
  const end = useEndPromo();
  const [editing, setEditing] = useState<{ promo: PromoCode | null } | null>(null);
  const [uses, setUses] = useState<PromoCode | null>(null);
  const [ending, setEnding] = useState<PromoCode | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!data) return null;
  const nameOf = new Map(plans.map((p) => [p.id, p.name]));
  const forPlans = (p: PromoCode) =>
    p.planIds.length === 0
      ? "any plan"
      : p.planIds.map((id) => nameOf.get(id) ?? "a plan gone").join(" and ");
  return (
    <>
      <Section
        title="Promo codes"
        intro="A percentage or an amount off, for a number of months, for the first so many who use it, until a date."
        action={
          <Button variant="primary" size="md" onClick={() => setEditing({ promo: null })}>
            <Icon name="plus" size={14} />
            Code
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
              <Button variant="ghost" onClick={() => setEnding(null)}>
                Keep it
              </Button>
              <Button
                variant="primary"
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
  const [currency, setCurrency] = useState(promo?.currency ?? instanceCurrency);
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
            <div className="flex flex-wrap gap-3">
              <Field label="Amount" className="w-32">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="tabular"
                />
              </Field>
              <Field label="Currency" className="w-24">
                <Input
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                  className="uppercase"
                />
              </Field>
            </div>
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
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
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
  const { data, error } = useQuery(promoUsesQuery(promo.id));
  return (
    <Dialog
      title={`Who used ${promo.code}`}
      description={promoSummary(promo, (iso) => fullDate.format(new Date(iso)))}
      onClose={onClose}
    >
      {error ? (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {error.message}
        </p>
      ) : !data ? null : data.uses.length === 0 ? (
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
