import { useState } from "react";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Danger, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { useScreenState } from "~/viewer/state-gate";

const sections = [
  { id: "overview", label: "Overview" },
  { id: "tenants", label: "Tenants" },
  { id: "settings", label: "Settings" },
  { id: "operations", label: "Operations" },
];

const tenants = [
  {
    id: "t-1",
    name: "Endless Hall Records",
    members: 4,
    projects: 2,
    storage: "245 GB",
    state: "active",
    since: "2 Aug 2026",
  },
  {
    id: "t-2",
    name: "North Choir Collective",
    members: 11,
    projects: 6,
    storage: "1.1 TB",
    state: "active",
    since: "19 Aug 2026",
  },
  {
    id: "t-3",
    name: "Lantern Pictures",
    members: 3,
    projects: 1,
    storage: "88 GB",
    state: "suspended",
    since: "4 Sep 2026",
  },
];

/** The operator's side: tenants and the instance, nothing of the content. */
export function InstancePage({ section }: { section: string }) {
  const state = useScreenState();
  const [creating, setCreating] = useState(false);
  usePageHeader({ title: "Instance", heading: "page" });
  const sec = sections.some((s) => s.id === section) ? section : "overview";
  const list =
    state === "empty"
      ? tenants.slice(0, 1)
      : state === "long"
        ? [...tenants, ...tenants, ...tenants].map((t, i) => ({ ...t, id: `${t.id}-${String(i)}` }))
        : tenants;
  return (
    <SettingsLayout
      title="This instance"
      intro="review.endlesshall.example · hekate 0.2.0. What is here is the organisations and the machine; their content is theirs."
      sections={sections}
      current={sec}
      base="/instance/$section"
      param="section"
    >
      {sec === "overview" && (
        <>
          <Section title="At a glance">
            <Row name="Organisations">
              <span className="tabular text-[14px] text-ink">{list.length}</span>
            </Row>
            <Row name="People" hint="Members across every organisation; guests are not counted">
              <span className="tabular text-[14px] text-ink">
                {list.reduce((n, t) => n + t.members, 0)}
              </span>
            </Row>
            <Row name="Storage" hint="Across every backend">
              <span className="tabular text-[14px] text-ink">1.4 TB</span>
            </Row>
            <Row name="Worker">
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px]",
                  state === "failed" ? "text-signal" : "text-ink-2",
                )}
              >
                <Dot state={state === "failed" ? "changes_requested" : "approved"} />
                {state === "failed" ? "Off" : "On · queue 2"}
              </span>
            </Row>
          </Section>
          <Section title="Recently">
            {[
              ["North Choir Collective", "uploaded 41 files", "2h"],
              ["Endless Hall Records", "rotated its keys", "3 Oct"],
              ["Lantern Pictures", "was suspended for non-payment", "11 Oct"],
            ].map(([who, what, when]) => (
              <Row
                key={String(who)}
                name={
                  <span>
                    <span className="text-ink">{who}</span>{" "}
                    <span className="text-ink-2">{what}</span>
                  </span>
                }
              >
                <span className="tabular text-[12px] text-ink-3">{when}</span>
              </Row>
            ))}
          </Section>
        </>
      )}
      {sec === "tenants" && (
        <Section
          title="Organisations"
          intro="Each is a tenant: its own members, projects, settings and keys."
          action={
            <Button variant="secondary" size="md" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              Organisation
            </Button>
          }
        >
          {list.map((t) => (
            <Row
              key={t.id}
              name={
                <span className="flex items-center gap-2">
                  <Dot state={t.state === "active" ? "approved" : "cancelled"} />
                  {t.name}
                </span>
              }
              hint={`${t.members} members · ${t.projects} projects · ${t.storage} · since ${t.since}${t.state === "suspended" ? " · suspended" : ""}`}
            >
              <ActionMenu
                always
                label={t.name}
                actions={[
                  { label: "Usage", onSelect: () => {} },
                  { label: "Limits…", onSelect: () => {} },
                  "divider",
                  {
                    label: t.state === "active" ? "Suspend" : "Reinstate",
                    danger: t.state === "active",
                    onSelect: () => {},
                  },
                ]}
              />
            </Row>
          ))}
          {creating && (
            <Dialog
              title="New organisation"
              description="Its first owner gets an invitation."
              onClose={() => setCreating(false)}
              width="sm"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setCreating(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setCreating(false)}>
                    Create
                  </Button>
                </>
              }
            >
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input placeholder="Organisation" />
              </label>
              <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
                First owner
                <Input type="email" placeholder="owner@example" />
              </label>
              <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
                Storage limit
                <Select defaultValue="1">
                  <option value="0.25">250 GB</option>
                  <option value="1">1 TB</option>
                  <option value="5">5 TB</option>
                  <option value="none">None</option>
                </Select>
              </label>
            </Dialog>
          )}
        </Section>
      )}
      {sec === "settings" && (
        <>
          <Section title="Registration">
            <Row name="New organisations" hint="Who may create one.">
              <Select defaultValue="admin" className="w-56">
                <option value="admin">The instance admin only</option>
                <option value="invite">Anyone invited</option>
                <option value="open">Anyone</option>
              </Select>
            </Row>
            <SwitchRow name="Allow sign-up without an invitation" checked={false} />
          </Section>
          <Section title="Defaults for new organisations">
            <Row name="Storage limit">
              <Select defaultValue="1" className="w-40">
                <option value="0.25">250 GB</option>
                <option value="1">1 TB</option>
                <option value="none">None</option>
              </Select>
            </Row>
            <Row name="Members">
              <Select defaultValue="25" className="w-40">
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="none">No limit</option>
              </Select>
            </Row>
            <Row name="Guest links last">
              <Select defaultValue="14" className="w-40">
                <option value="3">3 days</option>
                <option value="14">14 days</option>
              </Select>
            </Row>
            <SwitchRow name="Forensic marking on" checked />
          </Section>
          <Section title="Public address and mail">
            <Row name="Address">
              <Input
                defaultValue="https://review.endlesshall.example"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <Row name="Instance mail" hint="Used when an organisation sets no channel of its own">
              <span className="text-[13px] text-ink-2">SMTP · mail.endlesshall.example</span>
              <Button variant="secondary" size="md">
                Test
              </Button>
            </Row>
          </Section>
          <Danger>
            <Row name="Maintenance mode" hint="Everyone sees a notice; nothing is lost.">
              <Button variant="secondary" size="md">
                Turn on
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "operations" && (
        <>
          <Section title="Health">
            <Row name="API" hint="p95 142 ms over the last hour">
              <Dot state="approved" />
            </Row>
            <Row name="Database" hint="PostgreSQL 18.1 · 2.1 GB · 12 connections">
              <Dot state="approved" />
            </Row>
            <Row name="Worker" hint="ffmpeg 7.1 · 4 lanes">
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px]",
                  state === "failed" ? "text-signal" : "text-ink-2",
                )}
              >
                <Dot state={state === "failed" ? "changes_requested" : "approved"} />
                {state === "failed" ? "Not running" : "Running"}
              </span>
              {state === "failed" && (
                <Button variant="secondary" size="md">
                  Start
                </Button>
              )}
            </Row>
            <Row name="Queue" hint="Waiting · running · failed today">
              <span className="tabular text-[13px] text-ink-2">
                {state === "failed" ? "38 · 0 · 12" : "2 · 1 · 0"}
              </span>
            </Row>
            <Row
              name="Encryption"
              hint="Master key in the environment; per-file keys in the database"
            >
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                <Dot state={state === "processing" ? "working" : "approved"} />
                {state === "processing" ? "Rotation 61% through" : "Rotated 2 Oct"}
              </span>
            </Row>
            <Row name="Prometheus" hint="/metrics · 14 s ago">
              <Dot state="approved" />
            </Row>
          </Section>
          <Section title="Backups and upgrades">
            <Row
              name="Backups"
              hint="Nightly: database, the master key's wrapped copy, nothing of the objects (the backends keep those)"
            >
              <span className="text-[13px] text-ink-2">Today 02:00 · verified</span>
            </Row>
            <Row
              name="Upgrade"
              hint="0.2.1: pull, migrate on start, keep the previous image until healthy."
            >
              <Button variant="secondary" size="md">
                Release notes
              </Button>
            </Row>
          </Section>
        </>
      )}
    </SettingsLayout>
  );
}
