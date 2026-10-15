import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Danger, Matrix, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import {
  accessLog,
  categories,
  deliveryProfiles,
  fileById,
  organisation,
  personById,
  projects,
  reviewById,
  type Tool,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatDateTime } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";
import { BrandSection, ComponentsSection } from "./design-system.tsx";
import { MembersSection } from "./members.tsx";
import { EmailSection } from "./org-email.tsx";
import { toolCopy } from "./project-settings.tsx";

const intros: Record<string, string> = {
  general: "The organisation's name, how guests sign in, and what every project starts from.",
  defaults: "What a new project copies unless it says otherwise.",
  categories: "The categories a comment can carry, and their colours.",
  delivery: "The numbers the checks measure against, shared by every project that picks a profile.",
  brand:
    "The mark, the colours, the type, and every reusable component with the rule for using it.",
  email: "What every message from Hekate looks like, and the words the organisation sends.",
  members: "Who has an account here, who is invited, and which guests hold a link.",
  security: "Who may sign in and how.",
  notifications: "Where events go: mail, Slack, Discord, webhooks.",
  api: "Applications that connect on people's behalf, and tokens that act for the organisation itself.",
  billing: "The plan, what it includes, what it costs, and every invoice.",
  support: "Ask the people who run this instance, with the error reference if there is one.",
  storage: "Where files live and how much they take.",
  leaks: "Find which recipient a leaked file was watermarked for.",
  log: "Every key issue, page render and download.",
  operations: "What the instance is doing for this organisation.",
};

const sections = [
  { id: "general", label: "General", group: "Organisation" },
  { id: "defaults", label: "Defaults", group: "Organisation" },
  { id: "categories", label: "Comment categories", group: "Organisation" },
  { id: "delivery", label: "Delivery profiles", group: "Organisation" },
  { id: "brand", label: "Brand and design system", group: "Organisation" },
  { id: "email", label: "Email templates", group: "Organisation" },
  { id: "members", label: "Members", group: "Access" },
  { id: "security", label: "Security", group: "Access" },
  { id: "notifications", label: "Notifications and integrations", group: "Access" },
  { id: "api", label: "API and OAuth clients", group: "Access" },
  { id: "billing", label: "Billing", group: "Plan and help" },
  { id: "support", label: "Support", group: "Plan and help" },
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
  "Webhook",
];

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

export function SettingsPage({ section }: { section: string }) {
  const viewer = useViewer();
  const state = useScreenState();
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  const [adding, setAdding] = useState(false);
  const [leak, setLeak] = useState<"idle" | "scanning" | "match" | "none">("idle");
  const [logFilter, setLogFilter] = useState("");
  usePageHeader({ title: "Organisation settings" });
  if (!elevated)
    return (
      <Refused title="Not for your role" text="Organisation settings are for owners and admins." />
    );
  const sec = sections.some((s) => s.id === section) ? section : "general";
  const log = accessLog.filter((e) => !logFilter || e.action.includes(logFilter));
  return (
    <SettingsLayout
      title={sections.find((x) => x.id === sec)?.label ?? organisation.name}
      intro={intros[sec]}
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
            intro="Studio: 1 TB, 25 members, forensic marking, priority support. Change it any time; the difference is pro-rated."
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
              hint="The organisation drops to Solo at the end of the period; nothing is deleted, but uploads stop above the limits."
            >
              <Button variant="ghost" size="md">
                Cancel…
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "support" && (
        <>
          <Section
            title="Ask for help"
            intro="The people who run this instance answer here. Attach the error reference from the message you saw, and they can see the whole story."
          >
            <div className="flex flex-col gap-3 px-4 py-3">
              <div className="grid gap-3 @md/app:grid-cols-[minmax(0,1fr)_200px]">
                <Input placeholder="What is wrong, in a line" />
                <Input placeholder="Error reference (HK-…)" className="tabular" />
              </div>
              <Textarea
                placeholder="What you did, what you expected, what happened. Links to the file or review help."
                className="h-28"
              />
              <div className="flex items-center gap-2">
                <Select defaultValue="problem" className="w-52">
                  <option value="problem">Something is broken</option>
                  <option value="question">A question</option>
                  <option value="billing">Billing</option>
                  <option value="idea">An idea</option>
                </Select>
                <label className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  <input type="checkbox" defaultChecked /> Let them open the file or review in
                  question
                </label>
                <Button variant="primary" size="md" className="ml-auto">
                  Send
                </Button>
              </div>
            </div>
          </Section>
          <Section title="Your tickets">
            {[
              [
                "T-216",
                "Score page 7 will not render",
                "answered: fixed by patch 0.2.1, applied tonight · 1 d",
                "working",
              ],
              ["T-203", "Can we have a second delivery profile?", "resolved · 9 d", "approved"],
            ].map(([id, title, hint, dot]) => (
              <Row
                key={id}
                name={
                  <span className="flex items-center gap-2">
                    <Dot state={dot as DotState} />
                    <span className="tabular text-[12px] text-ink-3">{id}</span>
                    {title}
                  </span>
                }
                hint={hint}
              >
                <Button variant="ghost" size="md">
                  Open
                </Button>
              </Row>
            ))}
          </Section>
          <Section title="Before you ask">
            <Row name="The guide" hint="Reviews, workflows, QA, the player: how each part works.">
              <Button variant="ghost" size="md">
                Open
              </Button>
            </Row>
            <Row name="Status" hint="status.review.endlesshall.example · no incidents in 41 days">
              <Dot state="approved" />
            </Row>
            <Row
              name="Your operator"
              hint="Endless Hall Records runs this instance itself; the operators are Alex Rivera and Ops on call."
            >
              <span className="text-[13px] text-ink-2">ops@endlesshall.example</span>
            </Row>
          </Section>
        </>
      )}
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
                    { label: "Edit", onSelect: () => {} },
                    { label: "Rotate the secret", onSelect: () => {} },
                    { label: "Who has connected", onSelect: () => {} },
                    "divider",
                    { label: "Delete", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          <Section
            title="Service tokens"
            intro="Tokens that act as the organisation rather than a person, for the release pipeline and the like. Scoped and logged like any other."
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
                    { label: "Change scopes…", onSelect: () => {} },
                    "divider",
                    { label: "Revoke", danger: true, onSelect: () => {} },
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
        </>
      )}
      {sec === "email" && <EmailSection />}
      {sec === "brand" && (
        <>
          <BrandSection />
          <ComponentsSection />
        </>
      )}
      {sec === "general" && (
        <>
          <Section title="Organisation">
            <Row name="Name">
              <Input defaultValue={organisation.name} className="w-64" />
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
            <Row name="Language and dates">
              <Select defaultValue="en-GB" className="w-56">
                <option value="en-GB">British English, 14 Oct 2026</option>
                <option value="en-US">American English</option>
                <option value="de">Deutsch</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Organisations you are in"
            intro="Switch from the menu at the top of the sidebar."
          >
            <Row name={organisation.name} hint="Owner">
              <Dot state="approved" />
            </Row>
            <Row name="North Choir Collective" hint="Member" />
          </Section>
          <Danger>
            <Row
              name="Delete this organisation"
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
          {categories.map((c, i) => (
            <Row
              key={c.id}
              name={
                <span className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ background: `oklch(0.7 0.12 ${(i * 70) % 360})` }}
                  />
                  {c.name}
                </span>
              }
              hint={
                c.handling === "deferred"
                  ? `Deferred to a stage named ${c.stage}`
                  : c.handling === "information"
                    ? "Information only"
                    : "Handled on this version"
              }
            >
              <ActionMenu
                always
                label={c.name}
                actions={[
                  { label: "Rename", onSelect: () => {} },
                  { label: "Change colour", onSelect: () => {} },
                  "divider",
                  { label: "Delete", danger: true, onSelect: () => {} },
                ]}
              />
            </Row>
          ))}
        </Section>
      )}
      {sec === "delivery" && (
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
            <SwitchRow
              name="Second factor required"
              hint="A passkey, a security key or a code app; recovery codes are issued."
              checked
            />
            <SwitchRow name="Security key required for owners and admins" checked={false} />
            <Row name="Sessions end after">
              <Select defaultValue="30" className="w-40">
                <option value="1">1 day</option>
                <option value="7">7 days</option>
                <option value="30">30 days</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Single sign-on"
            intro="OIDC or SAML. Enforcing it turns passwords off for members; one break-glass owner keeps a password."
          >
            <Row name="Provider">
              <Select defaultValue="oidc" className="w-40">
                <option value="oidc">OIDC</option>
                <option value="saml">SAML</option>
              </Select>
            </Row>
            <Row name="Issuer">
              <Input
                defaultValue="https://login.endlesshall.example/realms/hekate"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <Row name="Client">
              <Input defaultValue="hekate" className="w-64" />
              <Input
                type="password"
                defaultValue="••••••••••••"
                className="w-40"
                aria-label="Client secret"
              />
            </Row>
            <Row
              name="Attributes"
              hint="Email, name, and the group claim that becomes an organisation role."
            >
              <Input defaultValue="email · name · groups" className="w-64" />
            </Row>
            <Row name="Group to role" stacked>
              <div className="flex w-full flex-col gap-1.5">
                {[
                  ["hekate-owners", "Owner"],
                  ["hekate-admins", "Admin"],
                  ["*", "Member"],
                ].map(([g, r]) => (
                  <span key={g} className="flex items-center gap-2">
                    <Input defaultValue={g} className="w-56" />
                    <span className="text-ink-3">→</span>
                    <Select defaultValue={r} className="w-40">
                      <option>Owner</option>
                      <option>Admin</option>
                      <option>Member</option>
                    </Select>
                  </span>
                ))}
              </div>
            </Row>
            <Row name="Test">
              <Test state={state === "failed" ? "failed" : "idle"} />
            </Row>
            <SwitchRow
              name="Enforce single sign-on"
              hint="Break-glass: alex@endlesshall.example keeps a password."
              checked={false}
            />
          </Section>
          <Section title="Directory (LDAP)">
            <Row name="Server">
              <Input
                defaultValue="ldaps://directory.endlesshall.example:636"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <SwitchRow name="Verify the certificate" checked />
            <Row name="Bind">
              <Input defaultValue="cn=hekate,ou=services,dc=endlesshall" className="w-64" />
              <Input
                type="password"
                defaultValue="••••••••"
                className="w-32"
                aria-label="Bind password"
              />
            </Row>
            <Row name="Search">
              <Input
                defaultValue="ou=people,dc=endlesshall · (uid={username})"
                className="w-full @3xl/app:w-96"
              />
            </Row>
            <Row name="Test">
              <Test state={state === "refused" ? "failed" : "idle"} />
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
                hint="In development no mail is sent; everything is written to the log."
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
            <Row name="API keys" hint="Scoped to an organisation; shown once.">
              <Button variant="secondary" size="md">
                New key
              </Button>
            </Row>
            <Row name="hk_live_7f3a…" hint="Created 2 Oct · last used today · read and write">
              <ActionMenu
                always
                label="key"
                actions={[
                  { label: "Rotate", onSelect: () => {} },
                  { label: "Revoke", danger: true, onSelect: () => {} },
                ]}
              />
            </Row>
            <Row
              name="MCP endpoint"
              hint="https://review.endlesshall.example/mcp · tools for projects, files, reviews and comments"
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
            intro="Compares the database with what the backends hold. Report only: nothing is removed without a person."
          >
            <Row name="Last run" hint="Nightly, 03:00">
              <span className="text-[13px] text-ink-2">Today 03:00 · 2 min 14 s</span>
            </Row>
            <Row name="Orphaned objects" hint="In storage, unknown to the database">
              <span className="tabular text-[13px] text-ink-2">3 · 41 MB</span>
              <Button variant="ghost" size="md">
                Remove
              </Button>
            </Row>
            <Row
              name="Missing bytes"
              hint={
                state === "failed"
                  ? "Objects the database expects that a backend no longer holds. Restore from backup."
                  : "None"
              }
            >
              {state === "failed" ? (
                <span className="flex items-center gap-1.5 text-[13px] text-signal">
                  <Icon name="warning" size={13} />2 objects · 118 MB
                </span>
              ) : (
                <Dot state="approved" />
              )}
            </Row>
            <Row name="Run now">
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
            <SwitchRow name="Audio" checked />
            <SwitchRow name="Video" checked />
            <SwitchRow
              name="Pages"
              hint="The visible watermark is set per project; this is the hidden one."
              checked
            />
          </Section>
          <Section
            title="Trace a leak"
            intro="Upload the file that got out. It is matched against every mark issued."
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
                    <span className="text-[14px] text-ink">Drop the file here</span>
                    <span className="text-[13px] text-ink-3">
                      A clip of 20 seconds is enough; a re-encode or a phone recording usually still
                      carries the mark.
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
                      Match, 99.2% confidence
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
      {sec === "log" && (
        <Section
          title="Access log"
          intro="Every key issue, stream, page render, download, guest sign-in, decision and export."
          action={
            <span className="flex gap-1">
              <Select
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className="h-8 w-40 text-[13px]"
              >
                <option value="">Every action</option>
                <option value="stream">Streams</option>
                <option value="page">Page renders</option>
                <option value="download">Downloads</option>
                <option value="review">Decisions</option>
                <option value="guest">Guest sign-ins</option>
                <option value="audit">Exports</option>
              </Select>
              <Button variant="secondary" size="md">
                Export CSV
              </Button>
            </span>
          }
        >
          {state === "empty" || log.length === 0 ? (
            <div className="p-6">
              <Empty
                title="Nothing logged"
                text="Entries appear as people open, play, render and download."
              />
            </div>
          ) : (
            log.map((e) => (
              <div
                key={e.id}
                className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-3 px-4 py-2 text-[13px] @3xl/app:grid-cols-[130px_150px_minmax(0,1fr)_150px_110px]"
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
                <span className="tabular hidden truncate text-ink-3 @3xl/app:block">
                  {e.address}
                </span>
                <span className="hidden truncate text-ink-3 @3xl/app:block">{e.agent}</span>
              </div>
            ))
          )}
        </Section>
      )}
      {sec === "operations" && (
        <>
          <Section title="This instance">
            <Row name="Version" hint="hekate 0.2.0 · built 12 Oct 2026">
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                <Dot state="approved" />
                Connected
              </span>
            </Row>
            <Row name="Worker" hint="Runs analysis, renditions, pages and mail">
              <span
                className={cn(
                  "flex items-center gap-2 text-[13px]",
                  state === "failed" ? "text-signal" : "text-ink-2",
                )}
              >
                <Dot state={state === "failed" ? "changes_requested" : "approved"} />
                {state === "failed" ? "Off since 02:14" : "On"}
              </span>
            </Row>
            <Row name="Queue" hint="Jobs waiting · running · failed in the last day">
              <span className="tabular text-[13px] text-ink-2">
                {state === "failed" ? "38 · 0 · 12" : "2 · 1 · 0"}
              </span>
            </Row>
            <Row name="Encryption" hint="Per-file keys wrapped by the master key">
              <span className="flex items-center gap-2 text-[13px] text-ink-2">
                <Dot state={state === "processing" ? "working" : "approved"} />
                {state === "processing" ? "Key rotation 61% through" : "Rotated 2 Oct"}
              </span>
              <Button variant="ghost" size="md">
                Rotate
              </Button>
            </Row>
            <Row name="Metrics" hint="Prometheus">
              <span className="tabular text-[13px] text-ink-2">/metrics · scraped 14 s ago</span>
            </Row>
          </Section>
          <Section title="Backups and upgrades">
            <Row name="Last backup" hint="Database and the master key, nightly">
              <span className="text-[13px] text-ink-2">Today 02:00 · 1.2 GB · verified</span>
            </Row>
            <Row
              name="Upgrade"
              hint="Pull the new image, run migrations on start, keep the previous image until it is healthy."
            >
              <span className="text-[13px] text-ink-2">0.2.1 available</span>
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
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Scopes it may ask for
                <Input placeholder="files:read reviews:read comments" />
              </label>
            </div>
          ) : sec === "notifications" ? (
            <div className="flex flex-col gap-4">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Kind
                <Select defaultValue="Resend">
                  {providers.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </label>
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
