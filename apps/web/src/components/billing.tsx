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
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { billingQuery, useBillingPortal, useCancelPlan, useChangePlan } from "~/lib/queries";
import { Danger, Row, Section } from "./settings";
import { Button } from "./ui/button";
import { ChoiceCard } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input } from "./ui/input";

/**
 * The workspace's Billing settings (#179), as the prototype has them: where it stands, its plan
 * and the card that pays for it, the month against its limits, its invoices, and cancelling.
 * Admins read it; its owners, who pay, change it.
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
      ? `Overdue since ${invoiceDate.format(new Date(i.dueAt))}`
      : i.dueAt
        ? `Due ${invoiceDate.format(new Date(i.dueAt))}`
        : "Due";
  return { draft: "Draft", paid: "Paid", void: "Void", uncollectible: "Not paid" }[i.status];
};

export function BillingSection({ owner }: { owner: boolean }) {
  const { data, error } = useQuery(billingQuery);
  const [changing, setChanging] = useState(false);
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!data) return null;
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
  const tiles: [string, string, string][] = [
    [
      "Plan",
      plan.plan?.name ?? "Included",
      price ? priceWords(price) : plan.plan ? "by agreement" : "everything included",
    ],
    [
      "Storage",
      formatBytes(usage.storageBytes),
      quota === null ? "no quota" : `of ${formatBytes(quota)}`,
    ],
    ["Members", String(usage.members), people === null ? "no limit" : `of ${people}`],
    [next[0] ?? "", next[1] ?? "", next[2] ?? ""],
  ];
  return <TileGrid tiles={tiles.map(([label, value, hint]) => ({ label, value, hint }))} />;
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
  const suspends = new Date(since.getTime() + 21 * 86_400_000);
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
  const { plan, usage, customer, gateway } = billing;
  const name = plan.plan?.name ?? "The included plan";
  const intro = [
    `${name}: ${planSummary(plan.entitlements, formatBytes)}.`,
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
  const limits = [
    // Storage as it is counted: at the month's peak.
    standing(
      Math.max(usage.storageBytes, usage.month?.storagePeak ?? 0),
      usage.limits.storageQuota,
    ),
    standing(usage.members + usage.invited, usage.limits.memberLimit),
    standing(usage.projects, usage.limits.projectLimit ?? null),
  ];
  const where = limits.includes("reached")
    ? "At a limit"
    : limits.includes("near")
      ? "Near a limit"
      : "Within the plan";
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
      <Row
        name="Usage this month"
        hint="Storage counts at the month's peak; members at the month's end."
      >
        <span
          className={
            where === "Within the plan" ? "text-[13px] text-ink-2" : "text-[13px] text-signal"
          }
        >
          {where}
        </span>
      </Row>
      {portal.isError && (
        <p role="alert" className="m-0 px-4 py-2 text-[13px] text-signal">
          {portal.error.message}
        </p>
      )}
    </Section>
  );
}

function Invoices({ invoices }: { invoices: Invoice[] }) {
  return (
    <Section title="Invoices">
      {invoices.length === 0 ? (
        <Row name="No invoices yet" hint="Each one appears here once it is issued." />
      ) : (
        invoices.map((i) => (
          <Row
            key={i.id}
            inline
            name={
              <span className="flex items-center gap-2">
                <span className="tabular">{i.number ?? "Draft"}</span>
                <span className="text-[12px] text-ink-3">
                  {invoiceDate.format(new Date(i.issuedAt))}
                </span>
              </span>
            }
            hint={[invoiceStatus(i), i.description].filter(Boolean).join(" · ")}
          >
            <span className="tabular text-[13px] text-ink-2">
              {formatMoney(i.amountDue, i.currency)}
            </span>
            {(i.pdfUrl ?? i.url) && (
              <Button variant="ghost" size="md" asChild>
                <a href={i.pdfUrl ?? i.url ?? ""} target="_blank" rel="noopener noreferrer">
                  {i.pdfUrl ? "PDF" : "Open"}
                </a>
              </Button>
            )}
          </Row>
        ))
      )}
    </Section>
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
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Keep it
              </Button>
              <Button
                variant="primary"
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
        <Field label="Promo code" hint="If you were given one.">
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
