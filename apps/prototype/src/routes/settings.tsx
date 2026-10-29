import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Danger, Matrix, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Dot } from "~/components/status";
import { StatusRows } from "~/components/status-desk";
import { TicketDialog, TicketRow } from "~/components/tickets";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Floating } from "~/components/ui/floating";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, type MenuAction, usePopover } from "~/components/ui/menu";
import {
  type AccessEvent,
  accessLog,
  categories,
  deliveryProfiles,
  env,
  fileById,
  newReference,
  organisation,
  people,
  personById,
  projects,
  reviewById,
  severities,
  type TicketSeverity,
  type Tool,
  tickets,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatDateTime } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";
import { BrandingSection } from "./branding.tsx";
import { BrandSection, ComponentsSection } from "./design-system.tsx";
import { MembersSection } from "./members.tsx";
import { EmailSection } from "./org-email.tsx";
import { toolCopy } from "./project-settings.tsx";

const intros: Record<string, string> = {
  transfers: "Projects moving in from, or out to, another workspace, and what each waits for.",
  general: "The workspace's name, how guests sign in, and what every project starts from.",
  defaults: "What a new project copies unless it says otherwise.",
  categories: "The categories a comment can carry, and how each kind is handled.",
  delivery: "The numbers the checks measure against, shared by every project that picks a profile.",
  branding:
    "The workspace's logo and accent, on its sign-in page, guest pages and email. Hekate's own mark stays in the app.",
  brand:
    "The mark, the colours, the type, and every reusable component with the rule for using it.",
  email: "What every message from Hekate looks like, and the words the workspace sends.",
  members: "Who has an account here, who is invited, and which guests hold a link.",
  security: "Who may sign in and how.",
  notifications: "Where events go: mail, Slack, Discord, webhooks.",
  api: "Applications that connect on people's behalf, and tokens that act for the workspace itself.",
  billing: "The plan, what it includes, what it costs, and every invoice.",
  support: "Ask the people who run this instance, with the error reference if there is one.",
  storage: "Where files live and how much they take.",
  leaks: "Find which recipient a leaked file was watermarked for.",
  log: "Every key issue, page render and download.",
  operations: "What the instance is doing for this workspace.",
};

const sections = [
  { id: "general", label: "General", group: "Workspace" },
  { id: "defaults", label: "Defaults", group: "Workspace" },
  { id: "categories", label: "Comment categories", group: "Workspace" },
  { id: "delivery", label: "Delivery profiles", group: "Workspace" },
  { id: "branding", label: "Branding", group: "Workspace" },
  { id: "brand", label: "Brand and design system", group: "Workspace" },
  { id: "email", label: "Email templates", group: "Workspace" },
  { id: "members", label: "Members", group: "Access" },
  { id: "security", label: "Security", group: "Access" },
  { id: "notifications", label: "Notifications and integrations", group: "Access" },
  { id: "api", label: "API and OAuth clients", group: "Access" },
  { id: "billing", label: "Billing", group: "Plan and help" },
  // Shown only with the support module on (#181).
  ...(env.support === "off" ? [] : [{ id: "support", label: "Support", group: "Plan and help" }]),
  { id: "transfers", label: "Transfers", group: "Operations" },
  { id: "storage", label: "Storage", group: "Operations" },
  { id: "leaks", label: "Leak tracing", group: "Operations" },
  { id: "log", label: "Access log", group: "Operations" },
  { id: "operations", label: "Operations", group: "Operations" },
];

const channels = [
  {
    id: "smtp",
    name: "SMTP",
    state: "on",
    hint: "mail.endlesshall.example:587, STARTTLS",
    events: "Everything by mail",
  },
  {
    id: "slack",
    name: "Slack",
    state: "on",
    hint: "#masters in Endless Hall",
    events: "Decisions, new versions",
  },
  {
    id: "webhook",
    name: "Webhook",
    state: "paused",
    hint: "https://hooks.example/hekate · paused after 5 failures",
    events: "Every event",
  },
  { id: "discord", name: "Discord", state: "off", hint: "Not connected", events: "" },
];
const providers = [
  "SMTP",
  "SparkPost",
  "Resend",
  "Mailgun",
  "SendGrid",
  "Postal",
  "Google Workspace",
  "Microsoft 365",
  "Slack",
  "Discord",
  "Microsoft Teams",
  "Webhook",
];
/** Where each chat or webhook kind's address comes from, as the product's dialog asks for it. */
const channelAddress: Record<string, string> = {
  Slack: "https://hooks.slack.com/services/…",
  Discord: "https://discord.com/api/webhooks/…",
  "Microsoft Teams": "https://…logic.azure.com/workflows/…",
  Webhook: "https://hooks.example/hekate",
};

function Test({ state }: { state: "idle" | "ok" | "failed" }) {
  const [s, setS] = useState(state);
  return (
    <span className="flex items-center gap-2">
      {s === "ok" && (
        <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <Dot state="approved" />
          Reached
        </span>
      )}
      {s === "failed" && (
        <span className="flex items-center gap-1.5 text-[13px] text-signal">
          <Icon name="warning" size={13} />
          Refused: certificate expired
        </span>
      )}
      <Button variant="secondary" size="md" onClick={() => setS(s === "failed" ? "failed" : "ok")}>
        Test
      </Button>
    </span>
  );
}

/** Each section's page on the documentation site, where there is one. */
const docPages: Record<string, string> = {
  members: "/use/guests/",
  security: "/security/model/",
  storage: "/install/storage/",
  log: "/security/model/#audit",
};

export function SettingsPage({
  section,
  newTicket = false,
  ticketId,
}: {
  section: string;
  newTicket?: boolean;
  ticketId?: string;
}) {
  const navigate = useNavigate();
  const [sent, setSent] = useState<string | null>(null);
  const [severity, setSeverity] = useState<TicketSeverity>("normal");
  const openTicket = tickets.find((t) => t.id === ticketId);
  const viewer = useViewer();
  const state = useScreenState();
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  const [adding, setAdding] = useState(false);
  const [channelKind, setChannelKind] = useState("Resend");
  const [leak, setLeak] = useState<"idle" | "scanning" | "match" | "none">("idle");
  // An OAuth client's menu (#447): who has connected it, or its secret rotated (shown once).
  const [clientDialog, setClientDialog] = useState<{
    name: string;
    view: "connections" | "rotate" | "secret";
  } | null>(null);
  const [clientScopes, setClientScopes] = useState<string[]>(["files:read"]);
  usePageHeader({ title: "Workspace settings" });
  if (!elevated)
    return (
      <Refused title="Not for your role" text="Workspace settings are for owners and admins." />
    );
  const sec = sections.some((s) => s.id === section) ? section : "general";
  return (
    <SettingsLayout
      title={sections.find((x) => x.id === sec)?.label ?? organisation.name}
      intro={intros[sec]}
      docs={docPages[sec]}
      sections={sections}
      current={sec}
      base="/settings/$section"
      param="section"
    >
      {sec === "members" && <MembersSection />}
      {sec === "billing" && (
        <>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-panel-lg border border-line bg-line @3xl/app:grid-cols-4">
            {[
              ["Plan", "Studio", "£49 a month"],
              ["Storage", "245 GB", "of 1 TB"],
              ["Members", "4", "of 25"],
              ["Next invoice", "1 Nov", "£49.00"],
            ].map(([l, v, h]) => (
              <div key={l} className="bg-raised/25 px-4 py-3">
                <div className="text-[12px] text-ink-3">{l}</div>
                <div className="tabular mt-1 text-[24px] leading-none font-medium text-ink">
                  {v}
                </div>
                <div className="mt-1.5 text-[12px] text-ink-3">{h}</div>
              </div>
            ))}
          </div>
          <Section
            title="Plan"
            intro="Studio: 1 TB, 25 members, forensic marking, priority support. Change it any time; the difference is pro-rated. Billing is on because the instance runs with HEKATE_BILLING=stripe."
            action={
              <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
                Change plan
              </Button>
            }
          >
            <Row name="Payment" hint="Visa ending 4242 · expires 08/28">
              <Button variant="ghost" size="md">
                Update card
              </Button>
            </Row>
            <Row
              name="Billing details"
              hint="Endless Hall Records Ltd · VAT GB 123 4567 89 · invoices to accounts@endlesshall.example"
            >
              <Button variant="ghost" size="md">
                Edit
              </Button>
            </Row>
            <Row
              name="Usage this month"
              hint="Storage counts at the month's peak; members at the month's end."
            >
              <span className="text-[13px] text-ink-2">Within the plan</span>
            </Row>
          </Section>
          <Section title="Invoices">
            {[
              ["1 Oct 2026", "INV-0412", "£49.00", "Paid"],
              ["1 Sep 2026", "INV-0388", "£49.00", "Paid"],
              ["1 Aug 2026", "INV-0361", "£0.00", "Trial"],
            ].map(([when, no, amt, st]) => (
              <Row
                key={no}
                name={
                  <span className="flex items-center gap-2">
                    <span className="tabular">{no}</span>
                    <span className="text-[12px] text-ink-3">{when}</span>
                  </span>
                }
                hint={st}
              >
                <span className="tabular text-[13px] text-ink-2">{amt}</span>
                <Button variant="ghost" size="md">
                  PDF
                </Button>
              </Row>
            ))}
          </Section>
          <Danger>
            <Row
              name="Cancel the plan"
              hint="It ends on 1 November, at the end of the period paid for. Nothing is deleted."
            >
              <Button variant="ghost" size="md">
                Cancel…
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "support" && openTicket && (
        <TicketDialog
          ticket={openTicket}
          onClose={() => navigate({ to: "/settings/$section", params: { section: "support" } })}
        />
      )}
      {sec === "support" && env.support !== "app" && (
        <Section title="Support" intro="This instance answers elsewhere.">
          <Row
            name="Where"
            hint={
              env.support === "off"
                ? "Support is not turned on here (HEKATE_SUPPORT is off). Ask whoever runs the instance."
                : env.support === "link"
                  ? "A desk of the operator's own."
                  : "By email."
            }
          >
            {env.support !== "off" && (
              <Button variant="secondary" size="md">
                Open it
              </Button>
            )}
          </Row>
        </Section>
      )}
      {sec === "support" && env.support === "app" && !newTicket && (
        <>
          <Section
            title="Your tickets"
            intro="What this workspace has asked the people who run the instance, and their answers."
            action={
              <Button
                variant="primary"
                size="md"
                onClick={() =>
                  navigate({
                    to: "/settings/$section",
                    params: { section: "support" },
                    search: { new: "1" },
                  })
                }
              >
                <Icon name="plus" size={14} />
                New ticket
              </Button>
            }
          >
            {tickets
              .filter((t) => t.workspace === organisation.name)
              .map((t) => (
                <TicketRow
                  key={t.id}
                  ticket={t}
                  onOpen={() =>
                    navigate({
                      to: "/settings/$section",
                      params: { section: "support" },
                      search: { ticket: t.id },
                    })
                  }
                />
              ))}
          </Section>
          <Section title="Help yourself" intro="Most answers are already written down.">
            <Row name="Documentation" hint={env.docsUrl.replace(/^https?:\/\//, "")}>
              <Button
                variant="ghost"
                size="md"
                onClick={() => window.open(env.docsUrl, "_blank", "noopener")}
              >
                Open
              </Button>
            </Row>
            <StatusRows />
          </Section>
        </>
      )}
      {sec === "support" &&
        env.support === "app" &&
        newTicket &&
        (sent ? (
          <Section
            title="Sent"
            intro="You will hear back by email and in the inbox; the thread lives here."
          >
            <Row
              name={`Ticket ${sent}`}
              hint="Normal severity answers within a working day; higher ones faster."
            >
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setSent(null);
                  navigate({ to: "/settings/$section", params: { section: "support" } });
                }}
              >
                Back to your tickets
              </Button>
            </Row>
          </Section>
        ) : (
          <>
            <Section title="Before you ask" intro="A minute here often saves a day.">
              <div className="flex flex-col gap-3 px-4 py-3">
                <div className="relative">
                  <Icon
                    name="search"
                    size={16}
                    className="absolute top-1/2 left-3 -translate-y-1/2 text-ink-3"
                  />
                  <Input placeholder="Search the documentation" className="w-full pl-9" />
                </div>
                <div className="grid gap-2 @3xl/app:grid-cols-3">
                  {[
                    ["A file will not play", "Checks, renditions and what the player needs"],
                    ["Reviewers cannot see a file", "Permissions, groups and per-review overrides"],
                    [
                      "Loudness reads differently elsewhere",
                      "Integrated loudness, true peak and the delivery profile",
                    ],
                  ].map(([t, h]) => (
                    <button
                      key={t}
                      type="button"
                      className="rounded-panel border border-line px-3 py-2.5 text-left transition-colors hover:border-edge hover:bg-raised/40"
                    >
                      <span className="block text-[13px] text-ink">{t}</span>
                      <span className="block text-[12px] text-ink-3">{h}</span>
                    </button>
                  ))}
                </div>
              </div>
              <StatusRows hint="Something down for everyone is posted here first." />
            </Section>
            <Section
              title="New ticket"
              intro="The reference is made for you when you send. Operators see the error's whole story if you include its reference in the message."
            >
              <div className="flex flex-col gap-4 px-4 py-4">
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Subject
                  <Input placeholder="What is wrong, in a line" autoFocus />
                </label>
                <div className="grid gap-4 @md/app:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Type
                    <Select defaultValue="problem">
                      <option value="problem">Something is broken</option>
                      <option value="question">A question</option>
                      <option value="billing">Billing</option>
                      <option value="idea">An idea</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Severity
                    <Select
                      value={severity}
                      onChange={(e) => setSeverity(e.target.value as TicketSeverity)}
                    >
                      {severities.map((sv) => (
                        <option key={sv.id} value={sv.id} disabled={sv.from === "Label"}>
                          {sv.label}
                          {sv.from === "Label" ? " (Label plan)" : ""}
                        </option>
                      ))}
                    </Select>
                    <span className="text-[12px] text-ink-3">
                      {severities.find((sv) => sv.id === severity)?.hint}. Urgent and Emergency come
                      with the Label plan.
                    </span>
                  </label>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Message
                  <Textarea
                    placeholder="What you did, what you expected, what happened. Paste the error reference if you saw one."
                    className="h-32"
                  />
                </label>
                <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Attachments
                  <div className="flex items-center gap-3 rounded-panel border border-dashed border-line px-3 py-3 text-[12px] text-ink-3">
                    <Icon name="upload" size={14} />
                    Drop screenshots or files here, or
                    <Button variant="ghost" size="sm">
                      choose
                    </Button>
                  </div>
                </div>
                {/* The last failure this person saw here, offered to attach (#159, #181). */}
                <label className="flex items-start gap-2 text-[13px] text-ink-2">
                  <input type="checkbox" defaultChecked className="mt-1" />
                  <span>
                    Attach error <span className="tabular">HK-7F3A-2C</span>
                    <span className="block text-[12px] text-ink-3">
                      The last error you saw here, 12 minutes ago. The operators see its whole
                      story.
                    </span>
                  </span>
                </label>
                {/* Only when Contact support was opened on a file or a review. */}
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  <input type="checkbox" defaultChecked /> Let the operators open the file in
                  question
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      navigate({ to: "/settings/$section", params: { section: "support" } })
                    }
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    className="ml-auto"
                    onClick={() => setSent(newReference("T"))}
                  >
                    Send
                  </Button>
                </div>
              </div>
            </Section>
          </>
        ))}
      {sec === "api" && (
        <>
          <Section
            title="OAuth clients"
            intro="Applications registered here can ask people for access with OAuth 2.1 and PKCE. Each gets a client id; confidential clients get a secret shown once."
            action={
              <Button variant="primary" size="md" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                Client
              </Button>
            }
          >
            {[
              {
                name: "Hekate for Slack",
                id: "hk_cli_7f3a…",
                kind: "Confidential",
                redirect: "https://slack.endlesshall.example/oauth/callback",
                scopes: "reviews:read, comments",
                users: 4,
                live: true,
              },
              {
                name: "Hekate for Logic Pro",
                id: "hk_cli_2c91…",
                kind: "Public (PKCE)",
                redirect: "hekate-logic://callback",
                scopes: "files:write, comments",
                users: 2,
                live: true,
              },
              {
                name: "Mastering handoff (test)",
                id: "hk_cli_a0d4…",
                kind: "Confidential",
                redirect: "http://localhost:3000/callback",
                scopes: "files:read",
                users: 0,
                live: false,
              },
            ].map((c) => (
              <Row
                key={c.id}
                name={
                  <span className="flex items-center gap-2">
                    <Dot state={c.live ? "approved" : "invited"} />
                    {c.name}
                    <span className="tabular text-[12px] text-ink-3">{c.id}</span>
                  </span>
                }
                hint={`${c.kind} · ${c.redirect} · ${c.scopes} · ${c.users} ${c.users === 1 ? "person" : "people"} connected`}
              >
                <ActionMenu
                  always
                  label={c.name}
                  actions={[
                    { label: "Edit…", onSelect: () => setAdding(true) },
                    // A public client has no secret to rotate: it proves each exchange with PKCE.
                    ...(c.kind === "Confidential"
                      ? [
                          {
                            label: "Rotate the secret…",
                            onSelect: () => setClientDialog({ name: c.name, view: "rotate" }),
                          },
                        ]
                      : []),
                    {
                      label: "Who has connected",
                      onSelect: () => setClientDialog({ name: c.name, view: "connections" }),
                    },
                    "divider",
                    { label: "Delete…", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          {clientDialog?.view === "connections" && (
            <Dialog
              title={`Who has connected ${clientDialog.name}`}
              description="Each acts as the person who connected it, within what they granted. They disconnect it in Account, Connected apps."
              onClose={() => setClientDialog(null)}
            >
              <div className="flex flex-col divide-y divide-line rounded-panel border border-line">
                {[
                  ["Mira Solberg", "Read reviews, read and write comments", "19 Aug", "2 h ago"],
                  ["Tomas Varga", "Read reviews", "2 Sep", "yesterday"],
                  ["Ines Arlow", "Read reviews, read and write comments", "11 Sep", "3 d ago"],
                  ["Alex Rivera", "Read reviews", "4 Oct", "not used yet"],
                ].map(([who, may, since, last]) => (
                  <Row
                    key={who}
                    name={who}
                    hint={`${may} · connected ${since} · ${last === "not used yet" ? last : `last used ${last}`}`}
                  />
                ))}
              </div>
            </Dialog>
          )}
          {clientDialog?.view === "rotate" && (
            <Dialog
              title={`Rotate the secret of ${clientDialog.name}?`}
              description="The old secret stops working at once. Tokens already issued keep working; the application needs the new secret to refresh them."
              onClose={() => setClientDialog(null)}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setClientDialog(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setClientDialog({ name: clientDialog.name, view: "secret" })}
                  >
                    Rotate secret
                  </Button>
                </>
              }
            >
              <p className="text-[13px] text-ink-3">
                Now <span className="tabular text-ink-2">hk_cls_9b21…</span>, since 19 Aug
              </p>
            </Dialog>
          )}
          {clientDialog?.view === "secret" && (
            <Dialog
              title={`New secret for ${clientDialog.name}`}
              description="The secret is shown once. Copy it now: Hekate keeps only a hash of it."
              onClose={() => setClientDialog(null)}
              footer={
                <Button variant="primary" onClick={() => setClientDialog(null)}>
                  Done
                </Button>
              }
            >
              <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Client secret
                <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 p-2 pl-3">
                  <span className="tabular min-w-0 flex-1 truncate text-[12px] text-ink-2">
                    hk_cls_4QnT0x2c9LrVb8mWk1yZpHs6dJfA3uEoNiGtR7aKqCw
                  </span>
                  <Button size="sm">Copy</Button>
                </div>
              </div>
            </Dialog>
          )}
          <Section
            title="Service tokens"
            intro="Tokens that act as the workspace rather than a person, for the release pipeline and the like. Scoped and logged like any other."
          >
            {[
              {
                name: "Release pipeline",
                scopes: "files:read, reviews:read",
                used: "2 h ago",
                expires: "2 Jan 2027",
              },
              { name: "Archive sync", scopes: "downloads", used: "last night", expires: "Never" },
            ].map((t) => (
              <Row
                key={t.name}
                name={t.name}
                hint={`${t.scopes} · last used ${t.used} · expires ${t.expires.toLowerCase()}`}
              >
                <ActionMenu
                  always
                  label={t.name}
                  actions={[
                    { label: "Rename…", onSelect: () => {} },
                    { label: "Change scopes…", onSelect: () => {} },
                    "divider",
                    { label: "Revoke…", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
            <Row name="New service token" hint="Shown once; owners and admins only.">
              <Button variant="secondary" size="md">
                Create
              </Button>
            </Row>
          </Section>
          <Section
            title="Scopes"
            intro="What a client or token may ask for. People grant them one by one; a token holds the ones it was made with."
          >
            {[
              ["files:read", "List and read files, versions and variations"],
              ["files:write", "Upload versions and variations, make folders"],
              ["reviews:read", "Read reviews, reviewers and decisions"],
              ["reviews:write", "Request reviews and record decisions as the person"],
              ["comments", "Read and write comments and their anchors"],
              ["downloads", "Download originals, watermarked and logged"],
              ["workflows", "Read and change workflows"],
              ["org:read", "Members, roles and settings, read-only"],
            ].map(([k, v]) => (
              <Row key={k} name={<span className="tabular">{k}</span>} hint={v} />
            ))}
          </Section>
          {/* The workspace's own API log (#198): what the instance's Logs show operators, for
              this workspace alone. */}
          <Section
            title="API log"
            intro="The latest calls made with this workspace's tokens, members' own among them, over the last week."
          >
            {[
              [
                "14 Oct, 09:58:12",
                "Release pipeline (service)",
                "GET /api/projects",
                "200",
                "38 ms",
              ],
              [
                "14 Oct, 09:58:13",
                "Release pipeline (service)",
                "POST /api/projects/…/folders",
                "403",
                "4 ms",
              ],
              ["14 Oct, 08:41:02", "Logic Pro export", "POST /api/uploads", "201", "112 ms"],
            ].map(([when, token, call, status, time]) => (
              <div
                key={when}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-[13px] @3xl/app:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.4fr)_60px_70px]"
              >
                <span className="tabular text-ink-3">{when}</span>
                <span
                  className={cn(
                    "tabular justify-self-end @3xl/app:order-4 @3xl/app:justify-self-start",
                    status === "403" ? "text-signal" : "text-ink-3",
                  )}
                >
                  {status}
                </span>
                <span className="col-span-2 truncate text-ink-2 @3xl/app:order-2 @3xl/app:col-span-1">
                  {token}
                </span>
                <span className="tabular col-span-2 truncate text-ink @3xl/app:order-3 @3xl/app:col-span-1">
                  {call}
                </span>
                <span className="tabular hidden text-right text-ink-3 @3xl/app:order-5 @3xl/app:block">
                  {time}
                </span>
              </div>
            ))}
          </Section>
        </>
      )}
      {sec === "email" && <EmailSection />}
      {sec === "branding" && <BrandingSection />}
      {sec === "brand" && (
        <>
          <BrandSection />
          <ComponentsSection />
        </>
      )}
      {sec === "general" && (
        <>
          <Section title="Workspace">
            <Row name="Name">
              <Input defaultValue={organisation.name} className="w-64" />
            </Row>
            <Row name="New projects start as" hint="The profile only decides which tools appear.">
              <Select defaultValue="music" className="w-40">
                <option value="music">Music</option>
                <option value="video">Video</option>
                <option value="general">General</option>
              </Select>
            </Row>
            <Row
              name="Guests sign in with"
              hint="The link alone, or the link plus a code sent to their email."
            >
              <Select defaultValue={organisation.guestVerification} className="w-56">
                <option value="link">The link alone</option>
                <option value="code">A code by email</option>
              </Select>
            </Row>
            <Row name="Guest links last">
              <Select defaultValue="14" className="w-40">
                <option value="3">3 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </Select>
            </Row>
            <Row name="Language" hint="For members who have not chosen their own in Account.">
              <Select defaultValue="en-GB" className="w-56">
                <option value="en-GB">British English</option>
                <option value="en-US">American English</option>
                <option value="de">Deutsch</option>
              </Select>
            </Row>
            {/* #481: dates read in ISO 8601 unless the instance or the workspace chose otherwise. */}
            <Row name="Dates" hint="How dates read here, in lists, comments, mail and exports.">
              <Select defaultValue="" className="w-56">
                <option value="">Instance default (ISO 8601)</option>
                <option value="iso">ISO 8601 (2026-10-29)</option>
                <option value="day-month-year">Day, month, year (29 Oct 2026)</option>
                <option value="month-day-year">Month, day, year (Oct 29, 2026)</option>
              </Select>
            </Row>
            <Row name="Times" hint="The clock beside them.">
              <Select defaultValue="" className="w-56">
                <option value="">Instance default (24-hour)</option>
                <option value="24h">24-hour (14:05)</option>
                <option value="12h">12-hour (2:05 pm)</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Workspaces you are in"
            intro="Switch from the menu at the top of the sidebar."
          >
            <Row name={organisation.name} hint="Owner">
              <Dot state="approved" />
            </Row>
            <Row name="North Choir Collective" hint="Member" />
          </Section>
          {/* #186: an owner's export, encrypted with age to a key shown once, kept a week. */}
          <Section
            title="Export"
            intro="Everything the workspace holds, to keep, to move elsewhere, or for an audit. Owners only, and logged."
          >
            <Row
              name="Export everything"
              hint="Every record as JSON and every file as it was uploaded, in one archive encrypted with age. Kept 7 days for its download."
            >
              <Button variant="secondary" size="md">
                Start an export…
              </Button>
            </Row>
            <Row name="20 October, 18:04" hint="38.2 GB · 1,204 files · until 27 October">
              <Button variant="ghost" size="md">
                <Icon name="download" size={13} />
                Download
              </Button>
            </Row>
          </Section>
          <Danger>
            <Row
              name="Delete this workspace"
              hint="Every project, file and review. Only an owner, with a second owner confirming."
            >
              <Button variant="secondary" size="md" className="text-signal">
                Delete…
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "defaults" && (
        <>
          <Section
            title="Reviewer permissions"
            intro="What a review grants unless the request says otherwise. A member's project role is always the ceiling."
          >
            <SwitchRow name="May comment" checked />
            <SwitchRow name="May decide, in an approval" checked />
            <Row name="Comments they see">
              <Select defaultValue="all" className="w-56">
                <option value="all">Everyone's</option>
                <option value="own_and_replies">Their own and replies to them</option>
                <option value="own">Only their own</option>
              </Select>
            </Row>
            <SwitchRow name="May see earlier versions" checked />
            <Row name="Download">
              <Select defaultValue="none" className="w-40">
                <option value="none">Nothing</option>
                <option value="proxy">The proxy</option>
                <option value="original">The original</option>
              </Select>
            </Row>
            <Row name="Access window">
              <Select defaultValue="none" className="w-48">
                <option value="none">While the review is open</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Versions"
            intro="What new projects start with; each project can change it."
          >
            <SwitchRow
              name="Carried comments shown on the new version"
              hint="Open comments travel to the next version; off keeps them hidden until triage shows them."
              checked
            />
          </Section>
          <Section
            title="Tool access"
            intro="What the five default roles get in a new project. Projects override it."
          >
            <Matrix
              heading="Tool"
              columns={["Producer", "Engineer", "Editor", "Reviewer", "Viewer"].map((r) => ({
                id: r,
                label: r,
              }))}
              rows={(Object.keys(toolCopy) as Tool[]).map((t) => ({
                id: t,
                label: toolCopy[t].label,
              }))}
              value={(row, col) =>
                col === "Viewer"
                  ? row === "score"
                  : col === "Reviewer"
                    ? ["score", "compare", "loops", "normalise"].includes(row)
                    : col === "Editor"
                      ? row !== "production"
                      : true
              }
              onToggle={() => {}}
            />
          </Section>
        </>
      )}
      {sec === "categories" && (
        <Section
          title="Comment categories"
          intro="The set every new project starts with. A project may add its own."
          action={
            <Button variant="secondary" size="md">
              <Icon name="plus" size={14} />
              Category
            </Button>
          }
        >
          {/* No colours: a category has none anywhere in the product (decision 247). */}
          {categories.map((c) => (
            <Row
              key={c.id}
              name={c.name}
              hint={
                c.handling === "deferred"
                  ? `Deferred to a stage named ${c.stage}`
                  : c.handling === "information"
                    ? "Information only: no action expected"
                    : "Handled on this version"
              }
            >
              <ActionMenu
                always
                label={c.name}
                actions={[
                  { label: "Rename or change handling…", onSelect: () => {} },
                  "divider",
                  { label: "Delete…", danger: true, onSelect: () => {} },
                ]}
              />
            </Row>
          ))}
        </Section>
      )}
      {sec === "delivery" && (
        <>
          <Section title="Workspace default">
            <Row
              name="Measured against"
              hint="For projects, tracks and files that choose nothing nearer."
            >
              <Select defaultValue="" className="w-60">
                <option value="">Suggested from each file</option>
                {deliveryProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Row>
          </Section>
          <Section
            title="Delivery profiles"
            intro="What QA measures against. The built-in ones cannot be changed; add your own."
            action={
              <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                Profile
              </Button>
            }
          >
            {deliveryProfiles.map((p) => (
              <Row
                key={p.id}
                name={p.name}
                hint={[
                  p.loudness !== null ? `${p.loudness} LUFS ±${p.tolerance}` : "no loudness target",
                  `${p.truePeak} dBTP`,
                  p.rates.map((r) => `${r / 1000} kHz`).join(", "),
                  p.bitDepth ? `${p.bitDepth}-bit` : "any depth",
                  p.layout,
                  p.lossless ? "lossless" : "lossy allowed",
                ].join(" · ")}
              >
                {p.id === "custom" ? (
                  <ActionMenu
                    always
                    label={p.name}
                    actions={[
                      { label: "Edit", onSelect: () => setAdding(true) },
                      "divider",
                      { label: "Delete", danger: true, onSelect: () => {} },
                    ]}
                  />
                ) : (
                  <span className="text-[12px] text-ink-3">built in</span>
                )}
              </Row>
            ))}
          </Section>
        </>
      )}
      {sec === "security" && (
        <>
          <Section title="Sign-in policy">
            <Row
              name="Methods allowed"
              hint="Members pick from these; guests always use their link."
            >
              <span className="flex flex-wrap gap-1.5">
                {["Password", "Passkey", "Single sign-on", "Directory (LDAP)"].map((m) => (
                  <span
                    key={m}
                    className="rounded-chip bg-raised px-2 text-[12px] leading-6 text-ink-2"
                  >
                    {m}
                  </span>
                ))}
              </span>
            </Row>
            <Row
              name="Second factor required of"
              hint="A code app, a passkey or a hardware security key, with recovery codes. People without one are asked at their next sign-in and cannot carry on until they add one. Guests use their link."
            >
              <Select defaultValue="everyone" className="w-48">
                <option value="off">Nobody</option>
                <option value="admins">Owners and admins</option>
                <option value="everyone">Everyone</option>
              </Select>
            </Row>
            <SwitchRow
              name="Passkey or hardware security key required for owners and admins"
              checked={false}
            />
            {/* Within the instance's own length (decision 248): only shorter ones are offered. */}
            <Row
              name="Sessions end after"
              hint="Counted from signing in, however much it is used. The instance ends any session unused for 14 days."
            >
              <Select defaultValue="" className="w-48">
                <option value="">As the instance has it</option>
                <option value="1">1 day</option>
                <option value="7">7 days</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Single sign-on"
            intro="One identity provider, by OIDC or SAML. Members sign in through it, and their first sign-in makes their account."
          >
            <SwitchRow
              name="Sign in with single sign-on"
              hint="Turned off, nobody new can join through it, and its members sign in with a password or passkey."
              checked
            />
            <Row name="Provider">
              <Select defaultValue="oidc" className="w-40">
                <option value="oidc">OIDC</option>
                <option value="saml">SAML</option>
              </Select>
            </Row>
            <Row name="Issuer" hint="Its discovery document is read when you save.">
              <Input
                defaultValue="https://login.endlesshall.example/realms/hekate"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <Row name="Client" hint="The client secret is never shown again.">
              <span className="flex flex-wrap gap-2">
                <Input defaultValue="hekate" className="w-48" aria-label="Client ID" />
                <Input
                  type="password"
                  placeholder="Kept"
                  className="w-40"
                  aria-label="Client secret"
                />
              </span>
            </Row>
            <Row name="Redirect URI">
              <Input
                readOnly
                defaultValue="https://review.endlesshall.example/api/auth/sso/callback/workspace-endless-hall"
                className="w-full font-mono text-[12px] @3xl/app:w-96"
              />
            </Row>
            <Row name="Groups" hint="The claim that lists a person's groups.">
              <Input defaultValue="groups" className="w-40" />
            </Row>
            <Row
              name="Admins"
              hint="Groups whose people are admins here, separated by commas. Everyone else is a member; owners stay owners."
            >
              <Input defaultValue="hekate-admins" className="w-full @3xl/app:w-96" />
            </Row>
            <SwitchRow
              name="Enforce single sign-on"
              hint="Members sign in only through it. Owners keep their password, so a broken provider never locks the workspace out."
              checked={false}
            />
            <Row name="Save" hint="Saving an OIDC issuer checks that it answers.">
              <span className="flex gap-2">
                <Test state={state === "failed" ? "failed" : "idle"} />
                <Button variant="primary" size="md">
                  Save
                </Button>
              </span>
            </Row>
          </Section>
          <Section
            title="Directory (LDAP)"
            intro={`Members choose "Sign in with your workspace's directory" and enter endless-hall-records. Their first sign-in makes their account.`}
          >
            <SwitchRow
              name="Sign in with the directory"
              hint="Turned off, nobody new can join through it, and its members sign in with a password or passkey."
              checked
            />
            <Row name="Server" hint="ldaps:// with its port; ldap:// only on a network you trust.">
              <Input
                defaultValue="ldaps://directory.endlesshall.example:636"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <SwitchRow name="Verify the certificate" checked />
            <Row
              name="Service account"
              hint="Searches for people. Left empty, the search is anonymous. The password is never shown again."
            >
              <span className="flex flex-wrap gap-2">
                <Input defaultValue="cn=hekate,ou=services,dc=endlesshall" className="w-64" />
                <Input
                  type="password"
                  placeholder="Kept"
                  className="w-32"
                  aria-label="Service account password"
                />
              </span>
            </Row>
            <Row name="People" hint="Where they are, and the filter that finds one by username.">
              <span className="flex flex-wrap gap-2">
                <Input defaultValue="ou=people,dc=endlesshall" className="w-64" />
                <Input defaultValue="(uid={username})" className="w-40" />
              </span>
            </Row>
            <Row name="Attributes" hint="Which hold the email address and the name.">
              <span className="flex flex-wrap gap-2">
                <Input defaultValue="mail" className="w-32" aria-label="Email attribute" />
                <Input defaultValue="cn" className="w-32" aria-label="Name attribute" />
              </span>
            </Row>
            <Row
              name="Groups"
              hint="Where groups are, and the filter that finds a person's groups."
            >
              <span className="flex flex-wrap gap-2">
                <Input defaultValue="ou=groups,dc=endlesshall" className="w-64" />
                <Input defaultValue="(member={dn})" className="w-40" />
              </span>
            </Row>
            <Row
              name="Admins"
              hint="Groups whose people are admins here, by name or DN, separated by commas. Everyone else is a member; owners stay owners."
            >
              <Input defaultValue="producers" className="w-full @3xl/app:w-96" />
            </Row>
            <Row name="Test" hint="Connects with the saved settings.">
              <span className="flex gap-2">
                <Test state={state === "refused" ? "failed" : "idle"} />
                <Button variant="primary" size="md">
                  Save
                </Button>
              </span>
            </Row>
          </Section>
        </>
      )}
      {sec === "notifications" && (
        <>
          <Section
            title="Channels"
            intro="Where events go. Each channel has its own fields and a test; a channel that keeps failing pauses itself."
            action={
              <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                Channel
              </Button>
            }
          >
            {channels.map((c) => (
              <Row
                key={c.id}
                name={
                  <span className="flex items-center gap-2.5">
                    <span className="flex size-7 items-center justify-center rounded-control bg-raised text-ink-2">
                      <Icon
                        name={
                          c.id === "slack"
                            ? "slack"
                            : c.id === "discord"
                              ? "discord"
                              : c.id === "webhook"
                                ? "webhook"
                                : "mail"
                        }
                        size={16}
                      />
                    </span>
                    {c.name}
                    <Dot
                      state={
                        c.state === "on"
                          ? "approved"
                          : c.state === "paused"
                            ? "changes_requested"
                            : "invited"
                      }
                      className="size-[7px]"
                    />
                  </span>
                }
                hint={c.hint}
              >
                {c.state !== "off" && (
                  <span className="hidden text-[12px] text-ink-3 @3xl/app:inline">{c.events}</span>
                )}
                <Button variant="secondary" size="md">
                  {c.state === "paused" ? "Resume" : c.state === "off" ? "Connect" : "Test"}
                </Button>
                <ActionMenu
                  always
                  label={c.name}
                  actions={[
                    { label: "Edit", onSelect: () => {} },
                    { label: "Which events…", onSelect: () => {} },
                    "divider",
                    { label: "Remove", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
            {state === "processing" && (
              <Row
                name="Log only"
                hint="No mail is sent: the instance writes everything to its log, as in development. Give the workspace its own mail, or ask the operator to set the instance's."
              />
            )}
          </Section>
          <Section title="Events" intro="Which events each channel carries.">
            <Matrix
              heading="Event"
              columns={channels
                .filter((c) => c.state !== "off")
                .map((c) => ({ id: c.id, label: c.name }))}
              rows={[
                "A review is requested",
                "A decision is recorded",
                "Feedback is submitted",
                "A new version arrives",
                "A stage starts",
                "A comment mentions someone",
                "A guest signs in",
                "A download happens",
                "Processing fails",
              ].map((e) => ({ id: e, label: e }))}
              value={(row, col) =>
                col === "webhook"
                  ? true
                  : col === "slack"
                    ? ["A decision is recorded", "A new version arrives"].includes(row)
                    : true
              }
              onToggle={() => {}}
            />
          </Section>
          <Section title="API and MCP">
            <Row name="API keys" hint="Scoped to the workspace; shown once.">
              <Button variant="secondary" size="md">
                New key
              </Button>
            </Row>
            {/* The keys themselves are listed once, under API and OAuth clients, Service tokens. */}
            <Row
              name="MCP endpoint"
              hint="https://review.endlesshall.example/api/mcp · tools for what waits on you, reviews, comments, decisions and QA reports"
            >
              <Button variant="secondary" size="md">
                Copy
              </Button>
            </Row>
          </Section>
        </>
      )}
      {sec === "storage" && (
        <>
          <Section
            title="Usage"
            intro="Uploads are refused at the storage quota and invitations at the member limit, which the instance’s operators set; this page warns from 90%."
          >
            <Row name="Storage" hint="245 GB of 1.0 TB">
              <span className="block h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-raised">
                <span className="block h-full w-[24.5%] rounded-full bg-ink-2" />
              </span>
            </Row>
            <Row name="Members" hint="12 of 25 · 2 invited, each taking a place">
              <span className="block h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-raised">
                <span className="block h-full w-[56%] rounded-full bg-ink-2" />
              </span>
            </Row>
            <Row name="Guests and projects" hint="31 guests · 2 projects" />
            <Row name="This month" hint="184 plays · 12 downloads · storage at its peak 251 GB" />
          </Section>
          <Section
            title="Backends"
            action={
              <Button variant="secondary" size="md" onClick={() => setAdding(true)}>
                <Icon name="plus" size={14} />
                Backend
              </Button>
            }
          >
            <Row
              name={
                <span className="flex items-center gap-2">
                  <Dot state="approved" />
                  Local disk
                </span>
              }
              hint="/var/lib/hekate/objects · 1.9 TB free of 4 TB"
            >
              <span className="text-[12px] text-ink-3">31 GB used</span>
            </Row>
            <Row
              name={
                <span className="flex items-center gap-2">
                  <Dot state="approved" />
                  Hetzner Object Storage (S3)
                </span>
              }
              hint="hekate-endless-hall, eu-central · default for new objects"
            >
              <span className="text-[12px] text-ink-3">214 GB used</span>
              <ActionMenu
                always
                label="backend"
                actions={[
                  { label: "Edit", onSelect: () => {} },
                  { label: "Make default", onSelect: () => {} },
                ]}
              />
            </Row>
          </Section>
          <Section title="Usage by project">
            {projects.map((p) => (
              <Row key={p.id} name={p.name} hint="originals, renditions, pages and peaks">
                <span className="tabular text-[14px] text-ink">
                  {p.id === "proj-joplin" ? "14.2 GB" : "231 GB"}
                </span>
              </Row>
            ))}
          </Section>
          <Section
            title="Reconciliation"
            intro="Every night the storage is compared with the database. Bytes nothing uses are removed once a second run, a day later, still finds them; missing files wait for a person."
          >
            <Row name="Last run">
              <span className="text-[13px] text-ink-2">Today 03:00</span>
            </Row>
            <Row name="Unused bytes" hint="In storage, but no file uses them">
              <span className="tabular text-[13px] text-ink-2">3</span>
            </Row>
            <Row
              name="Missing files"
              hint={
                state === "failed"
                  ? "Files the database expects that their backend no longer holds. Restore them from a backup."
                  : "Every file is where the database expects it."
              }
            >
              {state === "failed" ? (
                <span className="flex items-center gap-1.5 text-[13px] text-signal">
                  <Icon name="warning" size={13} />2
                </span>
              ) : (
                <span className="text-[13px] text-ink-2">None</span>
              )}
            </Row>
            <Row name="Removed in the last 30 days">
              <span className="tabular text-[13px] text-ink-2">12</span>
            </Row>
            <Row name="Run now" hint="Checks this workspace only.">
              <Button variant="secondary" size="md">
                Reconcile
              </Button>
            </Row>
          </Section>
        </>
      )}
      {sec === "leaks" && (
        <>
          <Section
            title="Forensic marking"
            intro="Every stream and permitted download carries an inaudible, invisible mark that names the person who received it."
          >
            <SwitchRow
              name="Audio"
              hint="Off until you turn it on. Listen to a marked download of quiet material first."
              checked={false}
            />
            <SwitchRow name="Video" checked />
            <SwitchRow
              name="Pages"
              hint="The visible watermark is set per project; this is the hidden one."
              checked
            />
          </Section>
          <Section
            title="Trace a leak"
            intro="Upload the file that got out. It is matched against every mark issued, and kept only while it is."
          >
            <Row name="Suspected leak" stacked>
              <div className="flex w-full flex-col gap-3">
                {leak === "idle" && (
                  <button
                    type="button"
                    onClick={() => {
                      setLeak("scanning");
                      setTimeout(() => setLeak(state === "failed" ? "none" : "match"), 1200);
                    }}
                    className="flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-8 text-center transition-colors hover:border-edge-strong hover:bg-raised/40"
                  >
                    <Icon name="upload" size={20} className="text-ink-3" />
                    <span className="text-[14px] text-ink">Drop the file here, or choose it</span>
                    <span className="text-[13px] text-ink-3">
                      Twenty seconds of the recording is usually enough, even encoded again as MP3,
                      AAC or Opus. Only the first ten minutes are examined.
                    </span>
                  </button>
                )}
                {leak === "scanning" && (
                  <span className="flex items-center gap-2 text-[13px] text-ink-2">
                    <span className="breathe size-2 rounded-full border border-ink-2" />
                    Scanning leaked-maple.mp3 against 41 marks
                  </span>
                )}
                {leak === "match" && (
                  <div className="rise-in flex flex-col gap-2 rounded-panel border border-signal/40 bg-signal/[0.06] p-4 text-[14px]">
                    <span className="flex items-center gap-2 text-ink">
                      <Icon name="warning" size={14} className="text-signal" />
                      Match: the chance of a mistake is less than one in a billion
                    </span>
                    <span className="flex items-center gap-2 text-ink-2">
                      <Avatar personId="p-mira" size={20} />
                      Mira Solberg (guest) · download of Maple Leaf Rag V2 Dry · 13 Oct 2026, 17:02
                      · through Reference mixes for rehearsal
                    </span>
                    <span className="flex gap-2">
                      <Button variant="secondary" size="sm">
                        Open the access log
                      </Button>
                      <Button variant="ghost" size="sm">
                        Revoke her access
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setLeak("idle")}>
                        Trace another
                      </Button>
                    </span>
                  </div>
                )}
                {leak === "none" && (
                  <div className="rise-in flex items-center gap-3 rounded-panel border border-line p-4 text-[14px] text-ink-2">
                    No mark found. The file may predate marking, or be too short or too degraded.{" "}
                    <Button variant="ghost" size="sm" onClick={() => setLeak("idle")}>
                      Try another
                    </Button>
                  </div>
                )}
              </div>
            </Row>
          </Section>
        </>
      )}
      {sec === "transfers" && (
        <>
          <Section title="This workspace">
            <Row
              name="Its address"
              hint="Someone moving a project here from a workspace you are not in gives it."
            >
              <code className="tabular text-[14px] text-ink">endless-hall</code>
            </Row>
          </Section>
          <Section title="Waiting">
            <Row
              name="Opening titles"
              hint="To Endless Hall Records East. Tomas Varga asked on 14 October. Waiting for approval by a second member of Endless Hall Records and acceptance by Endless Hall Records East."
            >
              <span className="flex gap-2">
                <Button variant="ghost" size="md">
                  Refuse
                </Button>
                <Button variant="secondary" size="md">
                  Approve…
                </Button>
              </span>
            </Row>
          </Section>
          <Section title="Settled">
            <Row name="Joplin Rags" hint="From Endless Hall Records East. Asked on 2 October.">
              <span className="text-[13px] text-ink-2">Moved</span>
            </Row>
          </Section>
        </>
      )}
      {sec === "log" && <AccessLogSection empty={state === "empty"} />}
      {sec === "operations" && (
        <>
          <Section title="This instance">
            <Row name="Version" hint="Build 4f1c2a9b7e03">
              <span className="tabular text-[13px] text-ink-2">0.2.0</span>
            </Row>
            <Row name="Worker" hint="Runs analysis, renditions, pages and mail.">
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px]",
                  state === "failed" ? "text-signal" : "text-ink-2",
                )}
              >
                <Dot state={state === "failed" ? "changes_requested" : "approved"} />
                {state === "failed" ? "Not running: no job finished in the last ten minutes" : "On"}
              </span>
            </Row>
            <Row
              name="Queue"
              hint="This workspace's jobs: waiting · running · failed in the last day."
            >
              <span
                className={cn(
                  "tabular text-[13px]",
                  state === "failed" ? "text-signal" : "text-ink-2",
                )}
              >
                {state === "failed" ? "38 · 0 · 12" : "2 · 1 · 0"}
              </span>
            </Row>
            <Row
              name="Encryption"
              hint="Every file has its own key, wrapped by the workspace key, which the instance's master key wraps."
            >
              <span className="text-[13px] text-ink-2">
                {state === "processing" ? "Key v3 · re-wrapping, 41 to go" : "Key v3 since 2 Oct"}
              </span>
            </Row>
            <Row name="Metrics" hint="For Prometheus.">
              <span className="tabular text-[13px] text-ink-2">/metrics · read 14 s ago</span>
            </Row>
          </Section>
          <Section title="Backups and upgrades">
            <Row
              name="Backups"
              hint="The instance's operator takes them: the database and the settings file, with the master key kept apart."
            >
              <Button variant="secondary" size="md">
                How backups work
              </Button>
            </Row>
            <Row
              name="Upgrade"
              hint="Hekate 0.2.1 is available. Pull the new image and restart; migrations run on start."
            >
              <Button variant="secondary" size="md">
                Release notes
              </Button>
            </Row>
          </Section>
        </>
      )}
      {adding && (
        <Dialog
          title={
            sec === "delivery"
              ? "New delivery profile"
              : sec === "storage"
                ? "New storage backend"
                : sec === "notifications"
                  ? "New channel"
                  : sec === "api"
                    ? "New OAuth client"
                    : sec === "billing"
                      ? "Change plan"
                      : "New"
          }
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setAdding(false)}>
                Save
              </Button>
            </>
          }
        >
          {sec === "billing" ? (
            <div className="flex flex-col gap-2">
              {[
                ["Solo", "£0", "100 GB · 3 members · 1 project", false],
                [
                  "Studio",
                  "£49 a month",
                  "1 TB · 25 members · forensic marking · priority support",
                  true,
                ],
                [
                  "Label",
                  "£190 a month",
                  "5 TB · no member limit · SSO · a dedicated contact",
                  false,
                ],
              ].map(([n, pr, h, now]) => (
                <label
                  key={String(n)}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-panel border px-3 py-2.5",
                    now ? "border-edge bg-raised/60" : "border-line hover:bg-raised/40",
                  )}
                >
                  <input type="radio" name="plan" defaultChecked={Boolean(now)} className="mt-1" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2 text-[14px] text-ink">
                      {n}
                      <span className="tabular text-[12px] text-ink-3">{pr}</span>
                      {now && <span className="text-[11px] text-ink-3">current</span>}
                    </span>
                    <span className="block text-[12px] text-ink-3">{h}</span>
                  </span>
                </label>
              ))}
              <p className="text-[12px] text-ink-3">
                The difference is pro-rated to the next invoice. Going down keeps everything;
                uploads stop above the new limits.
              </p>
            </div>
          ) : sec === "api" ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input placeholder="Mastering handoff" autoFocus />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Kind
                <Select defaultValue="confidential">
                  <option value="confidential">Confidential (server-side, gets a secret)</option>
                  <option value="public">Public (desktop or mobile, PKCE only)</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Redirect addresses
                <Textarea placeholder="https://app.example/oauth/callback" className="h-20" />
                <span className="text-[12px] text-ink-3">
                  One per line, matched exactly: https, http on this computer only, or the
                  application's own scheme.
                </span>
              </label>
              {/* Chosen as a token's scopes are (#447), rather than typed: no scope misspelt. */}
              <fieldset className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                <legend className="mb-1.5">Scopes it may ask for</legend>
                {[
                  ["files:read", "List and read files and versions"],
                  ["files:write", "Upload versions and variations"],
                  ["reviews:read", "Read reviews and their decisions"],
                  ["reviews:write", "Request reviews and record decisions"],
                  ["comments", "Read and write comments"],
                  ["downloads", "Download originals (watermarked, logged)"],
                  ["workflows", "Read and change workflows"],
                  ["org:read", "Members, roles and settings, read-only"],
                ].map(([k, v]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={clientScopes.includes(k ?? "")}
                      onChange={(e) =>
                        setClientScopes(
                          e.target.checked
                            ? [...clientScopes, k ?? ""]
                            : clientScopes.filter((x) => x !== k),
                        )
                      }
                    />
                    <span className="tabular w-28 text-ink">{k}</span>
                    <span className="text-ink-3">{v}</span>
                  </label>
                ))}
              </fieldset>
            </div>
          ) : sec === "notifications" ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Kind
                <Select value={channelKind} onChange={(e) => setChannelKind(e.target.value)}>
                  {providers.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </label>
              {channelAddress[channelKind] ? (
                <>
                  {/* A chat channel or a webhook: a name, its address, and the events it hears of. */}
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Name
                    <Input placeholder={channelKind === "Webhook" ? "Release desk" : "#masters"} />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Address
                    <Input type="url" placeholder={channelAddress[channelKind]} />
                    <span className="text-[12px] text-ink-3">
                      {channelKind === "Webhook"
                        ? "Each event arrives as JSON, signed; the signing secret is shown once, when the webhook is made."
                        : "Kept sealed: settings show only its host."}
                    </span>
                  </label>
                </>
              ) : (
                <>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    API key
                    <Input type="password" placeholder="re_…" />
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    From
                    <Input defaultValue="Hekate <hekate@endlesshall.example>" />
                  </label>
                  <Button variant="secondary" size="md" className="self-start">
                    Send a test
                  </Button>
                </>
              )}
            </div>
          ) : sec === "storage" ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Kind
                <Select defaultValue="s3">
                  <option value="local">Local disk</option>
                  <option value="s3">S3-compatible</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Endpoint
                <Input defaultValue="https://fsn1.your-objectstorage.com" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Bucket
                <Input defaultValue="hekate-endless-hall" />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Access key
                  <Input />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Secret
                  <Input type="password" />
                </label>
              </div>
              <Button variant="secondary" size="md" className="self-start">
                Test: write, read, delete a probe object
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 @md/app:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input defaultValue="Vinyl" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Loudness
                <span className="flex items-center gap-2">
                  <Input defaultValue="−14" className="w-20" />
                  <span className="text-ink-3">±</span>
                  <Input defaultValue="1" className="w-14" />
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                True peak
                <Input defaultValue="−1.0" className="w-24" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Layout
                <Select defaultValue="stereo">
                  <option value="stereo">Stereo</option>
                  <option value="surround">5.1</option>
                  <option value="atmos">Atmos</option>
                  <option value="any">Any</option>
                </Select>
              </label>
              <fieldset className="grid gap-4 @md/app:col-span-2 @md/app:grid-cols-3">
                <legend className="mb-3 text-[13px] text-ink">
                  Picture <span className="text-ink-3">for videos; any is not checked</span>
                </legend>
                {[
                  ["Codec", ["Any codec", "ProRes", "DNxHD or DNxHR", "H.264", "HEVC (H.265)"]],
                  ["Size", ["Any size", "1280 × 720", "1920 × 1080", "3840 × 2160"]],
                  ["Frame rate", ["Any rate", "23.976 fps", "24 fps", "25 fps", "29.97 fps"]],
                  ["Scan", ["Either", "Progressive", "Interlaced"]],
                  ["Colour", ["Any primaries", "Rec. 709", "Rec. 2020"]],
                  ["Range", ["Either", "Limited (video)", "Full"]],
                ].map(([name, options]) => (
                  <label
                    key={String(name)}
                    className="flex flex-col gap-1.5 text-[13px] text-ink-2"
                  >
                    {name}
                    <Select>
                      {(options as string[]).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </Select>
                  </label>
                ))}
              </fieldset>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2 @md/app:col-span-2">
                Notes
                <Textarea rows={2} />
              </label>
            </div>
          )}
        </Dialog>
      )}
      <Label className="hidden">end</Label>
    </SettingsLayout>
  );
}

/** The prototype's "now", for how far back the log's time filter reaches. */
const LOG_NOW = Date.parse("2026-10-14T21:00:00Z");
const logActions = [
  ["stream", "Streams"],
  ["page", "Page renders"],
  ["download", "Downloads"],
  ["review", "Decisions"],
  ["guest", "Guest sign-ins"],
  ["audit", "Exports"],
] as const;
const logSince = [
  ["day", "Past day", 1],
  ["week", "Past week", 7],
  ["month", "Past month", 30],
] as const;
type LogFilters = {
  action?: string;
  projectId?: string;
  fileId?: string;
  reviewId?: string;
  personId?: string;
  since?: string;
};
type LogKey = keyof LogFilters;
const logKeys: LogKey[] = ["action", "projectId", "fileId", "reviewId", "personId", "since"];
const logIcons = {
  action: "list",
  projectId: "folder",
  fileId: "file",
  reviewId: "review",
  personId: "user",
  since: "clock",
} as const;
const projectOf = (e: AccessEvent) =>
  (e.fileId && fileById(e.fileId)?.projectId) ||
  (e.reviewId && reviewById(e.reviewId)?.projectId) ||
  undefined;

/**
 * The access log (#30): every key issue, stream, page render, download, guest sign-in, decision
 * and export, narrowed by project, file, review, person, action and time. The Filter control
 * holds the choices that can be listed; a file or a review is chosen from an entry's menu. The
 * filters in force are chips above the entries, each removable, as on the files page.
 */
function AccessLogSection({ empty }: { empty: boolean }) {
  const [filters, setFilters] = useState<LogFilters>({});
  const [open, setOpen, box] = usePopover();
  const without = (key: LogKey) => {
    const { [key]: _gone, ...rest } = filters;
    return rest;
  };
  const set = (key: LogKey, value: string) =>
    setFilters(value ? { ...filters, [key]: value } : without(key));
  const days = logSince.find(([id]) => id === filters.since)?.[2];
  const log = accessLog.filter(
    (e) =>
      (!filters.action || e.action.includes(filters.action)) &&
      (!filters.projectId || projectOf(e) === filters.projectId) &&
      (!filters.fileId || e.fileId === filters.fileId) &&
      (!filters.reviewId || e.reviewId === filters.reviewId) &&
      (!filters.personId || e.personId === filters.personId) &&
      (!days || Date.parse(e.at) >= LOG_NOW - days * 86_400_000),
  );
  const active = logKeys.filter((key) => filters[key]);
  const chipLabel = (key: LogKey) => {
    const value = filters[key] ?? "";
    if (key === "action") return logActions.find(([id]) => id === value)?.[1] ?? value;
    if (key === "projectId") return projects.find((p) => p.id === value)?.name ?? "A project";
    if (key === "fileId") return fileById(value)?.name ?? "A file";
    if (key === "reviewId") return reviewById(value)?.title ?? "A review";
    if (key === "personId") return personById(value).name;
    return logSince.find(([id]) => id === value)?.[1] ?? value;
  };
  const entryActions = (e: AccessEvent): MenuAction[] => [
    ...(e.personId
      ? [
          {
            label: e.guest ? "Only this guest" : "Only this person",
            onSelect: () => set("personId", e.personId ?? ""),
          },
        ]
      : []),
    ...(e.fileId
      ? [{ label: "Only this file", onSelect: () => set("fileId", e.fileId ?? "") }]
      : []),
    ...(e.reviewId
      ? [{ label: "Only this review", onSelect: () => set("reviewId", e.reviewId ?? "") }]
      : []),
    ...(projectOf(e)
      ? [{ label: "Only this project", onSelect: () => set("projectId", projectOf(e) ?? "") }]
      : []),
  ];
  return (
    <Section
      title="Access log"
      intro="Every key issue, stream, page render, download, guest sign-in, decision and export."
      action={
        <span className="flex gap-1">
          <div ref={box} className="relative">
            <Button
              variant="ghost"
              size="md"
              aria-expanded={open}
              aria-haspopup="dialog"
              onClick={() => setOpen(!open)}
              className={active.length ? "text-ink" : "text-ink-3"}
            >
              <Icon name="filter" size={14} />
              Filter
              {active.length > 0 && (
                <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
                  {active.length}
                </span>
              )}
            </Button>
            {open && (
              <Floating
                anchor={box}
                align="end"
                side="bottom"
                onClose={() => setOpen(false)}
                role="dialog"
                aria-label="Filter entries"
                className="rise-in flex w-72 flex-col gap-3 rounded-panel-lg bg-overlay p-3 shadow-4"
              >
                {(
                  [
                    [
                      "action",
                      "Action",
                      "Every action",
                      logActions.map(([id, label]) => [id, label]),
                    ],
                    ["projectId", "Project", "Any project", projects.map((p) => [p.id, p.name])],
                    ["personId", "Person", "Anyone", people.map((p) => [p.id, p.name])],
                    ["since", "When", "Any time", logSince.map(([id, label]) => [id, label])],
                  ] as const
                ).map(([key, label, any, choices]) => (
                  <label key={key} className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    {label}
                    <Select value={filters[key] ?? ""} onChange={(e) => set(key, e.target.value)}>
                      <option value="">{any}</option>
                      {choices.map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </Select>
                  </label>
                ))}
                <p className="m-0 text-[12px] text-ink-3">
                  For one file or review, choose it from an entry's menu.
                </p>
                {active.length > 0 && (
                  <div className="border-t border-line pt-2">
                    <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
                      Clear filters
                    </Button>
                  </div>
                )}
              </Floating>
            )}
          </div>
          <Button variant="secondary" size="md">
            Export CSV
          </Button>
        </span>
      }
    >
      {active.length > 0 && (
        <ul
          aria-label="Filters"
          className="m-0 flex list-none flex-wrap items-center gap-1.5 border-b border-line px-4 py-2"
        >
          {active.map((key) => (
            <li
              key={key}
              className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised/40 pr-1 pl-2.5 text-[12px] text-ink-2"
            >
              <Icon name={logIcons[key]} size={12} className="text-ink-3" />
              <span className="max-w-56 truncate">{chipLabel(key)}</span>
              <button
                type="button"
                aria-label={`Remove the filter ${chipLabel(key)}`}
                onClick={() => setFilters(without(key))}
                className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink"
              >
                <Icon name="close" size={11} />
              </button>
            </li>
          ))}
          <li>
            <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
              Clear
            </Button>
          </li>
        </ul>
      )}
      {empty || log.length === 0 ? (
        <div className="p-6">
          {active.length > 0 && !empty ? (
            <Empty
              title="No entries match"
              text="Nothing logged matches these filters. Remove one to see more."
            />
          ) : (
            <Empty
              title="Nothing logged"
              text="Entries appear as people open, play, render and download."
            />
          )}
        </div>
      ) : (
        log.map((e) => (
          <div
            key={e.id}
            className="group grid grid-cols-[120px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-[13px] @3xl/app:grid-cols-[130px_150px_minmax(0,1fr)_150px_110px_auto]"
          >
            <span className="tabular text-ink-3">{formatDateTime(e.at)}</span>
            <span className="flex items-center gap-2 truncate text-ink">
              <span className="rounded-chip bg-raised px-1.5 text-[12px] text-ink-2">
                {e.action}
              </span>
            </span>
            <span className="hidden truncate text-ink-2 @3xl/app:block">
              {e.personId ? personById(e.personId).name : "Someone"}
              {e.guest ? " (guest)" : ""}
              {e.fileId ? ` · ${fileById(e.fileId)?.name}` : ""}
              {e.reviewId ? ` · ${reviewById(e.reviewId)?.title}` : ""}
            </span>
            <span className="tabular hidden truncate text-ink-3 @3xl/app:block">{e.address}</span>
            <span className="hidden truncate text-ink-3 @3xl/app:block">{e.agent}</span>
            <ActionMenu label={`the entry at ${formatDateTime(e.at)}`} actions={entryActions(e)} />
          </div>
        ))
      )}
    </Section>
  );
}
