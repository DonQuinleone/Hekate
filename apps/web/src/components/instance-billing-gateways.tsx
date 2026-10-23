import { type BillingRules, type DunningRule, dunningRule } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ago } from "~/lib/comments";
import {
  instanceGatewayQuery,
  instanceOwnSettingsQuery,
  useSaveInstanceSettings,
} from "~/lib/queries";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { StatusDot } from "./ui/status";

/**
 * The Billing section's Gateways tab (#180): how the instance takes payment, and billing's
 * rules (its currency, dunning's days, a trial's length), which its operators set.
 */

/** The currencies offered first; one already set stays offered. */
const currencies = ["GBP", "EUR", "USD", "CHF", "SEK", "NOK", "DKK", "CAD", "AUD", "JPY"];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function Gateways() {
  const { data: status, error } = useQuery(instanceGatewayQuery);
  const { data: own } = useQuery(instanceOwnSettingsQuery);
  const save = useSaveInstanceSettings();
  const [editing, setEditing] = useState<"dunning" | "trials" | null>(null);
  if (error) return <p className="m-0 text-[13px] text-signal">{error.message}</p>;
  if (!status || !own) return null;
  const rules = own.settings.billing;
  const saveRules = (billing: BillingRules, onSuccess?: () => void) =>
    save.mutate({ ...own.settings, billing }, { onSuccess });
  const { stripe } = status;
  const healthy = stripe ? stripe.failedEvents === 0 && stripe.lastEventAt !== null : false;
  const offered = currencies.includes(rules.currency)
    ? currencies
    : [rules.currency, ...currencies];
  return (
    <>
      <Section
        title="Gateways"
        intro={
          status.mode === "stripe"
            ? "Billing is a module: on because the instance runs with HEKATE_BILLING=stripe. Stripe takes payment by card; plans by agreement are invoiced by hand."
            : "Billing is a module: on because the instance runs with HEKATE_BILLING=manual. Plans are invoiced by hand; no gateway takes payment by card."
        }
      >
        <Row
          name={
            <span className="flex items-center gap-2">
              {stripe && <StatusDot state={healthy ? "approved" : "changes_requested"} />}
              Stripe
            </span>
          }
          hint={
            stripe
              ? [
                  stripe.account
                    ? `${stripe.account.id}${stripe.account.name ? ` (${stripe.account.name})` : ""}`
                    : "account not readable with this key",
                  stripe.test ? "test mode" : "live",
                  stripe.lastEventAt
                    ? `last event ${ago(stripe.lastEventAt)}`
                    : "no events yet: is the webhook set up?",
                  stripe.failedEvents > 0
                    ? `${plural(stripe.failedEvents, "event")} failed this week`
                    : null,
                  stripe.tax ? "Stripe Tax on" : "Stripe Tax off",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "Not connected. Set HEKATE_BILLING=stripe and its keys to take payment by card."
          }
        >
          {stripe && (
            <Button variant="ghost" size="md" asChild>
              <a
                href={`https://dashboard.stripe.com/${stripe.test ? "test/" : ""}dashboard`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open Stripe
              </a>
            </Button>
          )}
        </Row>
        {stripe && (
          <Row
            name="Webhook"
            hint="Where Stripe sends its events, with the signing secret in STRIPE_WEBHOOK_SECRET."
          >
            <code className="tabular truncate text-[12px] text-ink-2">{stripe.webhookUrl}</code>
          </Row>
        )}
        <Row
          name="Paddle"
          hint="Not connected. A merchant of record, collecting VAT in every country: it follows with the hosted offering."
        />
        <Row
          name={
            <span className="flex items-center gap-2">
              <StatusDot state="approved" />
              Manual invoicing
            </span>
          }
          hint={`For plans by agreement: numbered HK-…, sent outside Hekate and marked paid by hand. ${
            status.openByHand === 0 ? "None open." : `${plural(status.openByHand, "invoice")} open.`
          }`}
        />
      </Section>
      <Section title="Rules">
        <Row
          name="Dunning"
          hint={`An unpaid invoice warns at ${rules.dunning.warn} days, warns again at ${rules.dunning.warnAgain}, suspends at ${rules.dunning.suspend}, deletes nothing.${
            stripe
              ? ""
              : " For payments through a gateway: invoices by hand are the operators' to chase."
          }`}
        >
          <Button variant="ghost" size="md" onClick={() => setEditing("dunning")}>
            Edit
          </Button>
        </Row>
        <Row name="Currency" hint="New plans and amounts off are priced in it.">
          <Select
            aria-label="Currency"
            value={rules.currency}
            disabled={save.isPending}
            onChange={(e) => saveRules({ ...rules, currency: e.target.value })}
            className="w-28"
          >
            {offered.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          name="Trials"
          hint={
            rules.trialDays === 0
              ? "No trials: workspaces that sign up choose a plan at once."
              : `${rules.trialDays} days for workspaces that sign up for one, converting to the plan chosen.`
          }
        >
          <Button variant="ghost" size="md" onClick={() => setEditing("trials")}>
            Edit
          </Button>
        </Row>
      </Section>
      {save.isError && !editing && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {save.error.message}
        </p>
      )}
      {editing === "dunning" && (
        <DunningDialog
          rule={rules.dunning}
          pending={save.isPending}
          error={save.error?.message ?? null}
          onSave={(dunning) => saveRules({ ...rules, dunning }, () => setEditing(null))}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "trials" && (
        <TrialDialog
          days={rules.trialDays}
          pending={save.isPending}
          error={save.error?.message ?? null}
          onSave={(trialDays) => saveRules({ ...rules, trialDays }, () => setEditing(null))}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

const whole = (typed: string) => (/^\d+$/.test(typed.trim()) ? Number(typed) : Number.NaN);

/** Dunning's three days: warned, warned again, suspended. */
function DunningDialog({
  rule,
  pending,
  error,
  onSave,
  onClose,
}: {
  rule: DunningRule;
  pending: boolean;
  error: string | null;
  onSave: (rule: DunningRule) => void;
  onClose: () => void;
}) {
  const [warn, setWarn] = useState(String(rule.warn));
  const [warnAgain, setWarnAgain] = useState(String(rule.warnAgain));
  const [suspend, setSuspend] = useState(String(rule.suspend));
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = dunningRule.safeParse({
      warn: whole(warn),
      warnAgain: whole(warnAgain),
      suspend: whole(suspend),
    });
    if (!parsed.success)
      return setProblem("Whole days, each after the one before: such as 7, 14 and 21.");
    setProblem(null);
    onSave(parsed.data);
  };
  return (
    <Dialog
      title="Dunning"
      description="In days, counted from the day a payment first fails. Nothing is ever deleted for want of payment."
      width="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="dunning" disabled={pending}>
            Save
          </Button>
        </>
      }
    >
      <form id="dunning" onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["Warn at", warn, setWarn],
              ["Warn again at", warnAgain, setWarnAgain],
              ["Suspend at", suspend, setSuspend],
            ] as const
          ).map(([label, value, set]) => (
            <Field key={label} label={label} className="w-24">
              <Input
                value={value}
                onChange={(e) => set(e.target.value)}
                inputMode="numeric"
                className="tabular"
              />
            </Field>
          ))}
        </div>
        <p className="m-0 text-[13px] text-ink-2">
          A workspace already owing moves to the new days at the next hourly run; a step it has
          passed is not taken twice.
        </p>
        {(problem || error) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {problem ?? error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** How long a trial lasts; none at all. */
function TrialDialog({
  days,
  pending,
  error,
  onSave,
  onClose,
}: {
  days: number;
  pending: boolean;
  error: string | null;
  onSave: (days: number) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState(String(days));
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const n = whole(typed);
    if (!(n >= 0 && n <= 90)) return setProblem("Whole days, up to 90; 0 for no trials.");
    setProblem(null);
    onSave(n);
  };
  return (
    <Dialog
      title="Trials"
      description="For workspaces that sign up for one. A trial already running keeps its end."
      width="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="trials" disabled={pending}>
            Save
          </Button>
        </>
      }
    >
      <form id="trials" onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Length" hint="days; 0 for no trials" className="w-32">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            inputMode="numeric"
            className="tabular"
          />
        </Field>
        {(problem || error) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {problem ?? error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
