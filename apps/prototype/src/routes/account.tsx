import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Danger, Row, Section, SettingsLayout, SwitchRow } from "~/components/settings";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { personById } from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";
import { useScreenState } from "~/viewer/state-gate";

const sections = [
  { id: "account", label: "Account" },
  { id: "security", label: "Passkeys and sessions" },
  { id: "tokens", label: "API tokens" },
  { id: "apps", label: "Connected apps" },
  { id: "notifications", label: "Notifications" },
  { id: "appearance", label: "Appearance" },
];

const tokens = [
  {
    name: "Release pipeline",
    scopes: "files:read, reviews:read",
    made: "2 Oct",
    used: "2 h ago",
    expires: "2 Jan 2027",
  },
  {
    name: "Logic Pro export",
    scopes: "files:write",
    made: "14 Sep",
    used: "yesterday",
    expires: "Never",
  },
  {
    name: "Old laptop",
    scopes: "everything",
    made: "3 Jun",
    used: "41 days ago",
    expires: "Expired 1 Oct",
  },
];

const connected = [
  {
    name: "Hekate for Slack",
    by: "Hekate (official)",
    scopes: "Read reviews, post on your behalf",
    since: "19 Aug",
    last: "2 h ago",
  },
  {
    name: "Hekate for Logic Pro",
    by: "Hekate (official)",
    scopes: "Upload versions, read comments",
    since: "14 Sep",
    last: "yesterday",
  },
  {
    name: "Lantern Deliveries",
    by: "Lantern Pictures",
    scopes: "Read files, download originals",
    since: "4 Oct",
    last: "3 d ago",
  },
];

export const themes = [
  { id: "signal-dark", name: "Signal, dark", colours: ["#0a0a0b", "#f0762e", "#f4f4f5"] },
  { id: "signal-light", name: "Signal, light", colours: ["#f4f4f2", "#d9601a", "#111113"] },
  { id: "catppuccin", name: "Catppuccin", colours: ["#1e1e2e", "#f5c2e7", "#cdd6f4"] },
  { id: "dracula", name: "Dracula", colours: ["#282a36", "#bd93f9", "#f8f8f2"] },
  { id: "gruvbox", name: "Gruvbox", colours: ["#282828", "#fe8019", "#ebdbb2"] },
  { id: "rose-pine", name: "Rosé Pine", colours: ["#191724", "#ebbcba", "#e0def4"] },
  { id: "osaka-jade", name: "Osaka Jade", colours: ["#111c18", "#5fb39b", "#d6e8e0"] },
  { id: "kanagawa", name: "Kanagawa", colours: ["#1f1f28", "#7e9cd8", "#dcd7ba"] },
  { id: "solarized", name: "Solarized", colours: ["#002b36", "#b58900", "#93a1a1"] },
];

export function AccountPage({ section }: { section: string }) {
  const viewer = useViewer();
  const state = useScreenState();
  const [tokenOpen, setTokenOpen] = useState(false);
  const person = personById(viewer.personId);
  const [adding, setAdding] = useState(false);
  const [theme, setTheme] = useState("signal-dark");
  const [digest, setDigest] = useState<"instant" | "digest">("instant");
  usePageHeader({ title: "Account", heading: "page" });
  const sec = sections.some((s) => s.id === section) ? section : "account";
  const keys = [
    { name: "MacBook Touch ID", kind: "Passkey", used: "today" },
    { name: "YubiKey 5C", kind: "Hardware security key", used: "3 Oct" },
    { name: "iPhone", kind: "Passkey", used: "yesterday" },
  ];
  return (
    <SettingsLayout
      title={person.name}
      intro="Who you are to Hekate, how you sign in, what reaches you, and how it looks."
      sections={sections}
      current={sec}
      base="/account/$section"
      param="section"
    >
      {sec === "account" && (
        <>
          <Section title="You">
            <Row name="Picture">
              <Avatar personId={viewer.personId} size={40} />
              <Button variant="ghost" size="md">
                Change
              </Button>
            </Row>
            <Row name="Name">
              <Input defaultValue={person.name} className="w-64" />
            </Row>
            <Row name="Email" hint="Sign-in mail and notifications go here.">
              <Input defaultValue={person.email} className="w-72" />
            </Row>
            <Row
              name="Workspaces"
              hint="Endless Hall Records (owner), North Choir Collective (member)"
            />
          </Section>
          <Section title="Password">
            <Row name="Change password" hint="12 characters or more. Passkeys keep working.">
              <Button variant="secondary" size="md">
                Change…
              </Button>
            </Row>
          </Section>
          <Danger>
            <Row
              name="Delete your account"
              hint="Your comments and decisions stay, attributed to a former member."
            >
              <Button variant="secondary" size="md" className="text-signal">
                Delete…
              </Button>
            </Row>
          </Danger>
        </>
      )}
      {sec === "security" && (
        <>
          <Section
            title="Second factor"
            intro="A code from an app on your phone, asked for after your password."
          >
            <Row
              name="Code app"
              hint="On. Asked for at each sign-in, except in browsers you trust."
            >
              <Button variant="ghost" size="md">
                Remove…
              </Button>
            </Row>
          </Section>
          <Section
            title="Passkeys and hardware security keys"
            intro="Up to five. A passkey signs you in without a password; a hardware security key, such as a YubiKey, can be required by the workspace."
            action={
              <Button
                variant="secondary"
                size="md"
                onClick={() => setAdding(true)}
                disabled={state === "failed"}
              >
                <Icon name="plus" size={14} />
                Add
              </Button>
            }
          >
            {keys.map((k) => (
              <Row
                key={k.name}
                name={
                  <span className="flex items-center gap-2">
                    <Icon name="key" size={14} className="text-ink-3" />
                    {k.name}
                  </span>
                }
                hint={`${k.kind} · last used ${k.used}`}
              >
                <ActionMenu
                  always
                  label={k.name}
                  actions={[
                    { label: "Rename", onSelect: () => {} },
                    "divider",
                    { label: "Revoke", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
            {state === "failed" && (
              <Row
                name="Limit reached"
                hint="Five keys are registered; revoke one to add another."
              />
            )}
            {state === "processing" && (
              <Row
                name={
                  <span className="flex items-center gap-2 text-ink">
                    <Dot state="approved" />
                    Added: Work laptop
                  </span>
                }
                hint="Just now"
              />
            )}
          </Section>
          <Section
            title="Recovery codes"
            intro="Ten single-use codes for when your phone or a key is lost. Keep them somewhere else."
          >
            <Row name="8 of 10 unused" hint="Shown once, when made. New ones replace these.">
              <Button variant="secondary" size="md">
                Generate new ones…
              </Button>
            </Row>
          </Section>
          <Section title="Sessions">
            {[
              ["This browser", "Chrome 142, macOS · 10.0.0.2 · now", true],
              ["iPad", "Safari 26 · 81.2.69.142 · yesterday", false],
              ["Studio machine", "Firefox 146, Linux · 10.0.0.31 · 3 Oct", false],
            ].map(([name, hint, current]) => (
              <Row key={String(name)} name={String(name)} hint={String(hint)}>
                {current ? (
                  <Dot state="approved" />
                ) : (
                  <Button variant="ghost" size="md">
                    Sign out
                  </Button>
                )}
              </Row>
            ))}
            <Row name="Everywhere else" hint="Signs out every other session.">
              <Button variant="secondary" size="md">
                Sign out all
              </Button>
            </Row>
          </Section>
          {adding && (
            <Dialog
              title="Add a passkey or hardware security key"
              description="Your browser asks you to touch the key (a YubiKey, or any FIDO2 key), or to unlock this device."
              onClose={() => setAdding(false)}
              width="sm"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setAdding(false)}>
                    Continue
                  </Button>
                </>
              }
            >
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Name
                <Input defaultValue="Work laptop" />
              </label>
            </Dialog>
          )}
        </>
      )}
      {sec === "tokens" && (
        <>
          <Section
            title="API tokens"
            intro="For scripts and tools of your own, against the public API. A token can do no more than you can, and only what its scopes allow; it is shown once."
            action={
              <Button variant="primary" size="md" onClick={() => setTokenOpen(true)}>
                <Icon name="plus" size={14} />
                Token
              </Button>
            }
          >
            {tokens.map((t) => (
              <Row
                key={t.name}
                name={
                  <span className="flex items-center gap-2">
                    <Dot state={t.expires.startsWith("Expired") ? "cancelled" : "approved"} />
                    {t.name}
                  </span>
                }
                hint={`${t.scopes} · made ${t.made} · last used ${t.used} · ${t.expires.startsWith("Expired") ? t.expires.toLowerCase() : `expires ${t.expires.toLowerCase()}`}`}
              >
                <ActionMenu
                  always
                  label={t.name}
                  actions={[
                    { label: "Rename", onSelect: () => {} },
                    { label: "Change scopes…", onSelect: () => {} },
                    "divider",
                    { label: "Revoke", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          <Section
            title="Using the API"
            intro="Every call is logged against the token; the workspace sees it in the API log."
          >
            <Row name="Base address">
              <span className="tabular text-[13px] text-ink-2">
                https://review.endlesshall.example/api/v1
              </span>
            </Row>
            <Row name="Reference" hint="OpenAPI 3.1, with examples for every call.">
              <Button variant="ghost" size="md">
                Open the reference
              </Button>
            </Row>
          </Section>
          {tokenOpen && (
            <Dialog
              title="New API token"
              description="Pick the least it needs. You will see the token once."
              onClose={() => setTokenOpen(false)}
              footer={
                <>
                  <Button variant="ghost" onClick={() => setTokenOpen(false)}>
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={() => setTokenOpen(false)}>
                    Create token
                  </Button>
                </>
              }
            >
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Name
                  <Input placeholder="Release pipeline" autoFocus />
                </label>
                <fieldset className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  <legend className="mb-1.5">Scopes</legend>
                  {[
                    ["files:read", "List and read files and versions"],
                    ["files:write", "Upload versions and variations"],
                    ["reviews:read", "Read reviews and their decisions"],
                    ["reviews:write", "Request reviews and record decisions as you"],
                    ["comments", "Read and write comments"],
                    ["downloads", "Download originals (watermarked, logged)"],
                  ].map(([k, v]) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="checkbox" defaultChecked={k === "files:read"} />
                      <span className="tabular w-28 text-ink">{k}</span>
                      <span className="text-ink-3">{v}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="grid gap-3 @md/app:grid-cols-2">
                  <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Expires
                    <Select defaultValue="90">
                      <option value="30">In 30 days</option>
                      <option value="90">In 90 days</option>
                      <option value="365">In a year</option>
                      <option value="never">Never</option>
                    </Select>
                  </label>
                  {/* A token reaches the workspace it was made in alone (#198): switch workspace
                      to make one for another. */}
                  <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                    Workspace
                    <span className="flex h-8 items-center text-[14px] text-ink">
                      Endless Hall Records
                    </span>
                    <span className="text-[12px] text-ink-3">
                      Switch workspace to make one for another.
                    </span>
                  </div>
                </div>
              </div>
            </Dialog>
          )}
        </>
      )}
      {sec === "apps" && (
        <>
          <Section
            title="Connected apps"
            intro="Applications you have let in through OAuth. Each sees only what you granted, and only what you can see."
          >
            {connected.map((a) => (
              <Row
                key={a.name}
                name={
                  <span className="flex items-center gap-2">
                    {a.name}
                    {a.by.includes("official") && (
                      <span className="rounded-chip border border-line px-1.5 text-[11px] text-ink-3">
                        official
                      </span>
                    )}
                  </span>
                }
                hint={`${a.by} · ${a.scopes} · connected ${a.since} · last used ${a.last}`}
              >
                <ActionMenu
                  always
                  label={a.name}
                  actions={[
                    { label: "What it may do…", onSelect: () => {} },
                    "divider",
                    { label: "Disconnect", danger: true, onSelect: () => {} },
                  ]}
                />
              </Row>
            ))}
          </Section>
          <Section
            title="For developers"
            intro="An application that connects to Hekate on people's behalf is registered by a workspace, under its settings."
          >
            <Row
              name="Register an application"
              hint="Client id and secret, redirect addresses, scopes; in Workspace settings under API and OAuth clients."
            />
          </Section>
        </>
      )}
      {sec === "notifications" && (
        <>
          <Section title="How" intro="At once, or gathered into a digest.">
            <Row name="By mail">
              <div
                role="radiogroup"
                className="flex rounded-control border border-line bg-ground/60 p-0.5"
              >
                {(["instant", "digest"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={digest === m}
                    onClick={() => setDigest(m)}
                    className={cn(
                      "h-7 rounded-[4px] px-3 text-[13px]",
                      digest === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    {m === "instant" ? "At once" : "Digest"}
                  </button>
                ))}
              </div>
              {digest === "digest" && (
                <Select defaultValue="daily" className="w-36">
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily, 08:00</option>
                </Select>
              )}
            </Row>
            <SwitchRow name="In the app" checked />
          </Section>
          <Section
            title="What"
            intro="Per event. Mentions and reviews asked of you always reach you."
          >
            {[
              ["A review is requested of you", true, true],
              ["A decision is recorded on a review you asked for", true, true],
              ["Someone replies to you", true, true],
              ["Someone mentions you", true, true],
              ["A new version of a track you follow", true, false],
              ["A stage starts in a project you are in", false, false],
              ["Processing fails on your upload", true, true],
              ["A guest opens a review you asked for", false, false],
            ].map(([e, app, mail]) => (
              <Row key={String(e)} name={String(e)}>
                <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <input type="checkbox" defaultChecked={Boolean(app)} />
                  app
                </label>
                <label className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <input type="checkbox" defaultChecked={Boolean(mail)} />
                  mail
                </label>
              </Row>
            ))}
          </Section>
          <Section title="Following" intro="Tracks and reviews you get told about beyond your own.">
            <Row name="Maple Leaf Rag" hint="Joplin Rags">
              <Button variant="ghost" size="md">
                Unfollow
              </Button>
            </Row>
            <Row name="Album masters" hint="Joplin Rags">
              <Button variant="ghost" size="md">
                Unfollow
              </Button>
            </Row>
          </Section>
        </>
      )}
      {sec === "appearance" && (
        <>
          <Section
            title="Theme"
            intro="The brand in dark and light, and a few others people know. Yours alone."
          >
            <Row name="Theme" stacked>
              <div className="grid w-full grid-cols-2 gap-2 @3xl/app:grid-cols-3">
                {themes.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={theme === t.id}
                    onClick={() => setTheme(t.id)}
                    className={cn(
                      "flex items-center gap-3 rounded-panel border p-2.5 text-left transition-colors",
                      theme === t.id
                        ? "border-signal/60 bg-signal/[0.06]"
                        : "border-line hover:border-edge",
                    )}
                  >
                    <span
                      className="flex h-9 w-14 shrink-0 overflow-hidden rounded-[5px] shadow-1"
                      style={{ background: t.colours[0] }}
                    >
                      <span className="m-auto flex gap-1">
                        <span
                          className="size-2.5 rounded-full"
                          style={{ background: t.colours[1] }}
                        />
                        <span
                          className="size-2.5 rounded-full"
                          style={{ background: t.colours[2] }}
                        />
                      </span>
                    </span>
                    <span className="text-[13px] text-ink">{t.name}</span>
                  </button>
                ))}
              </div>
            </Row>
            <Row
              name="Follow the system"
              hint="Dark at night, light by day, when the theme has both."
            >
              <Select defaultValue="no" className="w-40">
                <option value="no">Always dark</option>
                <option value="yes">Follow the system</option>
              </Select>
            </Row>
            <Row name="Density" hint="How much room each row of a list takes, everywhere.">
              <Select
                defaultValue={
                  document.getElementById("root")?.dataset.density === "compact"
                    ? "compact"
                    : "comfortable"
                }
                className="w-40"
                onChange={(e) => {
                  // The prototype renders in a shadow root; its host carries the density.
                  const host = document.getElementById("root");
                  if (e.target.value === "compact") host?.setAttribute("data-density", "compact");
                  else host?.removeAttribute("data-density");
                }}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </Select>
            </Row>
          </Section>
          <Section
            title="Tools shown"
            intro="Of the tools your roles give you, which appear on the recording page. The project decides what you may have; this is what you want to see."
          >
            <SwitchRow name="Spectrogram view" checked />
            <SwitchRow name="Split channels by default" checked={false} />
            <SwitchRow name="Loudness monitoring under the transport" checked />
            <SwitchRow name="Metadata editor in QA" checked={false} />
            <SwitchRow name="Keyboard map on ?" checked />
          </Section>
          <Section title="Player">
            <Row name="Skip by">
              <Select defaultValue="5" className="w-32">
                <option value="1">1 s</option>
                <option value="5">5 s</option>
                <option value="10">10 s</option>
              </Select>
            </Row>
            <Row name="Pre-roll before a comment">
              <Select defaultValue="1" className="w-32">
                <option value="0">None</option>
                <option value="1">1 s</option>
                <option value="2">2 s</option>
              </Select>
            </Row>
          </Section>
        </>
      )}
    </SettingsLayout>
  );
}
