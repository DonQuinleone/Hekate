import { useState } from "react";
import { Gauge, Spark } from "~/components/charts";
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
    hint: "What needs an operator, and what moved",
  },
  {
    id: "organisations",
    label: "Organisations",
    icon: "building",
    hint: "Every tenant, with its people, projects, storage, settings and keys",
  },
  {
    id: "operators",
    label: "Operators",
    icon: "fingerprint",
    hint: "The accounts that may manage the instance",
  },
  {
    id: "health",
    label: "System health",
    icon: "pulse",
    hint: "The machine, measured: load, latency, errors, queues, storage",
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
    hint: "What happened, by who, through what: audit, authentication, API, mail, webhooks",
  },
  {
    id: "debug",
    label: "Debug tools",
    icon: "sliders",
    hint: "Look up an error reference, see what failed, inspect what is not working",
  },
  {
    id: "system",
    label: "System information",
    icon: "server",
    hint: "Version, build, channel, patches and the environment",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    hint: "Registration, security, defaults, address and mail",
  },
  {
    id: "operations",
    label: "Operations",
    icon: "database",
    hint: "Backups, restore, capacity and limits",
  },
];

/* ---------- Sample data ---------- */

interface Org {
  id: string;
  name: string;
  host: string;
  members: number;
  projects: number;
  used: number;
  quota: number;
  state: "active" | "suspended" | "trial";
  since: string;
  sso: string;
  factor: boolean;
}

const orgs: Org[] = [
  {
    id: "t-1",
    name: "Endless Hall Records",
    host: "endlesshall",
    members: 4,
    projects: 2,
    used: 245,
    quota: 1000,
    state: "active",
    since: "2 Aug 2026",
    sso: "OIDC",
    factor: true,
  },
  {
    id: "t-2",
    name: "North Choir Collective",
    host: "northchoir",
    members: 11,
    projects: 6,
    used: 1100,
    quota: 2000,
    state: "active",
    since: "19 Aug 2026",
    sso: "None",
    factor: false,
  },
  {
    id: "t-3",
    name: "Lantern Pictures",
    host: "lantern",
    members: 3,
    projects: 1,
    used: 88,
    quota: 250,
    state: "suspended",
    since: "4 Sep 2026",
    sso: "SAML",
    factor: true,
  },
  {
    id: "t-4",
    name: "Hollow Reed Audio",
    host: "hollowreed",
    members: 6,
    projects: 3,
    used: 410,
    quota: 1000,
    state: "active",
    since: "12 Sep 2026",
    sso: "None",
    factor: false,
  },
  {
    id: "t-5",
    name: "Saltmarsh Films",
    host: "saltmarsh",
    members: 9,
    projects: 4,
    used: 1900,
    quota: 2000,
    state: "active",
    since: "20 Sep 2026",
    sso: "OIDC",
    factor: true,
  },
  {
    id: "t-6",
    name: "Ninefold Choir",
    host: "ninefold",
    members: 2,
    projects: 1,
    used: 12,
    quota: 250,
    state: "trial",
    since: "1 Oct 2026",
    sso: "None",
    factor: false,
  },
  {
    id: "t-7",
    name: "Brightwater Session",
    host: "brightwater",
    members: 5,
    projects: 2,
    used: 320,
    quota: 1000,
    state: "active",
    since: "6 Oct 2026",
    sso: "None",
    factor: false,
  },
  {
    id: "t-8",
    name: "Tallow and Wick Post",
    host: "tallowwick",
    members: 7,
    projects: 5,
    used: 760,
    quota: 1000,
    state: "active",
    since: "9 Oct 2026",
    sso: "SAML",
    factor: true,
  },
];

const orgMembers: Record<
  string,
  { name: string; email: string; role: string; seen: string; factor: string }[]
> = {
  "t-1": [
    {
      name: "Alex Rivera",
      email: "alex@endlesshall.example",
      role: "Owner",
      seen: "2 min",
      factor: "passkey",
    },
    {
      name: "Ines Arlow",
      email: "ines@endlesshall.example",
      role: "Admin",
      seen: "1 h",
      factor: "app",
    },
    {
      name: "Tomas Varga",
      email: "tomas@endlesshall.example",
      role: "Member",
      seen: "yesterday",
      factor: "none",
    },
    {
      name: "Mira Solberg",
      email: "mira@solberg.example",
      role: "Guest",
      seen: "3 d",
      factor: "link",
    },
  ],
};

const operators = [
  {
    name: "Alex Rivera",
    email: "alex@endlesshall.example",
    factor: "security key",
    seen: "2 min",
    since: "2 Aug 2026",
  },
  {
    name: "Ops on call",
    email: "ops@endlesshall.example",
    factor: "security key",
    seen: "3 d",
    since: "4 Sep 2026",
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
];

type LogKind = "audit" | "auth" | "api" | "mail" | "webhooks";
const logKinds: { id: LogKind; label: string; columns: string[] }[] = [
  { id: "audit", label: "Audit", columns: ["When", "Who", "Organisation", "Action", "On"] },
  { id: "auth", label: "Authentication", columns: ["When", "Who", "Method", "Result", "From"] },
  { id: "api", label: "API", columns: ["When", "Token or client", "Call", "Status", "Time"] },
  { id: "mail", label: "Email", columns: ["When", "To", "Template", "Result", "Provider"] },
  { id: "webhooks", label: "Webhooks", columns: ["When", "Channel", "Event", "Result", "Attempt"] },
];
const logRows: Record<LogKind, string[][]> = {
  audit: [
    ["20:41:12", "Alex Rivera", "Endless Hall Records", "Requested a review", "Album masters"],
    ["20:37:44", "Ines Arlow", "Endless Hall Records", "Revoked a session", "s_9a… (own)"],
    [
      "20:12:03",
      "Priya Haldar",
      "North Choir Collective",
      "Changed a role",
      "Tomas Varga → Engineer",
    ],
    [
      "19:58:30",
      "Operator: Alex Rivera",
      "Instance",
      "Suspended an organisation",
      "Lantern Pictures",
    ],
    [
      "19:40:11",
      "Alex Rivera",
      "Endless Hall Records",
      "Downloaded an original",
      "Solace - V1 mix.wav (watermark w-41)",
    ],
    [
      "18:22:50",
      "Owen Castell",
      "Lantern Pictures",
      "Deleted a file",
      "Trailer 30s - Cut 1 (old).mov",
    ],
  ],
  auth: [
    ["20:40:02", "alex@endlesshall.example", "Passkey", "Signed in", "203.0.113.8 · Safari"],
    ["20:31:17", "mira@solberg.example", "Guest link", "Signed in", "198.51.100.23 · Chrome"],
    [
      "20:20:40",
      "tomas@endlesshall.example",
      "Password",
      "Refused: wrong password (2 of 5)",
      "203.0.113.41 · Firefox",
    ],
    [
      "19:55:09",
      "priya@northchoir.example",
      "Single sign-on (OIDC)",
      "Signed in",
      "192.0.2.77 · Chrome",
    ],
    [
      "19:12:00",
      "owen@lantern.example",
      "Password",
      "Refused: organisation suspended",
      "198.51.100.9 · Safari",
    ],
    [
      "18:47:31",
      "ines@endlesshall.example",
      "Code app",
      "Second factor accepted",
      "203.0.113.8 · Safari",
    ],
  ],
  api: [
    ["20:41:00", "Release pipeline (token)", "GET /v1/reviews?state=open", "200", "38 ms"],
    [
      "20:40:58",
      "Hekate for Logic Pro (client)",
      "POST /v1/files/file-maple/versions",
      "201",
      "1.9 s",
    ],
    ["20:38:12", "Archive sync (token)", "GET /v1/files/file-solace/original", "200", "4.1 s"],
    [
      "20:30:45",
      "Lantern Deliveries (client)",
      "GET /v1/projects",
      "403 organisation suspended",
      "9 ms",
    ],
    ["20:11:02", "Release pipeline (token)", "GET /v1/reviews/rev-masters", "200", "22 ms"],
    ["19:50:19", "hk_cli_a0d4… (client)", "POST /oauth/token", "400 invalid_grant", "6 ms"],
  ],
  mail: [
    ["20:41:13", "mira@solberg.example", "Review requested", "Delivered", "SMTP"],
    ["20:12:04", "tomas@endlesshall.example", "Role changed", "Delivered", "SMTP"],
    ["19:58:31", "owen@lantern.example", "Organisation suspended", "Delivered", "SMTP"],
    ["18:00:00", "priya@northchoir.example", "Due soon", "Bounced: mailbox full", "SMTP"],
    ["17:30:12", "producer@endlesshall.example", "Invitation", "Delivered", "SMTP"],
  ],
  webhooks: [
    [
      "20:39:50",
      "Slack #masters (North Choir)",
      "decision.recorded",
      "429 Too Many Requests",
      "3 of 3 · paused",
    ],
    ["20:12:05", "Discord #review (Endless Hall)", "role.changed", "204", "1"],
    ["19:58:32", "https://ops.example/hekate", "organisation.suspended", "200", "1"],
    ["19:40:12", "Slack #masters (Endless Hall)", "download.original", "200", "1"],
  ],
};

interface Err {
  ref: string;
  when: string;
  who: string;
  org: string;
  where: string;
  message: string;
  request: string;
  job?: string;
  stack: string;
}
const errors: Err[] = [
  {
    ref: "HK-7F3A-2C",
    when: "20:41:09",
    who: "Tomas Varga",
    org: "Endless Hall Records",
    where: "worker · pages",
    message: "Could not render page 7 of Solace - Score.pdf: damaged cross-reference table.",
    request: "req_01HX…9Q",
    job: "j-8f1c",
    stack:
      "PdfError: xref entry 41 points outside the file\n    at parseXref (pages/pdf.ts:188:11)\n    at renderPage (pages/render.ts:62:9)\n    at Worker.run (worker/index.ts:140:17)",
  },
  {
    ref: "HK-2B91-E0",
    when: "20:39:50",
    who: "system",
    org: "North Choir Collective",
    where: "webhooks · slack",
    message: "Slack #masters answered 429 three times; the channel is paused for five minutes.",
    request: "req_01HX…4F",
    job: "j-8f0a",
    stack:
      "HttpError: 429 Too Many Requests\n    at deliver (webhooks/deliver.ts:77:13)\n    at Queue.process (jobs/queue.ts:201:5)",
  },
  {
    ref: "HK-9D44-11",
    when: "19:50:19",
    who: "hk_cli_a0d4…",
    org: "Endless Hall Records",
    where: "api · POST /oauth/token",
    message: "invalid_grant: the authorisation code was already used.",
    request: "req_01HX…0A",
    stack: "OAuthError: invalid_grant\n    at exchange (auth/oauth.ts:233:9)",
  },
];

/* ---------- Pieces ---------- */

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

function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (t: T) => void;
}) {
  return (
    <div role="tablist" className="flex items-stretch gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "-mb-px flex h-9 shrink-0 items-center border-b-2 px-2.5 text-[13px] transition-colors",
            value === t.id
              ? "border-ink text-ink"
              : "border-transparent text-ink-3 hover:text-ink-2",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Table({
  columns,
  rows,
  flagColumn,
}: {
  columns: string[];
  rows: string[][];
  flagColumn?: number;
}) {
  return (
    <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-raised/25">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 text-left font-normal whitespace-nowrap">
                <Label>{c}</Label>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.join("|")} className="border-t border-line">
              {r.map((cell, i) => (
                <td
                  key={`${i}-${cell}`}
                  className={cn(
                    "px-3 py-2 align-top",
                    i === 0 ? "tabular whitespace-nowrap text-ink-3" : "text-ink-2",
                    i === flagColumn &&
                      /refused|bounce|4\d\d|5\d\d|paused/i.test(cell) &&
                      "text-signal",
                    i === flagColumn &&
                      /signed in|delivered|accepted|^20\d/i.test(cell) &&
                      "text-ink",
                  )}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const gb = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} TB` : `${n} GB`);

/* ---------- The page ---------- */

type OrgTab = "overview" | "members" | "projects" | "storage" | "settings" | "keys";

export function InstancePage({ section }: { section: string }) {
  const state = useScreenState();
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [orgId, setOrgId] = useState("t-1");
  const [orgTab, setOrgTab] = useState<OrgTab>("overview");
  const [logKind, setLogKind] = useState<LogKind>("audit");
  const [logQ, setLogQ] = useState("");
  const [ref, setRef] = useState("");
  const [found, setFound] = useState<Err | null>(null);
  const [channel, setChannel] = useState("stable");
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
  const workerDown = state === "failed";
  const visibleOrgs = orgs.filter(
    (o) =>
      (!filter || o.state === filter) &&
      (!q || o.name.toLowerCase().includes(q.toLowerCase()) || o.host.includes(q.toLowerCase())),
  );
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const members = orgMembers[org?.id ?? ""] ?? [
    {
      name: "Owner",
      email: `owner@${org?.host}.example`,
      role: "Owner",
      seen: "today",
      factor: "app",
    },
    {
      name: "Producer",
      email: `producer@${org?.host}.example`,
      role: "Member",
      seen: "2 d",
      factor: "none",
    },
  ];
  const rows = logRows[logKind].filter(
    (r) => !logQ || r.join(" ").toLowerCase().includes(logQ.toLowerCase()),
  );
  const series = (seed: number, base: number, swing: number) =>
    Array.from({ length: 25 }, (_, i) =>
      Math.max(0, base + Math.sin(i / 3 + seed) * swing + ((i * 7 + seed * 13) % 5) * (swing / 12)),
    );

  return (
    <Page className="gap-10">
      <div>
        <h1 className="title">{meta?.label}</h1>
        <p className="mt-1.5 max-w-[620px] text-[14px] text-ink-2">{meta?.hint}.</p>
      </div>

      {sec === "overview" && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-6">
            <Tile
              label="Organisations"
              value={String(orgs.length)}
              hint="1 suspended · 1 on trial"
            />
            <Tile label="People" value="47" hint="9 guests with live links" />
            <Tile label="Storage" value="4.8 TB" hint="34% of the disk" />
            <Tile
              label="Queue"
              value={workerDown ? "38" : "3"}
              hint={workerDown ? "worker down" : "2 lanes busy"}
              flag={workerDown}
            />
            <Tile label="Errors today" value="3" hint="2 jobs, 1 OAuth exchange" flag />
            <Tile label="Patch available" value="0.2.1" hint="3 fixes, no migration" />
          </div>
          <Section title="Needs an operator">
            <Row
              name="HK-2B91-E0: Slack is rate-limiting North Choir Collective"
              hint="The channel paused itself; 3 deliveries wait. Debug tools has the trace."
            >
              <Button variant="secondary" size="md">
                Look up
              </Button>
            </Row>
            <Row
              name="Saltmarsh Films is at 95% of its quota"
              hint="1.9 TB of 2 TB. Uploads refuse at 100%."
            >
              <Button variant="secondary" size="md">
                Raise the quota
              </Button>
            </Row>
            <Row
              name="Patch 0.2.1 can be applied now"
              hint="Three fixes, no migration, no restart of the worker."
            >
              <Button variant="primary" size="md">
                Apply
              </Button>
            </Row>
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

      {sec === "organisations" && org && (
        <div className="flex flex-col gap-6 @3xl/app:flex-row @3xl/app:gap-8">
          <div className="flex shrink-0 flex-col gap-2 @3xl/app:sticky @3xl/app:top-0 @3xl/app:w-[280px] @3xl/app:self-start">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Name or subdomain"
            />
            <div className="flex gap-1">
              {[
                ["", "All"],
                ["active", "Active"],
                ["trial", "Trial"],
                ["suspended", "Suspended"],
              ].map(([v, l]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setFilter(v ?? "")}
                  className={cn(
                    "h-7 rounded-control px-2.5 text-[12px] transition-colors",
                    filter === v ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
                  )}
                >
                  {l}
                </button>
              ))}
            </div>
            <div className="scroll-quiet flex max-h-[560px] flex-col gap-0.5 overflow-y-auto rounded-panel-lg border border-line bg-raised/25 p-1">
              {visibleOrgs.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOrgId(o.id)}
                  aria-current={o.id === org.id ? "true" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left transition-colors hover:bg-raised/60",
                    o.id === org.id && "bg-raised shadow-1",
                  )}
                >
                  <Dot
                    state={
                      o.state === "active"
                        ? "approved"
                        : o.state === "trial"
                          ? "working"
                          : "cancelled"
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{o.name}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {o.members} people · {gb(o.used)} of {gb(o.quota)}
                    </span>
                  </span>
                </button>
              ))}
              {visibleOrgs.length === 0 && (
                <p className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches.</p>
              )}
              <p className="px-2.5 pt-2 pb-1 text-[11px] text-ink-3">
                {visibleOrgs.length} of {orgs.length} · more load as you scroll
              </p>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <div className="flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[20px] font-medium tracking-tight text-ink">
                  {org.name}
                </h2>
                <p className="tabular text-[13px] text-ink-3">
                  {org.host}.review.endlesshall.example · since {org.since}
                  {org.state !== "active" && <span className="text-signal"> · {org.state}</span>}
                </p>
              </div>
              <ActionMenu
                always
                label={org.name}
                actions={[
                  { label: "Open as its owner (logged)", onSelect: () => {} },
                  { label: "Export everything", onSelect: () => {} },
                  "divider",
                  {
                    label: org.state === "suspended" ? "Reinstate" : "Suspend",
                    danger: org.state !== "suspended",
                    onSelect: () => {},
                  },
                ]}
              />
            </div>
            <Tabs
              tabs={[
                { id: "overview", label: "Overview" },
                { id: "members", label: `Members · ${org.members}` },
                { id: "projects", label: `Projects · ${org.projects}` },
                { id: "storage", label: "Storage and quota" },
                { id: "settings", label: "Settings" },
                { id: "keys", label: "Keys" },
              ]}
              value={orgTab}
              onChange={setOrgTab}
            />
            {orgTab === "overview" && (
              <>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-4">
                  <Tile label="People" value={String(org.members)} hint="members and guests" />
                  <Tile label="Projects" value={String(org.projects)} hint="2 active reviews" />
                  <Tile
                    label="Storage"
                    value={gb(org.used)}
                    hint={`of ${gb(org.quota)}`}
                    flag={org.used / org.quota > 0.9}
                  />
                  <Tile
                    label="Sign-in"
                    value={org.sso === "None" ? "Password" : org.sso}
                    hint={org.factor ? "second factor required" : "no second factor"}
                  />
                </div>
                <Section title="Recently in this organisation">
                  {[
                    ["Alex Rivera", "requested a review of Album masters", "2 min"],
                    ["Tomas Varga", "uploaded Maple Leaf Rag V3", "19 min"],
                    ["Ines Arlow", "changed the delivery profile", "yesterday"],
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
            {orgTab === "members" && (
              <Section
                title="People"
                intro="Members and guests of this organisation. What you do here is logged against your name."
              >
                {members.map((m) => (
                  <Row
                    key={m.email}
                    name={
                      <span className="flex items-center gap-2">
                        {m.name}
                        <span className="text-[12px] text-ink-3">{m.email}</span>
                      </span>
                    }
                    hint={`${m.role} · seen ${m.seen} ago · second factor: ${m.factor}`}
                  >
                    <ActionMenu
                      always
                      label={m.name}
                      actions={[
                        { label: "Send a password reset", onSelect: () => {} },
                        { label: "Reset the second factor", onSelect: () => {} },
                        { label: "Revoke every session", onSelect: () => {} },
                        { label: "Sign in as (logged, with a banner)", onSelect: () => {} },
                        "divider",
                        { label: "Suspend", danger: true, onSelect: () => {} },
                      ]}
                    />
                  </Row>
                ))}
              </Section>
            )}
            {orgTab === "projects" && (
              <Section
                title="Projects"
                intro="Names and sizes only; the content stays the organisation's."
              >
                {[
                  ["Joplin Rags", "music · 5 tracks · 182 GB · 2 open reviews"],
                  ["Opening titles", "video · 2 deliverables · 63 GB · 1 open review"],
                ]
                  .slice(0, org.projects)
                  .map(([n, h]) => (
                    <Row key={n} name={n} hint={h}>
                      <span className="text-[12px] text-ink-3">active</span>
                    </Row>
                  ))}
                {org.projects > 2 && (
                  <Row
                    name={`and ${org.projects - 2} more`}
                    hint="Archived projects count towards storage until deleted."
                  />
                )}
              </Section>
            )}
            {orgTab === "storage" && (
              <>
                <Section
                  title="Quota"
                  intro="Uploads refuse at the quota; the organisation is warned at 90%."
                >
                  <Row
                    name="Used"
                    hint={`${gb(org.used)} of ${gb(org.quota)} · originals 71%, renditions 24%, pages 5%`}
                  >
                    <span className="flex w-56 flex-col gap-1">
                      <span className="h-1.5 overflow-hidden rounded-full bg-raised">
                        <span
                          className={cn(
                            "block h-full rounded-full",
                            org.used / org.quota > 0.9 ? "bg-signal" : "bg-ink-2",
                          )}
                          style={{ width: `${Math.min(100, (org.used / org.quota) * 100)}%` }}
                        />
                      </span>
                    </span>
                  </Row>
                  <Row name="Quota">
                    <Select defaultValue={String(org.quota)} className="w-36">
                      <option value="250">250 GB</option>
                      <option value="1000">1 TB</option>
                      <option value="2000">2 TB</option>
                      <option value="5000">5 TB</option>
                      <option value="0">No limit</option>
                    </Select>
                  </Row>
                  <Row name="Backends" hint="Where this organisation's objects go.">
                    <span className="text-[13px] text-ink-2">
                      Local disk · S3: archive for cold projects
                    </span>
                  </Row>
                </Section>
                <Section title="Housekeeping">
                  <Row
                    name="Orphans"
                    hint="Objects with no file row and rows with no object. Last scan 02:10: none."
                  >
                    <Button variant="secondary" size="md">
                      Scan
                    </Button>
                  </Row>
                  <Row name="Rendition cache" hint="Rebuilt on demand; originals untouched.">
                    <Button variant="secondary" size="md">
                      Clear
                    </Button>
                  </Row>
                </Section>
              </>
            )}
            {orgTab === "settings" && (
              <>
                <Section title="Limits">
                  <Row name="Members">
                    <Select defaultValue="25" className="w-36">
                      <option value="10">10</option>
                      <option value="25">25</option>
                      <option value="none">No limit</option>
                    </Select>
                  </Row>
                  <Row name="Guest links last">
                    <Select defaultValue="14" className="w-36">
                      <option value="3">3 days</option>
                      <option value="14">14 days</option>
                    </Select>
                  </Row>
                </Section>
                <Section title="Sign-in">
                  <Row name="Subdomain">
                    <span className="flex items-center gap-2">
                      <Input defaultValue={org.host} className="w-40" />
                      <span className="text-[13px] text-ink-3">.review.endlesshall.example</span>
                    </span>
                  </Row>
                  <Row
                    name="Single sign-on"
                    hint={
                      org.sso === "None"
                        ? "Not set up; passwords and passkeys."
                        : `${org.sso} · set by the organisation`
                    }
                  >
                    <span className="text-[13px] text-ink-2">{org.sso}</span>
                  </Row>
                  <SwitchRow
                    name="Second factor required"
                    hint="The instance can require it for everyone instead, in Settings."
                    checked={org.factor}
                  />
                </Section>
                <Danger>
                  <Row
                    name={org.state === "suspended" ? "Reinstate" : "Suspend"}
                    hint="Suspending keeps everything and lets nobody in."
                  >
                    <Button variant="secondary" size="md">
                      {org.state === "suspended" ? "Reinstate" : "Suspend"}
                    </Button>
                  </Row>
                  <Row name="Delete" hint="Thirty days after a suspension, with an export first.">
                    <Button variant="ghost" size="md" disabled={org.state !== "suspended"}>
                      Delete…
                    </Button>
                  </Row>
                </Danger>
              </>
            )}
            {orgTab === "keys" && (
              <Section
                title="Keys"
                intro="The organisation's key wraps its file keys and is itself wrapped by the master key. Rotating it rewraps in the background."
              >
                <Row
                  name="Organisation key"
                  hint="Rotated 3 Oct · previous key kept until every file is rewrapped (done)"
                >
                  <Button variant="secondary" size="md">
                    Rotate
                  </Button>
                </Row>
                <Row name="Forensic marking" hint="Watermarks on every download, per recipient.">
                  <span className="text-[13px] text-ink-2">On</span>
                </Row>
                <Row
                  name="Export"
                  hint="Everything the organisation owns, encrypted to a key of theirs, for leaving or for audit."
                >
                  <Button variant="ghost" size="md">
                    Start an export
                  </Button>
                </Row>
              </Section>
            )}
          </div>
        </div>
      )}

      {sec === "operators" && (
        <>
          <Section
            title="Operators"
            intro="Accounts that may open this side of the application. A security key is required; everything they do is in the audit log under their name."
            action={
              <Button variant="primary" size="md">
                <Icon name="plus" size={14} />
                Operator
              </Button>
            }
          >
            {operators.map((o) => (
              <Row
                key={o.email}
                name={
                  <span className="flex items-center gap-2">
                    {o.name}
                    <span className="text-[12px] text-ink-3">{o.email}</span>
                  </span>
                }
                hint={`${o.factor} · seen ${o.seen} ago · operator since ${o.since}`}
              >
                <ActionMenu
                  always
                  label={o.name}
                  actions={[
                    { label: "Revoke every session", onSelect: () => {} },
                    "divider",
                    { label: "Remove as operator", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          <Section title="Rules">
            <SwitchRow name="Security key required for operators" checked />
            <SwitchRow
              name="Sign in as a member leaves a banner and an audit entry"
              hint="Cannot be turned off."
              checked
            />
            <Row
              name="Break glass"
              hint="A one-time operator credential printed at install, for when every operator is locked out. Used: never."
            >
              <Button variant="ghost" size="md">
                Rotate
              </Button>
            </Row>
          </Section>
        </>
      )}

      {sec === "health" && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-4">
            <Gauge label="CPU" value={0.38} text="38%" hint="8 cores · 2 lanes transcoding" />
            <Gauge label="Memory" value={0.61} text="61%" hint="9.8 of 16 GB" />
            <Gauge label="Disk" value={0.34} text="34%" hint="1.4 of 4 TB" />
            <Gauge label="Database connections" value={0.12} text="12" hint="of 100" />
          </div>
          <div className="grid gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-3">
            <Spark
              label="Requests per minute"
              points={series(1, 420, 160)}
              hint="the last 24 hours"
            />
            <Spark
              label="p95 latency"
              points={series(2, 140, 40)}
              unit=" ms"
              hint="API, every route"
            />
            <Spark
              label="Error rate"
              points={series(3, 0.2, 0.15)}
              unit="%"
              hint="5xx over all requests"
            />
            <Spark label="Queue depth" points={series(4, 3, 4)} hint="jobs waiting" />
            <Spark label="Worker lanes busy" points={series(5, 2, 1.6)} max={4} hint="of 4" />
            <Spark
              label="Uploads"
              points={series(6, 1.1, 0.9)}
              unit=" GB/h"
              hint="checked at the door"
            />
          </div>
          <Section title="Services" intro="Every part of the machine, checked every 15 seconds.">
            {(
              [
                ["API", "p95 142 ms over the last hour · 2 instances", "approved"],
                [
                  "Database",
                  "PostgreSQL 18.1 · 2.1 GB · 12 of 100 connections · replication lag 0",
                  "approved",
                ],
                [
                  "Worker",
                  workerDown ? "Not running since 20:12" : "ffmpeg 7.1 · 4 lanes · 2 busy",
                  workerDown ? "changes_requested" : "approved",
                ],
                ["Mail", "SMTP · last message 2 h ago · 1 bounce today", "approved"],
                ["Proxy", "Caddy · TLS renewed · HTTP/3 on", "approved"],
                ["Metrics", "/metrics scraped 14 s ago · OpenTelemetry on", "approved"],
              ] as [string, string, DotState][]
            ).map(([name, hint, dot]) => (
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
          <Section
            title="Storage"
            intro="Every object is encrypted with its own key before it is written; a backend only ever holds ciphertext."
          >
            {[
              {
                name: "Local disk",
                hint: "/var/lib/hekate/objects · ext4 · 1.4 TB of 4 TB",
                used: 0.34,
              },
              {
                name: "S3: archive",
                hint: "s3://endlesshall-archive · eu-west-2 · cold · 88 GB of 1 TB",
                used: 0.09,
              },
            ].map((b) => (
              <Row key={b.name} name={b.name} hint={b.hint}>
                <span className="flex w-56 items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                    <span
                      className="block h-full rounded-full bg-ink-2"
                      style={{ width: `${b.used * 100}%` }}
                    />
                  </span>
                  <span className="tabular w-9 text-right text-[12px] text-ink-3">
                    {Math.round(b.used * 100)}%
                  </span>
                </span>
                <Dot state="approved" />
              </Row>
            ))}
            <Row
              name="Master key"
              hint="In the environment; wraps every organisation key. Rotated 2 Oct."
            >
              <Button variant="secondary" size="md">
                Rotate
              </Button>
            </Row>
            <Row
              name="Reconciliation"
              hint="Every object's hash against the database, a slice a night: 12% per night, 0 mismatches."
            >
              <Button variant="ghost" size="md">
                Run a slice now
              </Button>
            </Row>
            <Row
              name="Add a backend"
              hint="Local disk or anything S3-compatible; organisations and projects pick from these."
            >
              <Button variant="secondary" size="md">
                Add
              </Button>
            </Row>
          </Section>
        </>
      )}

      {sec === "queues" && (
        <>
          <Section
            title="Queues"
            intro="pg-boss in the database. A failed job retries three times with backoff, then waits here with an error reference."
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
                hint={`${j.org} · ${j.id} · ${j.when} ago${j.state === "failed" ? ` · ${errors.find((e) => e.job === j.id)?.ref ?? ""}` : ""}`}
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
          <Tabs
            tabs={logKinds.map((k) => ({ id: k.id, label: k.label }))}
            value={logKind}
            onChange={setLogKind}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={logQ}
              onChange={(e) => setLogQ(e.target.value)}
              placeholder="Search"
              className="w-64"
            />
            <Select defaultValue="24h" className="w-36">
              <option value="1h">Last hour</option>
              <option value="24h">Last 24 hours</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
            </Select>
            <Select defaultValue="" className="w-48">
              <option value="">Any organisation</option>
              {orgs.map((o) => (
                <option key={o.id}>{o.name}</option>
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
          <Table
            columns={logKinds.find((k) => k.id === logKind)?.columns ?? []}
            rows={rows}
            flagColumn={3}
          />
          <p className="text-[12px] text-ink-3">
            {logKind === "audit" &&
              "Every action a person or operator took, kept for a year; organisations see their own in Settings."}
            {logKind === "auth" &&
              "Every sign-in, refusal and second factor, with the address and the browser. Five refusals in a minute lock the address for ten."}
            {logKind === "api" &&
              "Every call through a token or an OAuth client, with its status and time. Organisations see their own."}
            {logKind === "mail" &&
              "Every message handed to the provider, and what came back. Bounces pause the address."}
            {logKind === "webhooks" &&
              "Every delivery and its attempts. A channel that keeps failing pauses itself for five minutes."}
          </p>
        </>
      )}

      {sec === "debug" && (
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
                  setFound(
                    errors.find((x) => x.ref.toLowerCase() === ref.trim().toLowerCase()) ??
                      errors[0] ??
                      null,
                  );
                }}
              >
                <Input
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  placeholder="HK-7F3A-2C"
                  className="tabular w-64"
                  autoFocus
                />
                <Button type="submit" variant="primary" size="md">
                  Look up
                </Button>
              </form>
              {found && (
                <div className="flex flex-col gap-3 rounded-panel border border-line bg-canvas/40 p-4">
                  <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <span className="tabular text-[16px] font-medium text-ink">{found.ref}</span>
                    <span className="text-[13px] text-ink-3">{found.when} today</span>
                    <span className="text-[13px] text-ink-3">{found.where}</span>
                  </div>
                  <p className="text-[14px] text-ink">{found.message}</p>
                  <div className="grid gap-x-6 gap-y-1 text-[13px] @3xl/app:grid-cols-2">
                    <span>
                      <span className="text-ink-3">Who </span>
                      <span className="text-ink-2">{found.who}</span>
                    </span>
                    <span>
                      <span className="text-ink-3">Organisation </span>
                      <span className="text-ink-2">{found.org}</span>
                    </span>
                    <span>
                      <span className="text-ink-3">Request </span>
                      <span className="tabular text-ink-2">{found.request}</span>
                    </span>
                    {found.job && (
                      <span>
                        <span className="text-ink-3">Job </span>
                        <span className="tabular text-ink-2">{found.job}</span>
                      </span>
                    )}
                  </div>
                  <pre className="scroll-quiet overflow-x-auto rounded-control border border-line bg-canvas/60 px-3 py-2 font-mono text-[12px] leading-[1.6] text-ink-2">
                    {found.stack}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" size="md">
                      <Icon name="copy" size={13} />
                      Copy the report
                    </Button>
                    {found.job && (
                      <Button variant="secondary" size="md">
                        Retry the job
                      </Button>
                    )}
                    <Button variant="ghost" size="md">
                      Inspect the file
                    </Button>
                    <Button variant="ghost" size="md">
                      Mark as known
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </Section>
          <Section
            title="Errors today"
            intro="Everything that failed with a reference, newest first."
          >
            {errors.map((e) => (
              <Row
                key={e.ref}
                name={
                  <span className="flex items-center gap-2">
                    <Dot state="changes_requested" />
                    <span className="tabular">{e.ref}</span>
                    <span className="truncate text-ink-2">{e.message}</span>
                  </span>
                }
                hint={`${e.when} · ${e.org} · ${e.where}`}
              >
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => {
                    setRef(e.ref);
                    setFound(e);
                  }}
                >
                  Open
                </Button>
              </Row>
            ))}
          </Section>
          <Section
            title="Inspect"
            intro="Read-only views of what the system holds, for the thing that is not working."
          >
            {[
              [
                "A file",
                "Its rows, objects, keys, renditions and every job that touched it",
                "file-… or a URL",
              ],
              [
                "A workflow run",
                "Which node an item is at, what it waits for, and every transition",
                "run-… or a track",
              ],
              ["A review", "Its reviewers, their sessions, what they could see and when", "rev-…"],
              ["A session", "Who, where from, what it may reach, the keys it was issued", "s_…"],
            ].map(([n, h, ph]) => (
              <Row key={n} name={n} hint={h}>
                <Input placeholder={ph} className="w-56" />
                <Button variant="secondary" size="md">
                  Inspect
                </Button>
              </Row>
            ))}
          </Section>
          <Section title="Replay and flags">
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
            <SwitchRow
              name="Verbose logging for the worker"
              hint="For an hour, then off by itself."
              checked={false}
            />
            <SwitchRow
              name="Frame-accurate scrubbing on H.265"
              hint="A feature flag: on for this instance before it is on by default."
              checked={false}
            />
          </Section>
        </>
      )}

      {sec === "system" && (
        <>
          <Section title="This instance">
            <Row name="Version" hint="hekate 0.2.0 · build 2026.10.14+4f2a1c · released 4 Sep 2026">
              <span className="tabular text-[13px] text-ink-2">0.2.0</span>
            </Row>
            <Row
              name="Update channel"
              hint="Stable gets releases; Beta gets release candidates; Edge gets every build that passes."
            >
              <Select value={channel} onChange={(e) => setChannel(e.target.value)} className="w-36">
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
                <option value="edge">Edge</option>
              </Select>
            </Row>
            <Row
              name="Last check"
              hint="Checks every six hours; nothing is sent but the version and the channel."
            >
              <span className="text-[13px] text-ink-2">14 minutes ago</span>
              <Button variant="secondary" size="md">
                Check now
              </Button>
            </Row>
            <Row name="Instance id" hint="For support; it identifies nothing else.">
              <span className="tabular text-[13px] text-ink-2">inst_7a3e…c91</span>
            </Row>
          </Section>
          <Section
            title="Available"
            intro="A patch is a signed bundle of fixes for the running version: applied in place, no migration, the worker drains and restarts. A release is a new image."
          >
            <Row
              name={
                <span className="flex items-center gap-2">
                  <Dot state="working" />
                  Patch 0.2.1
                </span>
              }
              hint="Fixes: PDF pages with a damaged xref (HK-7F3A-2C), webhook backoff after 429, a loudness rounding error. No migration; the worker restarts."
            >
              <Button variant="ghost" size="md">
                Release notes
              </Button>
              <Button variant="primary" size="md">
                Apply
              </Button>
            </Row>
            <Row
              name="Release 0.3.0"
              hint="Not on this channel yet: expected on Stable in November. Immersive review, score follow, the public API v1."
            >
              <span className="text-[13px] text-ink-3">Beta</span>
            </Row>
          </Section>
          <Section title="Applied" intro="Every patch and release, with the way back.">
            {[
              ["0.2.0", "release", "4 Sep 2026", "migrations 0041 to 0044"],
              ["0.1.4", "patch", "22 Aug 2026", "signed URL clock skew"],
              ["0.1.3", "patch", "15 Aug 2026", "S3 multipart retry"],
              ["0.1.0", "release", "2 Aug 2026", "first install"],
            ].map(([v, kind, when, what]) => (
              <Row
                key={v}
                name={
                  <span className="flex items-center gap-2">
                    <span className="tabular">{v}</span>
                    <span className="rounded-chip border border-line px-1.5 text-[11px] text-ink-3">
                      {kind}
                    </span>
                  </span>
                }
                hint={`${when} · ${what}`}
              >
                {kind === "patch" && (
                  <Button variant="ghost" size="md">
                    Roll back
                  </Button>
                )}
              </Row>
            ))}
          </Section>
          <Section title="Environment">
            {[
              ["Node.js", "26.2.0"],
              ["PostgreSQL", "18.1 · 2.1 GB"],
              ["ffmpeg", "7.1 · libaom, libfdk, libx265"],
              ["pdf.js", "5.2"],
              ["Caddy", "2.10 · HTTP/3"],
              ["Container", "ghcr.io/hekate/hekate:0.2.0 · linux/amd64"],
              ["Licence", "AGPL-3.0"],
            ].map(([k, v]) => (
              <Row key={k} name={k}>
                <span className="tabular text-[13px] text-ink-2">{v}</span>
              </Row>
            ))}
          </Section>
        </>
      )}

      {sec === "settings" && (
        <>
          <Section title="Registration">
            <Row name="New organisations" hint="Who may create one.">
              <Select defaultValue="admin" className="w-56">
                <option value="admin">Operators only</option>
                <option value="invite">Anyone invited</option>
                <option value="open">Anyone</option>
              </Select>
            </Row>
            <SwitchRow name="Allow sign-up without an invitation" checked={false} />
          </Section>
          <Section
            title="Security"
            intro="What every organisation must do, whatever its own settings say."
          >
            <SwitchRow
              name="Require a second factor for every account"
              hint="A passkey, a security key or a code app. People without one are asked at their next sign-in."
              checked={false}
            />
            <SwitchRow name="Security key required for operators" checked />
            <Row name="Sessions end after">
              <Select defaultValue="30" className="w-36">
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
              </Select>
            </Row>
            <Row
              name="Password rules"
              hint="Twelve characters or more, checked against known leaks."
            >
              <span className="text-[13px] text-ink-2">12+ · leak check</span>
            </Row>
          </Section>
          <Section title="Defaults for new organisations">
            <Row name="Storage quota">
              <Select defaultValue="1000" className="w-40">
                <option value="250">250 GB</option>
                <option value="1000">1 TB</option>
                <option value="0">None</option>
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
          <Section title="Backups">
            <Row
              name="Nightly"
              hint="Database, the master key's wrapped copy, nothing of the objects (the backends keep those)."
            >
              <span className="text-[13px] text-ink-2">Today 02:00 · verified</span>
              <Button variant="secondary" size="md">
                Back up now
              </Button>
            </Row>
            <Row name="Kept" hint="Seven nightly, four weekly, six monthly.">
              <Button variant="ghost" size="md">
                Edit
              </Button>
            </Row>
            <Row name="Restore" hint="Into a fresh instance, from a backup and the master key.">
              <Button variant="ghost" size="md">
                How to
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
