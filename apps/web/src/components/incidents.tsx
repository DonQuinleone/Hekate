import {
  type Incident,
  type IncidentImpact,
  type IncidentState,
  incidentImpactNames,
  incidentImpacts,
  incidentStateNames,
  incidentStates,
  type StatusService,
  statusServiceNames,
  statusServices,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Icon } from "~/components/icons";
import { Row, Section } from "~/components/settings";
import { IncidentUpdates, incidentLine, incidentSpan, StateDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ago } from "~/lib/comments";
import {
  incidentsQuery,
  usePostIncident,
  useRemoveIncident,
  useUpdateIncident,
} from "~/lib/status";
import { supportDeskQuery, useSaveDesk } from "~/lib/support";

/** How many resolved incidents the desk lists under the open ones. */
const RECENT = 5;

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** A local date and time for a `datetime-local` field, and back to an instant. */
const localValue = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const instantOf = (value: string) => (value ? new Date(value).toISOString() : undefined);

/**
 * The status page on the desk (#183): what is open and what was lately, posting an incident
 * and its updates, and where the help menu links. Every operator's, whether or not tickets
 * are answered in the app.
 */
export function StatusSection() {
  const { data, error } = useQuery(incidentsQuery);
  const { data: desk } = useQuery(supportDeskQuery);
  const [posting, setPosting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const incidents = data?.incidents ?? [];
  const open = incidents.filter((i) => !i.resolvedAt);
  const recent = incidents.filter((i) => i.resolvedAt).slice(0, RECENT);
  const shown = incidents.find((i) => i.id === openId);
  const linked = desk ? (desk.statusUrl ?? desk.environmentStatusUrl ?? desk.ownStatusUrl) : null;
  const own = desk !== undefined && linked === desk.ownStatusUrl;
  return (
    <Section
      title="Status page"
      intro="Something down for everyone, posted here, shows at once on the status page, in the help menu and on the Support page."
      action={
        <Button variant="secondary" size="md" onClick={() => setPosting(true)}>
          <Icon name="plus" size={14} />
          Post an incident
        </Button>
      }
    >
      {error && <p className="m-0 px-4 py-3 text-[13px] text-signal">{error.message}</p>}
      {data && incidents.length === 0 && (
        <Row
          name="Nothing posted yet"
          hint="When something is down for everyone, post it here, then update it until it is resolved."
        />
      )}
      {[...open, ...recent].map((i) => (
        <IncidentRow key={i.id} incident={i} onOpen={() => setOpenId(i.id)} />
      ))}
      {desk && linked && (
        <Row
          name="Address"
          hint={
            own
              ? `${hostOf(linked)} · this instance’s own page, readable signed out`
              : `${hostOf(linked)} · ${desk.statusUrl ? "set here" : "from HEKATE_STATUS_URL"}; incidents posted here still show at ${hostOf(desk.ownStatusUrl)} and in the app`
          }
        >
          <Button variant="ghost" size="md" asChild>
            <a href={linked} target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </Button>
          <Button variant="ghost" size="md" onClick={() => setEditing(true)}>
            Edit
          </Button>
        </Row>
      )}
      {posting && <PostIncidentDialog onClose={() => setPosting(false)} />}
      {shown && <IncidentDialog incident={shown} onClose={() => setOpenId(null)} />}
      {editing && desk && (
        <StatusAddressDialog
          current={desk.statusUrl}
          fallback={desk.environmentStatusUrl}
          own={desk.ownStatusUrl}
          onCall={desk.onCall}
          onClose={() => setEditing(false)}
        />
      )}
    </Section>
  );
}

function IncidentRow({ incident, onOpen }: { incident: Incident; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/40"
    >
      <StateDot state={incident.resolvedAt ? "operational" : incident.impact} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink">{incident.title}</span>
        <span className="block truncate text-[12px] text-ink-3">
          {incident.resolvedAt
            ? `Resolved · ${incidentSpan(incident)}`
            : `${incidentLine(incident)} · ${incidentStateNames[incident.state]} · updated ${ago(incident.updatedAt)}`}
        </span>
      </span>
      <Icon name="chevronRight" size={14} className="text-ink-3" />
    </button>
  );
}

/** What an incident touches: a box for each service. */
function ServicePicker({
  value,
  onChange,
}: {
  value: StatusService[];
  onChange: (value: StatusService[]) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] text-ink-2">What it touches</legend>
      <div className="grid gap-2 @md/app:grid-cols-2">
        {statusServices.map((s) => (
          <Choice
            key={s}
            checked={value.includes(s)}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, s] : value.filter((v) => v !== s))
            }
          >
            {statusServiceNames[s]}
          </Choice>
        ))}
      </div>
    </fieldset>
  );
}

function ImpactSelect({
  value,
  onChange,
}: {
  value: IncidentImpact;
  onChange: (value: IncidentImpact) => void;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as IncidentImpact)}>
      {incidentImpacts.map((i) => (
        <option key={i} value={i}>
          {incidentImpactNames[i]}
        </option>
      ))}
    </Select>
  );
}

function StateSelect({
  value,
  onChange,
  label,
}: {
  value: IncidentState;
  onChange: (value: IncidentState) => void;
  label?: string;
}) {
  return (
    <Select
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as IncidentState)}
    >
      {incidentStates.map((s) => (
        <option key={s} value={s}>
          {incidentStateNames[s]}
        </option>
      ))}
    </Select>
  );
}

/** A new incident: what is wrong, what it touches and how badly, and the first update. */
function PostIncidentDialog({ onClose }: { onClose: () => void }) {
  const post = usePostIncident();
  const [title, setTitle] = useState("");
  const [services, setServices] = useState<StatusService[]>([]);
  const [impact, setImpact] = useState<IncidentImpact>("partial");
  const [state, setState] = useState<IncidentState>("investigating");
  const [body, setBody] = useState("");
  const [began, setBegan] = useState("");
  const [ended, setEnded] = useState("");
  const [tried, setTried] = useState(false);
  const ready = title.trim() && body.trim() && services.length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!ready) return;
    post.mutate(
      {
        title,
        services,
        impact,
        state,
        body,
        startedAt: instantOf(began),
        ...(state === "resolved" && ended ? { resolvedAt: instantOf(ended) } : {}),
      },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      title="Post an incident"
      description="It shows at once on the status page, in the help menu and on the Support page."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="post-incident" disabled={post.isPending}>
            {post.isPending ? "Posting" : "Post"}
          </Button>
        </>
      }
    >
      <form id="post-incident" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field
          label="Title"
          error={tried && !title.trim() ? "Say what is wrong, in a line" : undefined}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Uploads are failing"
            maxLength={140}
            autoFocus
          />
        </Field>
        <ServicePicker value={services} onChange={setServices} />
        {tried && services.length === 0 && (
          <p role="alert" className="m-0 -mt-2 text-[12px] text-signal">
            Choose what it touches
          </p>
        )}
        <div className="grid gap-4 @md/app:grid-cols-2">
          <Field label="How badly">
            <ImpactSelect value={impact} onChange={setImpact} />
          </Field>
          <Field label="Where it stands">
            <StateSelect value={state} onChange={setState} />
          </Field>
        </div>
        <Field
          label="What is happening"
          hint="Plain words for everyone who uses the instance: what they will notice, and what you are doing."
          error={tried && !body.trim() ? "Say what is happening" : undefined}
        >
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-28" />
        </Field>
        <div className="grid gap-4 @md/app:grid-cols-2">
          <Field label="Began" hint="Leave empty for now; set it for one posted after the fact.">
            <Input
              type="datetime-local"
              value={began}
              max={localValue(new Date())}
              onChange={(e) => setBegan(e.target.value)}
            />
          </Field>
          {state === "resolved" && (
            <Field label="Ended" hint="Leave empty for now.">
              <Input
                type="datetime-local"
                value={ended}
                max={localValue(new Date())}
                onChange={(e) => setEnded(e.target.value)}
              />
            </Field>
          )}
        </div>
        {post.error && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {post.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** An incident: its updates, and the next one, which may resolve it. */
function IncidentDialog({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const update = useUpdateIncident(incident.id);
  const remove = useRemoveIncident();
  const [state, setState] = useState<IncidentState>(
    incident.resolvedAt
      ? "investigating"
      : incident.state === "investigating"
        ? "identified"
        : incident.state,
  );
  const [impact, setImpact] = useState<IncidentImpact>(incident.impact);
  const [services, setServices] = useState<StatusService[]>(incident.services);
  const [body, setBody] = useState("");
  const [removing, setRemoving] = useState(false);
  const changed = impact !== incident.impact || services.join() !== incident.services.join();
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim() || services.length === 0) return;
    update.mutate(
      { state, body, ...(changed ? { impact, services } : {}) },
      { onSuccess: () => setBody("") },
    );
  };
  return (
    <Dialog
      title={incident.title}
      description={`${incidentLine(incident)} · ${incidentSpan(incident)}`}
      onClose={onClose}
      width="lg"
      footer={
        removing ? (
          <>
            <span className="flex-1 text-[13px] text-ink-2">
              Take it off the status page, with its updates?
            </span>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Keep it
            </Button>
            <Button
              variant="primary"
              disabled={remove.isPending}
              onClick={() => remove.mutate(incident.id, { onSuccess: onClose })}
            >
              Remove
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setRemoving(true)}>
              Remove
            </Button>
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="incident-update"
              disabled={!body.trim() || services.length === 0 || update.isPending}
            >
              {state === "resolved" && !incident.resolvedAt ? "Resolve" : "Post update"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <form id="incident-update" onSubmit={send} className="flex flex-col gap-4">
          <div className="grid gap-4 @md/app:grid-cols-2">
            <Field label="Where it stands">
              <StateSelect value={state} onChange={setState} />
            </Field>
            <Field label="How badly">
              <ImpactSelect value={impact} onChange={setImpact} />
            </Field>
          </div>
          <ServicePicker value={services} onChange={setServices} />
          <Field label="Update">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                state === "resolved"
                  ? "What was wrong, and that it is fixed"
                  : "What is known now, and what happens next"
              }
              className="h-24"
            />
          </Field>
          {(update.error ?? remove.error) && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {update.error?.message ?? remove.error?.message}
            </p>
          )}
        </form>
        <section className="flex flex-col gap-3">
          <h3 className="eyebrow m-0">Updates</h3>
          <IncidentUpdates incident={incident} />
        </section>
      </div>
    </Dialog>
  );
}

/** Where the help menu and the Support page link: this instance's page, or another. */
function StatusAddressDialog({
  current,
  fallback,
  own,
  onCall,
  onClose,
}: {
  current: string | null;
  fallback: string | null;
  own: string;
  onCall: string | null;
  onClose: () => void;
}) {
  const save = useSaveDesk();
  const [elsewhere, setElsewhere] = useState(current !== null);
  const [url, setUrl] = useState(current ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      { statusUrl: elsewhere ? url.trim() || null : null, onCall },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      title="Status page"
      description="Where the help menu and the Support page link. Incidents posted here show in the app whichever it is."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="status-address" disabled={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form id="status-address" onSubmit={submit} className="flex flex-col gap-3">
        <Choice
          type="radio"
          name="status-page"
          checked={!elsewhere}
          onChange={() => setElsewhere(false)}
          hint={
            fallback
              ? `HEKATE_STATUS_URL is set, so links go to ${hostOf(fallback)}; clear it for ${hostOf(own)}.`
              : `${hostOf(own)}, with the incidents posted here.`
          }
        >
          {fallback ? "As the environment says" : "This instance’s own page"}
        </Choice>
        <Choice
          type="radio"
          name="status-page"
          checked={elsewhere}
          onChange={() => setElsewhere(true)}
          hint="A page of your own, kept somewhere that stays up when this instance does not."
        >
          Another address
        </Choice>
        {elsewhere && (
          <Field label="Address" error={save.error?.message}>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://status.example.com"
              type="url"
              autoFocus
            />
          </Field>
        )}
      </form>
    </Dialog>
  );
}
