import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { IncidentUpdates, incidentLine, incidentSpan, StateDot } from "~/components/incidents";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import {
  impactNames,
  incidentStateNames,
  openIncident,
  pastIncidents,
  type StatusIncident,
  statusServices,
} from "~/data/status";
import { useScreenState } from "~/viewer/state-gate";

/**
 * Where people look for help (#183): the status page's rows on the Support page. Each open
 * incident as its own row, read before a ticket is written; otherwise one quiet row saying how
 * long it has been. The switcher's failed state opens one.
 */
export function StatusRows({ hint }: { hint?: string }) {
  const state = useScreenState();
  const navigate = useNavigate();
  const open = (
    <Button variant="ghost" size="md" onClick={() => navigate({ to: "/status" })}>
      Open
    </Button>
  );
  if (state === "failed")
    return (
      <Row
        name={
          <span className="flex items-center gap-2">
            <StateDot state={openIncident.impact} />
            {openIncident.title}
          </span>
        }
        hint={`${impactNames[openIncident.impact]} · ${incidentStateNames[openIncident.state]} · updated 19 minutes ago`}
      >
        {open}
      </Row>
    );
  return (
    <Row
      name={
        <span className="flex items-center gap-2">
          <StateDot state="operational" />
          Status
        </span>
      }
      hint={hint ? `No incidents in 41 days. ${hint}` : "No incidents in 41 days"}
    >
      {open}
    </Row>
  );
}

/**
 * The status page on the instance's Support section (#183): what is open and what was lately,
 * posting an incident and its updates, and where the help menu links. Every operator's, with
 * tickets in the app or not.
 */
export function StatusDesk({ incidentOpen }: { incidentOpen: boolean }) {
  const [posting, setPosting] = useState(false);
  const [shown, setShown] = useState<StatusIncident | null>(null);
  const [editing, setEditing] = useState(false);
  const list = [...(incidentOpen ? [openIncident] : []), ...pastIncidents];
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
      {list.map((i) => (
        <button
          key={i.id}
          type="button"
          onClick={() => setShown(i)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-raised/40"
        >
          <StateDot state={i.resolved ? "operational" : i.impact} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-ink">{i.title}</span>
            <span className="block truncate text-[12px] text-ink-3">
              {i.resolved
                ? `Resolved · ${incidentSpan(i)}`
                : `${incidentLine(i)} · ${incidentStateNames[i.state]} · updated 19 minutes ago`}
            </span>
          </span>
          <Icon name="chevronRight" size={14} className="text-ink-3" />
        </button>
      ))}
      <Row
        name="Address"
        hint="review.endlesshall.example/status · this instance’s own page, readable signed out"
      >
        <Button variant="ghost" size="md">
          Open
        </Button>
        <Button variant="ghost" size="md" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </Row>
      {posting && <PostIncidentDialog onClose={() => setPosting(false)} />}
      {shown && <IncidentDialog incident={shown} onClose={() => setShown(null)} />}
      {editing && <StatusAddressDialog onClose={() => setEditing(false)} />}
    </Section>
  );
}

function ServicePicker({ chosen }: { chosen: string[] }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1.5 p-0 text-[13px] text-ink-2">What it touches</legend>
      <div className="grid gap-2 @md/app:grid-cols-2">
        {statusServices.map((s) => (
          <label key={s.id} className="flex items-center gap-2.5 text-[14px] text-ink">
            <input type="checkbox" defaultChecked={chosen.includes(s.id)} />
            {s.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StateOptions() {
  return (
    <>
      {Object.entries(incidentStateNames).map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </>
  );
}

function ImpactOptions() {
  return (
    <>
      {Object.entries(impactNames).map(([id, name]) => (
        <option key={id} value={id}>
          {name}
        </option>
      ))}
    </>
  );
}

/** A new incident: what is wrong, what it touches and how badly, and the first update. */
function PostIncidentDialog({ onClose }: { onClose: () => void }) {
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
          <Button variant="primary" onClick={onClose}>
            Post
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Title
          <Input placeholder="Uploads are failing" autoFocus />
        </label>
        <ServicePicker chosen={[]} />
        <div className="grid gap-4 @md/app:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            How badly
            <Select defaultValue="partial">
              <ImpactOptions />
            </Select>
          </label>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Where it stands
            <Select defaultValue="investigating">
              <StateOptions />
            </Select>
          </label>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          What is happening
          <Textarea className="h-28" />
          <span className="text-[12px] text-ink-3">
            Plain words for everyone who uses the instance: what they will notice, and what you are
            doing.
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2 @md/app:w-1/2">
          Began
          <Input type="datetime-local" />
          <span className="text-[12px] text-ink-3">
            Leave empty for now; set it for one posted after the fact.
          </span>
        </label>
      </div>
    </Dialog>
  );
}

/** An incident: the next update, which may resolve it, over the updates so far. */
function IncidentDialog({ incident, onClose }: { incident: StatusIncident; onClose: () => void }) {
  return (
    <Dialog
      title={incident.title}
      description={`${incidentLine(incident)} · ${incidentSpan(incident)}`}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost">Remove</Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={onClose}>
            Post update
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 @md/app:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Where it stands
              <Select defaultValue={incident.resolved ? "investigating" : "monitoring"}>
                <StateOptions />
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              How badly
              <Select defaultValue={incident.impact}>
                <ImpactOptions />
              </Select>
            </label>
          </div>
          <ServicePicker chosen={incident.services} />
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Update
            <Textarea className="h-24" placeholder="What is known now, and what happens next" />
          </label>
        </div>
        <section className="flex flex-col gap-3">
          <h3 className="eyebrow m-0">Updates</h3>
          <IncidentUpdates incident={incident} authors />
        </section>
      </div>
    </Dialog>
  );
}

/** Where the help menu and the Support page link: this instance's page, or another. */
function StatusAddressDialog({ onClose }: { onClose: () => void }) {
  const [elsewhere, setElsewhere] = useState(false);
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
          <Button variant="primary" onClick={onClose}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-start gap-2.5 text-[14px] text-ink">
          <input
            type="radio"
            name="status-page"
            className="mt-1"
            checked={!elsewhere}
            onChange={() => setElsewhere(false)}
          />
          <span>
            This instance’s own page
            <span className="block text-[13px] text-ink-3">
              review.endlesshall.example/status, with the incidents posted here.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2.5 text-[14px] text-ink">
          <input
            type="radio"
            name="status-page"
            className="mt-1"
            checked={elsewhere}
            onChange={() => setElsewhere(true)}
          />
          <span>
            Another address
            <span className="block text-[13px] text-ink-3">
              A page of your own, kept somewhere that stays up when this instance does not.
            </span>
          </span>
        </label>
        {elsewhere && (
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Address
            <Input type="url" placeholder="https://status.example.com" autoFocus />
          </label>
        )}
      </div>
    </Dialog>
  );
}
