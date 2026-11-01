import {
  formatBytes,
  formatMoney,
  type Invoice,
  type PlanChoice,
  planSummary,
  standing,
  type WorkspaceBilling,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Failed, Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { billingQuery, useBillingPortal, useCancelPlan, useChangePlan } from "~/lib/queries";
import { Danger, Row, Section } from "./settings";
import { Button } from "./ui/button";
import { ChoiceCard } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";
import { type ReviewState, StatusDot } from "./ui/status";

/**
 * The workspace's Billing settings (#179), as the prototype has them: where it stands (its plan,
 * storage and members against the plan, and what comes next, said once, #592), the plan's terms
 * and the card that pays for it, its invoices as a table, and cancelling. Admins read it; its
 * owners, who pay, change it.
 */

const shortDate = formatDates({ day: "numeric", month: "short" });
const longDate = formatDates({ day: "numeric", month: "long", year: "numeric" });
const invoiceDate = formatDates({ day: "numeric", month: "short", year: "numeric" });

const per = { month: "a month", year: "a year" } as const;
const priceWords = (price: PlanChoice["price"]) =>
  `${formatMoney(price.amount, price.currency)} ${per[price.interval]}`;

const invoiceStatus = (i: Invoice) => {
  if (i.status === "open")
    return i.dueAt && new Date(i.dueAt) < new Date()
      ? `Overdue since ${shortDate.format(new Date(i.dueAt))}`
      : i.dueAt
        ? `Due ${shortDate.format(new Date(i.dueAt))}`
        : "Due";
  return { draft: "Draft", paid: "Paid", void: "Void", uncollectible: "Not paid" }[i.status];
};

/** An invoice's status as a dot's shape: paid is done, overdue in signal, void struck off. */
const invoiceDot = (i: Invoice): ReviewState => {
  if (i.status === "paid") return "approved";
  if (i.status === "open")
    return i.dueAt && new Date(i.dueAt) < new Date() ? "changes_requested" : "in_review";
  if (i.status === "draft") return "submitted";
  return "cancelled";
};

/** How many invoices the table shows before "Show older". */
const INVOICES_SHOWN = 5;

export function BillingSection({ owner }: { owner: boolean }) {
  const { data, error, refetch } = useQuery(billingQuery);
  const [changing, setChanging] = useState(false);
  if (error) return <Failed what="Billing" error={error} retry={refetch} />;
  if (!data) return <Loading />;
  const done = new URLSearchParams(window.location.search).get("checkout") === "done";
  return (
    <>
      <Tiles billing={data} />
      {done && !data.subscribed && (
        <p role="status" className="m-0 text-[13px] text-ink-2">
          Payment received. The plan arrives in a moment.
        </p>
      )}
      {data.pastDueSince && <Overdue billing={data} owner={owner} />}
      <PlanSection billing={data} owner={owner} onChange={() => setChanging(true)} />
      <Invoices invoices={data.invoices} />
      {owner && data.gateway && data.subscribed && <Cancel billing={data} />}
      {changing && <ChangePlan billing={data} onClose={() => setChanging(false)} />}
    </>
  );
}

/** Where the workspace stands, at a glance: its plan, storage, members, and what comes next. */
function Tiles({ billing }: { billing: WorkspaceBilling }) {
  const { plan, usage } = billing;
  // Its own plan's price, offered still or not.
  const price = billing.current?.price ?? null;
  const quota = usage.limits.storageQuota;
  const people = usage.limits.memberLimit;
  const next = plan.cancelsAt
    ? ["Ends", shortDate.format(new Date(plan.cancelsAt)), "nothing more is charged"]
    : plan.status === "trial" && plan.trialEndsAt
      ? ["Trial ends", shortDate.format(new Date(plan.trialEndsAt)), "then the plan's price"]
      : plan.renewsAt
        ? [
            "Next invoice",
            shortDate.format(new Date(plan.renewsAt)),
            price ? formatMoney(price.amount, price.currency) : "",
          ]
        : ["Next invoice", "None", "nothing is due"];
  // Storage as it is counted, at the month's peak; members with the invited, who take a place.
  const stored = standing(Math.max(usage.storageBytes, usage.month?.storagePeak ?? 0), quota);
  const placed = standing(usage.members + usage.invited, people);
  const near = { under: "", near: " · nearly at the limit", reached: " · at the limit" } as const;
  const tiles: { label: string; value: string; hint: string; flag?: boolean }[] = [
    {
      label: "Plan",
      value: plan.plan?.name ?? "Included",
      hint: price ? priceWords(price) : plan.plan ? "by agreement" : "everything included",
    },
    {
      label: "Storage",
      value: formatBytes(usage.storageBytes),
      hint: quota === null ? "no quota" : `of ${formatBytes(quota)}${near[stored]}`,
      flag: stored !== "under",
    },
    {
      label: "Members",
      value: String(usage.members),
      hint: people === null ? "no limit" : `of ${people}${near[placed]}`,
      flag: placed !== "under",
    },
    { label: next[0] ?? "", value: next[1] ?? "", hint: next[2] ?? "" },
  ];
  return <TileGrid tiles={tiles} />;
}

/**
 * Figures at a glance, in one panel divided by hairlines: four or five across, two on a phone,
 * where an odd last one takes the row. A flagged one is in signal.
 */
export function TileGrid({
  tiles,
}: {
  tiles: { label: string; value: string; hint: string; flag?: boolean }[];
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line",
        tiles.length === 5 ? "@3xl/app:grid-cols-5" : "@3xl/app:grid-cols-4",
      )}
    >
      {tiles.map(({ label, value, hint, flag }, i) => (
        <div
          key={label}
          className={cn(
            "min-w-0 bg-raised/25 px-4 py-3",
            tiles.length % 2 === 1 && i === tiles.length - 1 && "col-span-2 @3xl/app:col-span-1",
          )}
        >
          <div className="truncate text-[12px] text-ink-3">{label}</div>
          <div
            className={cn(
              "tabular mt-1 truncate text-[24px] leading-none font-medium",
              flag ? "text-signal" : "text-ink",
            )}
          >
            {value}
          </div>
          <div className="mt-1.5 truncate text-[12px] text-ink-3">{hint}</div>
        </div>
      ))}
    </div>
  );
}

/** A payment failed: what is owed, by when, and the way to pay it. */
function Overdue({ billing, owner }: { billing: WorkspaceBilling; owner: boolean }) {
  const since = new Date(billing.pastDueSince ?? "");
  // On the day the instance's rules set (#180).
  const suspends = new Date(billing.suspendsAt ?? since.getTime() + 21 * 86_400_000);
  const open = billing.invoices.find((i) => i.status === "open" && i.url);
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-panel-lg border border-signal/30 bg-signal/[0.04] px-4 py-3 @3xl/app:flex-row @3xl/app:items-center"
    >
      <p className="m-0 min-w-0 flex-1 text-[13px] text-ink-2">
        A payment failed on {longDate.format(since)}. Pay it, or change the card, before{" "}
        {longDate.format(suspends)}, or the workspace is suspended until it is paid. Nothing in it
        is deleted.
      </p>
      {owner && open?.url && (
        <Button variant="primary" size="md" asChild>
          <a href={open.url} target="_blank" rel="noopener noreferrer">
            Pay the invoice
          </a>
        </Button>
      )}
    </div>
  );
}

function PlanSection({
  billing,
  owner,
  onChange,
}: {
  billing: WorkspaceBilling;
  owner: boolean;
  onChange: () => void;
}) {
  const portal = useBillingPortal();
  const { plan, customer, gateway } = billing;
  // The plan's name is the tile's above; here, what it includes (#592).
  const summary = planSummary(plan.entitlements, formatBytes);
  const intro = [
    `${summary.charAt(0).toUpperCase()}${summary.slice(1)}.`,
    gateway
      ? "Change it any time; the difference is pro-rated."
      : "Plans here are arranged with the instance's operators.",
  ].join(" ");
  const card = customer?.card;
  const details = customer
    ? [
        customer.name,
        customer.address,
        ...customer.taxIds.map((t) => `VAT ${t}`),
        customer.email && `invoices to ${customer.email}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <Section
      title="Plan"
      intro={intro}
      action={
        owner &&
        gateway &&
        billing.plans.length > 0 && (
          <Button variant="secondary" size="md" onClick={onChange}>
            Change plan
          </Button>
        )
      }
    >
      {gateway && (
        <>
          <Row
            name="Payment"
            hint={
              card
                ? `${card.brand[0]?.toUpperCase()}${card.brand.slice(1)} ending ${card.last4} · expires ${String(card.expMonth).padStart(2, "0")}/${String(card.expYear).slice(-2)}`
                : "No card yet: one is asked for when a plan is chosen."
            }
          >
            {owner && customer && (
              <Button
                variant="ghost"
                size="md"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
              >
                Update card
              </Button>
            )}
          </Row>
          <Row
            name="Billing details"
            hint={details || "Given at checkout: the name, address and VAT number invoices carry."}
          >
            {owner && customer && (
              <Button
                variant="ghost"
                size="md"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
              >
                Edit
              </Button>
            )}
          </Row>
        </>
      )}
      {portal.isError && (
        <p role="alert" className="m-0 px-4 py-2 text-[13px] text-signal">
          {portal.error.message}
        </p>
      )}
    </Section>
  );
}

/**
 * The invoices as a table (#592), as Stripe's customer portal lists them: number, date, amount,
 * where it stands, and the way to open it. The latest five, then "Show older". The gateway's
 * open as its PDF or its page; one made by hand opens here, with what it says.
 */
function Invoices({ invoices }: { invoices: Invoice[] }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<Invoice | null>(null);
  const shown = all ? invoices : invoices.slice(0, INVOICES_SHOWN);
  return (
    <Section title="Invoices" count={invoices.length || undefined}>
      {invoices.length === 0 ? (
        <Row name="No invoices yet" hint="Each one appears here once it is issued." />
      ) : (
        <div className="flex flex-col">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead>
              <tr className="text-left">
                <th className="label px-4 py-2 font-normal">Invoice</th>
                <th className="label hidden w-32 px-2 py-2 font-normal @3xl/app:table-cell">
                  Date
                </th>
                <th className="label w-24 px-2 py-2 text-right font-normal">Amount</th>
                <th className="label w-36 px-2 py-2 font-normal @3xl/app:w-44">Status</th>
                <th className="w-16 px-4 py-2">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => {
                const link = i.pdfUrl ?? i.url;
                return (
                  <tr key={i.id} data-invoice className="border-t border-line">
                    <td className="min-w-0 px-4 py-row">
                      <span className="tabular block truncate text-ink">{i.number ?? "Draft"}</span>
                      <span className="block truncate text-[12px] text-ink-3 @3xl/app:hidden">
                        {invoiceDate.format(new Date(i.issuedAt))}
                      </span>
                    </td>
                    <td className="hidden truncate px-2 py-row text-ink-2 @3xl/app:table-cell">
                      {invoiceDate.format(new Date(i.issuedAt))}
                    </td>
                    <td className="tabular px-2 py-row text-right text-ink">
                      {formatMoney(i.amountDue, i.currency)}
                    </td>
                    <td className="px-2 py-row">
                      <span className="inline-flex max-w-full items-center gap-[7px] rounded-full border border-hairline px-2.5 py-0.5 text-[12px] text-ink-2">
                        <StatusDot state={invoiceDot(i)} />
                        <span className="truncate">{invoiceStatus(i)}</span>
                      </span>
                    </td>
                    <td className="px-4 py-row text-right">
                      {link ? (
                        <Button variant="ghost" size="sm" asChild>
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`Open ${i.number ?? "the draft"}${i.pdfUrl ? " as a PDF" : ""}`}
                          >
                            {i.pdfUrl ? "PDF" : "Open"}
                          </a>
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Open ${i.number ?? "the draft"}`}
                          onClick={() => setOpen(i)}
                        >
                          Open
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {invoices.length > INVOICES_SHOWN && !all && (
            <div className="border-t border-line px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
                Show older
              </Button>
            </div>
          )}
        </div>
      )}
      {open && <InvoiceDialog invoice={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

/** An invoice made by hand, opened: it has no page at a gateway, so what it says is here. */
function InvoiceDialog({ invoice: i, onClose }: { invoice: Invoice; onClose: () => void }) {
  const period =
    i.periodStart && i.periodEnd
      ? `${invoiceDate.format(new Date(i.periodStart))} to ${invoiceDate.format(new Date(i.periodEnd))}`
      : null;
  return (
    <Dialog
      title={`Invoice ${i.number ?? "draft"}`}
      description={`Issued ${longDate.format(new Date(i.issuedAt))}. Sent by the instance's operators, outside Hekate.`}
      onClose={onClose}
      width="sm"
    >
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
        {(
          [
            ["For", i.description],
            ["Period", period],
            ["Amount", formatMoney(i.amountDue, i.currency)],
            ["Paid", i.amountPaid > 0 ? formatMoney(i.amountPaid, i.currency) : null],
            ["Credit", i.credit ? `${formatMoney(i.credit, i.currency)} taken off` : null],
            ["Status", invoiceStatus(i)],
          ] as const
        )
          .filter(([, value]) => value)
          .map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="text-ink-3">{name}</dt>
              <dd className="m-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
      </dl>
    </Dialog>
  );
}

/** Cancelling at the end of the period paid for, with what happens next; or keeping it. */
function Cancel({ billing }: { billing: WorkspaceBilling }) {
  const cancel = useCancelPlan();
  const [asking, setAsking] = useState(false);
  const { plan } = billing;
  const ends = plan.cancelsAt ?? plan.renewsAt;
  const on = ends ? longDate.format(new Date(ends)) : "the end of the period";
  return (
    <Danger>
      {plan.cancelsAt ? (
        <Row
          name={`The plan ends on ${on}`}
          hint="Nothing more is charged. Keep it, and it renews as before."
        >
          <Button
            variant="secondary"
            size="md"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(false)}
          >
            Keep the plan
          </Button>
        </Row>
      ) : (
        <Row
          name="Cancel the plan"
          hint={`It ends on ${on}, at the end of the period paid for. Nothing is deleted.`}
        >
          <Button variant="ghost" size="md" onClick={() => setAsking(true)}>
            Cancel…
          </Button>
        </Row>
      )}
      {asking && (
        <Dialog
          title="Cancel the plan?"
          description={`${plan.plan?.name ?? "The plan"} ends on ${on}, and nothing more is charged.`}
          onClose={() => setAsking(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(true, { onSuccess: () => setAsking(false) })}
              >
                Cancel the plan
              </Button>
            </>
          }
        >
          <p className="m-0 text-[13px] text-ink-2">
            Until then, everything works as it does now. After that, nothing in the workspace is
            deleted: it stays as it is, with nothing charged, until its owners choose a plan again
            or the instance's operators move it to another.
          </p>
          {cancel.isError && (
            <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
              {cancel.error.message}
            </p>
          )}
        </Dialog>
      )}
    </Danger>
  );
}

/** Choosing another plan, with a promo code if there is one. */
function ChangePlan({ billing, onClose }: { billing: WorkspaceBilling; onClose: () => void }) {
  const change = useChangePlan();
  const current = billing.plan.plan?.id ?? null;
  const [planId, setPlanId] = useState(
    billing.plans.find((p) => p.id !== current)?.id ?? billing.plans[0]?.id ?? "",
  );
  const [code, setCode] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate(
      { planId, ...(code.trim() ? { promoCode: code.trim() } : {}) },
      { onSuccess: ({ url }) => !url && onClose() },
    );
  };
  return (
    <Dialog
      title="Change plan"
      description={
        billing.subscribed
          ? "The difference is pro-rated to the next invoice."
          : "You are taken to the payment page to add a card."
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
            form="change-plan"
            disabled={!planId || change.isPending}
          >
            {billing.subscribed ? "Change plan" : "Continue to payment"}
          </Button>
        </>
      }
    >
      <form id="change-plan" onSubmit={submit} className="flex flex-col gap-3">
        <div role="radiogroup" aria-label="Plan" className="flex flex-col gap-2">
          {billing.plans.map((p) => (
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
                  {p.id === current && (
                    <span className="text-[11px] font-normal text-ink-3">current</span>
                  )}
                </>
              }
              hint={planSummary(
                { ...p, projectLimit: p.projectLimit, severities: [] },
                formatBytes,
              )}
            />
          ))}
        </div>
        <Field
          label="Promo code"
          hint="If you were given one, its discount comes off your next invoice."
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
            className="w-48 uppercase"
          />
        </Field>
        <p className="m-0 text-[12px] text-ink-3">
          Going down keeps everything; uploads stop above the new limits.
        </p>
        {change.isError && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {change.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
