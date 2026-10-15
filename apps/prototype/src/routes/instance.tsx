import { useState } from "react";
import type { IconName } from "~/components/icons";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { Danger, Row, Section, SwitchRow } from "~/components/settings";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { useScreenState } from "~/viewer/state-gate";

/** The operator's side of the same application: the organisations and the machine, nothing of the content. */
export const instanceSections: { id: string; label: string; icon: IconName; hint: string }[] = [
  {
    id: "overview",
    label: "Overview",
    icon: "dashboard",
    hint: "Health at a glance and what moved",
  },
  {
    id: "organisations",
    label: "Organisations",
    icon: "building",
    hint: "Each is a tenant: its own members, projects, settings and keys",
  },
  {
    id: "people",
    label: "People",
    icon: "users",
    hint: "Every account on the instance, across organisations",
  },
  {
    id: "queues",
    label: "Queues",
    icon: "clock",
    hint: "The jobs: transcoding, analysis, mail, webhooks",
  },
  {
    id: "logs",
    label: "Logs",
    icon: "list",
    hint: "What the server, the worker and the proxy wrote",
  },
  {
    id: "storage",
    label: "Storage",
    icon: "database",
    hint: "Backends, usage, keys and reconciliation",
  },
  { id: "debug", label: "Debug tools", icon: "sliders", hint: "Inspect, replay, flag and bundle" },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    hint: "Registration, defaults, address and mail",
  },
  { id: "operations", label: "Operations", icon: "server", hint: "Backups, upgrades, capacity" },
];

const tenants = [
  {
    id: "t-1",
    name: "Endless Hall Records",
    host: "endlesshall",
    members: 4,
    projects: 2,
    storage: "245 GB",
    state: "active",
    since: "2 Aug 2026",
  },
  {
    id: "t-2",
    name: "North Choir Collective",
    host: "northchoir",
    members: 11,
    projects: 6,
    storage: "1.1 TB",
    state: "active",
    since: "19 Aug 2026",
  },
  {
    id: "t-3",
    name: "Lantern Pictures",
    host: "lantern",
    members: 3,
    projects: 1,
    storage: "88 GB",
    state: "suspended",
    since: "4 Sep 2026",
  },
];

const accounts = [
  {
    name: "Alex Rivera",
    email: "alex@endlesshall.example",
    orgs: "Endless Hall Records (owner)",
    seen: "2 min",
    state: "active",
    factor: "passkey",
  },
  {
    name: "Ines Arlow",
    email: "ines@endlesshall.example",
    orgs: "Endless Hall Records (admin)",
    seen: "1 h",
    state: "active",
    factor: "app",
  },
  {
    name: "Tomas Varga",
    email: "tomas@endlesshall.example",
    orgs: "Endless Hall Records, North Choir Collective",
    seen: "yesterday",
    state: "active",
    factor: "none",
  },
  {
    name: "Mira Solberg",
    email: "mira@solberg.example",
    orgs: "Guest in 2 organisations",
    seen: "3 d",
    state: "guest",
    factor: "link",
  },
  {
    name: "Priya Haldar",
    email: "priya@northchoir.example",
    orgs: "North Choir Collective (owner)",
    seen: "4 h",
    state: "active",
    factor: "passkey",
  },
  {
    name: "Owen Castell",
    email: "owen@lantern.example",
    orgs: "Lantern Pictures (owner)",
    seen: "12 d",
    state: "suspended",
    factor: "app",
  },
];

const queues = [
  {
    name: "transcode",
    hint: "HLS renditions and proxies",
    waiting: 2,
    active: 1,
    failed: 0,
    p95: "41 s",
  },
  {
    name: "analyse",
    hint: "Loudness, peaks, QA rules",
    waiting: 0,
    active: 1,
    failed: 0,
    p95: "12 s",
  },
  { name: "waveform", hint: "Peaks for the player", waiting: 0, active: 0, failed: 0, p95: "3 s" },
  { name: "pages", hint: "Score and document pages", waiting: 0, active: 0, failed: 1, p95: "6 s" },
  { name: "mail", hint: "Every message out", waiting: 0, active: 0, failed: 0, p95: "0.8 s" },
  {
    name: "webhooks",
    hint: "Slack, Discord, custom",
    waiting: 0,
    active: 0,
    failed: 3,
    p95: "1.2 s",
  },
  {
    name: "maintenance",
    hint: "Expiry, orphans, reconciliation",
    waiting: 1,
    active: 0,
    failed: 0,
    p95: "2 min",
  },
];

const jobs = [
  {
    id: "j-8f21",
    queue: "transcode",
    what: "Maple Leaf Rag - V3 dry.wav",
    state: "active",
    when: "19 s",
    org: "Endless Hall Records",
  },
  {
    id: "j-8f20",
    queue: "analyse",
    what: "Maple Leaf Rag - V3 dry.wav",
    state: "active",
    when: "19 s",
    org: "Endless Hall Records",
  },
  {
    id: "j-8f1c",
    queue: "pages",
    what: "Solace - Score.pdf",
    state: "failed",
    when: "4 min",
    org: "Endless Hall Records",
  },
  {
    id: "j-8f0a",
    queue: "webhooks",
    what: "Slack: #masters",
    state: "failed",
    when: "22 min",
    org: "North Choir Collective",
  },
  {
    id: "j-8e9d",
    queue: "transcode",
    what: "Opening titles - Cut 3.mov",
    state: "done",
    when: "2 h",
    org: "Endless Hall Records",
  },
  {
    id: "j-8e90",
    queue: "mail",
    what: "Review requested → mira@solberg.example",
    state: "done",
    when: "2 h",
    org: "Endless Hall Records",
  },
];

const logs: [string, string, string, string][] = [
  ["20:41:12.004", "info", "api", "GET /api/files/file-maple-v3/key 200 · 18 ms · session s_4f…"],
  ["20:41:11.880", "info", "worker", "transcode j-8f21 started · 4 lanes · 2 waiting"],
  [
    "20:41:09.211",
    "warn",
    "worker",
    "pages j-8f1c failed: pdf.js could not open page 7 (damaged xref); retry 2 of 3 in 60 s",
  ],
  [
    "20:40:58.410",
    "info",
    "api",
    "POST /api/uploads 201 · 1.9 GB · checked at the door: 2 warnings",
  ],
  [
    "20:40:31.097",
    "info",
    "proxy",
    "tls: certificate for review.endlesshall.example renewed, 89 days",
  ],
  [
    "20:39:50.552",
    "error",
    "webhooks",
    "j-8f0a Slack #masters 429 Too Many Requests; backing off 5 min",
  ],
  ["20:38:02.000", "info", "db", "pg-boss: archived 1 204 completed jobs"],
  ["20:37:44.318", "info", "api", "session s_9a… revoked by its owner"],
];

const backends: { name: string; hint: string; used: number; size: string; state: DotState }[] = [
  {
    name: "Local disk",
    hint: "/var/lib/hekate/objects · ext4",
    used: 0.34,
    size: "1.4 TB of 4 TB",
    state: "approved",
  },
  {
    name: "S3: archive",
    hint: "s3://endlesshall-archive · eu-west-2 · cold",
    used: 0.12,
    size: "88 GB of 1 TB",
    state: "approved",
  },
];

function Tile({
  label,
  value,
  hint,
  flag,
}: {
  label: string;
  value: string;
  hint: string;
  flag?: boolean;
}) {
  return (
    <div className="bg-raised/25 px-4 py-3">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div
        className={cn(
          "tabular mt-1 text-[24px] leading-none font-medium",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
      </div>
      <div className="mt-1.5 text-[12px] text-ink-3">{hint}</div>
    </div>
  );
}

function Level({ level }: { level: string }) {
  return (
    <span
      className={cn(
        "w-11 shrink-0 text-[11px] uppercase",
        level === "error" ? "text-signal" : level === "warn" ? "text-ink" : "text-ink-3",
      )}
    >
      {level}
    </span>
  );
}

export function InstancePage({ section }: { section: string }) {
  const state = useScreenState();
  const [creating, setCreating] = useState(false);
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [q, setQ] = useState("");
  const sec = instanceSections.some((s) => s.id === section) ? section : "overview";
  const meta = instanceSections.find((s) => s.id === sec) ?? instanceSections[0];
  usePageHeader({
    crumbs: [{ label: "Instance", to: "/instance" }],
    title: meta?.label ?? "Instance",
    actions:
      sec === "organisations" ? (
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Icon name="plus" size={14} />
          Organisation
        </Button>
      ) : sec === "debug" ? (
        <Button variant="secondary" size="sm">
          <Icon name="download" size={14} />
          Support bundle
        </Button>
      ) : undefined,
  });
  const list =
    state === "empty"
      ? tenants.slice(0, 1)
      : state === "long"
        ? [...tenants, ...tenants, ...tenants].map((t, i) => ({ ...t, id: `${t.id}-${String(i)}` }))
        : tenants;
  const workerDown = state === "failed";
  const lines = logs.filter(
    ([, l, s, text]) =>
      (!level || l === level) &&
      (!source || s === source) &&
      (!q || text.toLowerCase().includes(q.toLowerCase())),
  );
  const health: [string, string, DotState][] = [
    ["API", "p95 142 ms over the last hour · 2 instances", "approved"],
    ["Database", "PostgreSQL 18.1 · 2.1 GB · 12 of 100 connections", "approved"],
    [
      "Worker",
      workerDown ? "Not running since 20:12" : "ffmpeg 7.1 · 4 lanes · 2 busy",
      workerDown ? "changes_requested" : "approved",
    ],
    ["Storage", "2 backends reachable · last reconciliation 02:10", "approved"],
    ["Mail", "SMTP · last message 2 h ago · 0 bounces today", "approved"],
    ["Proxy", "Caddy · TLS renewed · HTTP/3 on", "approved"],
    ["Metrics", "/metrics scraped 14 s ago", "approved"],
  ];
  return (
    <Page className="gap-10">
      <div>
        <h1 className="title">{meta?.label}</h1>
        <p className="mt-1.5 max-w-[620px] text-[14px] text-ink-2">
          {meta?.hint}. review.endlesshall.example · hekate 0.2.0.
        </p>
      </div>

      {sec === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-6">
            <Tile label="Organisations" value={String(list.length)} hint="1 suspended" />
            <Tile label="People" value="18" hint="3 guests with live links" />
            <Tile label="Storage" value="1.4 TB" hint="34% of the disk" />
            <Tile
              label="Queue"
              value={workerDown ? "38" : "3"}
              hint={workerDown ? "worker down" : "2 lanes busy"}
              flag={workerDown}
            />
            <Tile label="Failed today" value="4" hint="3 webhooks, 1 page render" flag />
            <Tile label="Uptime" value="41 d" hint="since 0.2.0" />
          </div>
          <Section title="Health" intro="Every part of the machine, checked every 15 seconds.">
            {health.map(([name, hint, dot]) => (
              <Row key={name} name={name} hint={hint}>
                <Dot state={dot} />
                {name === "Worker" && workerDown && (
                  <Button variant="secondary" size="md">
                    Start
                  </Button>
                )}
              </Row>
            ))}
          </Section>
          <Section title="Recently">
            {[
              ["North Choir Collective", "uploaded 41 files", "2h"],
              ["Endless Hall Records", "rotated its keys", "3 Oct"],
              ["Lantern Pictures", "was suspended for non-payment", "11 Oct"],
              ["Instance", "upgraded to 0.2.0; migrations 0041 to 0044 applied", "4 Sep"],
            ].map(([who, what, when]) => (
              <Row
                key={String(who) + String(what)}
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

      {sec === "organisations" && (
        <Section
          title="Organisations"
          intro="Each has its own subdomain, members, projects, settings and keys. Suspending one keeps everything and lets nobody in."
        >
          {list.map((t) => (
            <Row
              key={t.id}
              name={
                <span className="flex items-center gap-2">
                  <Dot state={t.state === "active" ? "approved" : "cancelled"} />
                  {t.name}
                  <span className="tabular text-[12px] text-ink-3">
                    {t.host}.review.endlesshall.example
                  </span>
                </span>
              }
              hint={`${t.members} members · ${t.projects} projects · ${t.storage} · since ${t.since}${t.state === "suspended" ? " · suspended" : ""}`}
            >
              <ActionMenu
                always
                label={t.name}
                actions={[
                  { label: "Open as its owner (logged)", onSelect: () => {} },
                  { label: "Limits…", onSelect: () => {} },
                  { label: "Rotate keys", onSelect: () => {} },
                  { label: "Export everything", onSelect: () => {} },
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
        </Section>
      )}

      {sec === "people" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Name or email" className="w-64" />
            <Select defaultValue="" className="w-44">
              <option value="">Any organisation</option>
              {tenants.map((t) => (
                <option key={t.id}>{t.name}</option>
              ))}
            </Select>
            <Select defaultValue="" className="w-36">
              <option value="">Any state</option>
              <option>Active</option>
              <option>Guest</option>
              <option>Suspended</option>
            </Select>
          </div>
          <Section
            title="Accounts"
            intro="One account can belong to several organisations. What you do here is logged against your name."
          >
            {accounts.map((a) => (
              <Row
                key={a.email}
                name={
                  <span className="flex items-center gap-2">
                    <Dot
                      state={
                        a.state === "active"
                          ? "approved"
                          : a.state === "guest"
                            ? "invited"
                            : "cancelled"
                      }
                    />
                    {a.name}
                    <span className="text-[12px] text-ink-3">{a.email}</span>
                  </span>
                }
                hint={`${a.orgs} · seen ${a.seen} ago · second factor: ${a.factor}`}
              >
                <ActionMenu
                  always
                  label={a.name}
                  actions={[
                    { label: "Send a password reset", onSelect: () => {} },
                    { label: "Reset the second factor", onSelect: () => {} },
                    { label: "Revoke every session", onSelect: () => {} },
                    { label: "Sign in as (logged, with a banner)", onSelect: () => {} },
                    "divider",
                    {
                      label: a.state === "suspended" ? "Reinstate" : "Suspend",
                      danger: a.state !== "suspended",
                      onSelect: () => {},
                    },
                  ]}
                />
              </Row>
            ))}
          </Section>
        </>
      )}

      {sec === "queues" && (
        <>
          <Section
            title="Queues"
            intro="pg-boss in the database. A failed job retries three times with backoff, then waits here."
            action={
              <span className="flex items-center gap-2">
                <Button variant="secondary" size="md">
                  Retry every failure
                </Button>
                <Button variant="ghost" size="md">
                  Pause all
                </Button>
              </span>
            }
          >
            <div className="grid grid-cols-[minmax(0,1fr)_repeat(4,64px)_32px] items-center gap-2 px-4 py-2 @3xl/app:grid-cols-[minmax(0,1fr)_repeat(4,80px)_32px]">
              <Label>Queue</Label>
              <Label className="text-right">Waiting</Label>
              <Label className="text-right">Active</Label>
              <Label className="text-right">Failed</Label>
              <Label className="text-right">p95</Label>
              <span />
            </div>
            {queues.map((qq) => (
              <div
                key={qq.name}
                className="grid grid-cols-[minmax(0,1fr)_repeat(4,64px)_32px] items-center gap-2 px-4 py-2.5 @3xl/app:grid-cols-[minmax(0,1fr)_repeat(4,80px)_32px]"
              >
                <span className="min-w-0">
                  <span className="tabular block text-[14px] text-ink">{qq.name}</span>
                  <span className="block truncate text-[12px] text-ink-3">{qq.hint}</span>
                </span>
                <span className="tabular text-right text-[13px] text-ink-2">{qq.waiting}</span>
                <span className="tabular text-right text-[13px] text-ink-2">{qq.active}</span>
                <span
                  className={cn(
                    "tabular text-right text-[13px]",
                    qq.failed ? "text-signal" : "text-ink-3",
                  )}
                >
                  {qq.failed}
                </span>
                <span className="tabular text-right text-[13px] text-ink-3">{qq.p95}</span>
                <ActionMenu
                  label={qq.name}
                  actions={[
                    { label: "Retry failed", onSelect: () => {} },
                    { label: "Pause", onSelect: () => {} },
                    { label: "Drain", danger: true, onSelect: () => {} },
                  ]}
                />
              </div>
            ))}
          </Section>
          <Section title="Recent jobs">
            {jobs.map((j) => (
              <Row
                key={j.id}
                name={
                  <span className="flex items-center gap-2">
                    <Dot
                      state={
                        j.state === "done"
                          ? "approved"
                          : j.state === "active"
                            ? "working"
                            : "changes_requested"
                      }
                    />
                    <span className="tabular text-[12px] text-ink-3">{j.queue}</span>
                    {j.what}
                  </span>
                }
                hint={`${j.org} · ${j.id} · ${j.when} ago`}
              >
                {j.state === "failed" && (
                  <Button variant="secondary" size="md">
                    Retry
                  </Button>
                )}
                <Button variant="ghost" size="md">
                  Details
                </Button>
              </Row>
            ))}
          </Section>
        </>
      )}

      {sec === "logs" && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search the last hour"
              className="w-64"
            />
            <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-32">
              <option value="">Any level</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </Select>
            <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-36">
              <option value="">Any source</option>
              {["api", "worker", "proxy", "db", "webhooks"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <span className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="md">
                Live
              </Button>
              <Button variant="secondary" size="md">
                <Icon name="download" size={14} />
                Export
              </Button>
            </span>
          </div>
          <div className="rounded-panel-lg border border-line bg-canvas/60 font-mono text-[12.5px] leading-[1.6]">
            {lines.length === 0 ? (
              <p className="px-4 py-6 text-center font-sans text-[13px] text-ink-3">
                Nothing matches.
              </p>
            ) : (
              lines.map(([time, l, s, text]) => (
                <div
                  key={time + text}
                  className="flex gap-3 border-b border-line/60 px-4 py-1.5 last:border-b-0"
                >
                  <span className="tabular shrink-0 text-ink-3">{time}</span>
                  <Level level={l} />
                  <span className="w-16 shrink-0 text-ink-2">{s}</span>
                  <span
                    className={cn("min-w-0 break-words", l === "error" ? "text-ink" : "text-ink-2")}
                  >
                    {text}
                  </span>
                </div>
              ))
            )}
          </div>
          <p className="text-[12px] text-ink-3">
            Structured JSON on disk, 30 days; ship them with the OpenTelemetry exporter in Settings.
            Nothing personal is written beyond what the access log keeps.
          </p>
        </>
      )}

      {sec === "storage" && (
        <>
          <Section
            title="Backends"
            intro="Every object is encrypted with its own key before it is written; a backend only ever holds ciphertext."
          >
            {backends.map((b) => (
              <Row key={b.name} name={b.name} hint={b.hint}>
                <span className="flex w-56 flex-col gap-1">
                  <span className="flex justify-between text-[12px] text-ink-3">
                    <span>{b.size}</span>
                    <span className="tabular">{Math.round(b.used * 100)}%</span>
                  </span>
                  <span className="h-1 overflow-hidden rounded-full bg-raised">
                    <span
                      className="block h-full rounded-full bg-ink-2"
                      style={{ width: `${b.used * 100}%` }}
                    />
                  </span>
                </span>
                <Dot state={b.state} />
              </Row>
            ))}
            <Row
              name="Add a backend"
              hint="Local disk or anything S3-compatible; organisations pick per project."
            >
              <Button variant="secondary" size="md">
                Add
              </Button>
            </Row>
          </Section>
          <Section title="By organisation">
            {tenants.map((t) => (
              <Row key={t.id} name={t.name} hint={`${t.projects} projects`}>
                <span className="tabular text-[13px] text-ink-2">{t.storage}</span>
              </Row>
            ))}
          </Section>
          <Section title="Keys and housekeeping">
            <Row
              name="Master key"
              hint="In the environment; wraps every file key. Last rotated 2 Oct; the previous key is kept until every file is rewrapped."
            >
              <Button variant="secondary" size="md">
                Rotate
              </Button>
            </Row>
            <Row
              name="Orphans"
              hint="Objects with no file row, and rows with no object. Last scan 02:10: 0 and 0."
            >
              <Button variant="secondary" size="md">
                Scan now
              </Button>
            </Row>
            <Row
              name="Reconciliation"
              hint="Checks every object's hash against the database, nightly, a slice at a time."
            >
              <span className="text-[13px] text-ink-2">12% per night · 0 mismatches</span>
            </Row>
          </Section>
        </>
      )}

      {sec === "debug" && (
        <>
          <Section
            title="Inspect"
            intro="Read-only views of what the system holds, with the ids you get from a report."
          >
            <Row
              name="A file"
              hint="Its rows, its objects, its keys, its renditions and every job that touched it."
            >
              <Input placeholder="file-… or a URL" className="w-64" />
              <Button variant="secondary" size="md">
                Inspect
              </Button>
            </Row>
            <Row
              name="A session"
              hint="Who, where from, what it may reach, the keys it was issued."
            >
              <Input placeholder="s_…" className="w-64" />
              <Button variant="secondary" size="md">
                Inspect
              </Button>
            </Row>
            <Row name="A request" hint="Trace by its id from the response headers.">
              <Input placeholder="req_…" className="w-64" />
              <Button variant="secondary" size="md">
                Trace
              </Button>
            </Row>
          </Section>
          <Section title="Replay and run">
            <Row
              name="Replay a webhook"
              hint="Send a past delivery again to its channel, or to a URL of yours."
            >
              <Button variant="secondary" size="md">
                Pick a delivery
              </Button>
            </Row>
            <Row name="Run the checks on a file" hint="The QA rules, now, with the output kept.">
              <Button variant="secondary" size="md">
                Pick a file
              </Button>
            </Row>
            <Row name="Send a test of every email" hint="To your own address, with sample content.">
              <Button variant="secondary" size="md">
                Send
              </Button>
            </Row>
          </Section>
          <Section
            title="Flags"
            intro="Features that can be turned on for the instance before they are on by default."
          >
            <SwitchRow name="Immersive playback (binaural render)" checked />
            <SwitchRow name="Frame-accurate scrubbing on H.265" checked={false} />
            <SwitchRow
              name="Verbose logging for the worker"
              hint="For an hour, then off by itself."
              checked={false}
            />
          </Section>
          <Danger>
            <Row
              name="Clear the rendition cache"
              hint="Proxies and page images are rebuilt on demand; originals are untouched."
            >
              <Button variant="secondary" size="md">
                Clear
              </Button>
            </Row>
          </Danger>
        </>
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
          <Section title="Address and mail">
            <Row name="Address">
              <Input
                defaultValue="https://review.endlesshall.example"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <Row
              name="Organisation subdomains"
              hint="Each organisation answers at its own name under the address; single sign-on picks the organisation from it."
            >
              <span className="tabular text-[13px] text-ink-2">*.review.endlesshall.example</span>
            </Row>
            <Row name="Instance mail" hint="Used when an organisation sets no channel of its own">
              <span className="text-[13px] text-ink-2">SMTP · mail.endlesshall.example</span>
              <Button variant="secondary" size="md">
                Test
              </Button>
            </Row>
            <Row
              name="Telemetry"
              hint="OpenTelemetry traces and logs to a collector of yours; nothing leaves otherwise."
            >
              <Input placeholder="https://otel.example:4318" className="w-64" />
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
          <Section title="Backups and upgrades">
            <Row
              name="Backups"
              hint="Nightly: database, the master key's wrapped copy, nothing of the objects (the backends keep those)"
            >
              <span className="text-[13px] text-ink-2">Today 02:00 · verified</span>
              <Button variant="secondary" size="md">
                Back up now
              </Button>
            </Row>
            <Row name="Restore" hint="Into a fresh instance, from a backup and the master key.">
              <Button variant="ghost" size="md">
                How to
              </Button>
            </Row>
            <Row
              name="Upgrade"
              hint="0.2.1 is out: pull, migrate on start, keep the previous image until healthy."
            >
              <Button variant="secondary" size="md">
                Release notes
              </Button>
              <Button variant="primary" size="md">
                Upgrade
              </Button>
            </Row>
          </Section>
          <Section title="Capacity">
            <Row name="Worker lanes" hint="Transcodes run one per lane; more lanes need more CPU.">
              <Select defaultValue="4" className="w-28">
                {["2", "4", "8"].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </Select>
            </Row>
            <Row name="Upload limit" hint="Per file.">
              <Select defaultValue="50" className="w-28">
                {["20", "50", "200"].map((n) => (
                  <option key={n}>{n} GB</option>
                ))}
              </Select>
            </Row>
            <Row
              name="Rate limits"
              hint="Sign-in attempts, key issues and downloads, per address and per account."
            >
              <Button variant="ghost" size="md">
                Edit
              </Button>
            </Row>
          </Section>
        </>
      )}

      {creating && (
        <Dialog
          title="New organisation"
          description="A tenant of its own: subdomain, members, projects, settings and keys."
          onClose={() => setCreating(false)}
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
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Name
              <Input placeholder="Lantern Pictures" autoFocus />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Subdomain
              <span className="flex items-center gap-2">
                <Input placeholder="lantern" className="w-40" />
                <span className="text-[13px] text-ink-3">.review.endlesshall.example</span>
              </span>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              First owner's email
              <Input placeholder="owner@lantern.example" />
            </label>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
