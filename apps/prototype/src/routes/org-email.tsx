import { useState } from "react";
import { Mark } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Row, Section } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { organisation } from "~/data";
import { cn } from "~/lib/cn";
import { useScreenState } from "~/viewer/state-gate";

interface Template {
  id: string;
  name: string;
  subject: string;
  heading: string;
  body: string;
  action: string;
  foot: string;
}

const templates: Template[] = [
  {
    id: "review",
    name: "Review requested",
    subject: "Album masters: your approval is asked",
    heading: "Alex asked for your approval",
    body: "Three tracks of Joplin Rags are ready. Listen, leave comments on the waveform, then record Approved or Changes requested. The request is due in 7 days.",
    action: "Open the review",
    foot: "This link is yours alone and signs you in. It lasts a fortnight once opened.",
  },
  {
    id: "invite",
    name: "Invitation",
    subject: "Join Endless Hall Records on Hekate",
    heading: "Ines invited you to Endless Hall Records",
    body: "Create your account to review and approve the workspace's recordings and cuts. The invitation is for this address and works once.",
    action: "Accept the invitation",
    foot: "If you were not expecting this, ignore it; nothing happens until you accept.",
  },
  {
    id: "decision",
    name: "Decision recorded",
    subject: "Maple Leaf Rag V2: changes requested",
    heading: "Tomas requested changes on Maple Leaf Rag V2",
    body: "“Right channel a touch hotter than the left through the trio.” Two comments are open on the version; the track is back with the engineer.",
    action: "See the comments",
    foot: "You get this because you requested the review. Change what you are told about in your account.",
  },
  {
    id: "due",
    name: "Due soon",
    subject: "Cut 3 picture lock is due tomorrow",
    heading: "Your decision on Cut 3 is due tomorrow",
    body: "Opening titles, cut 3, waits on you. One other reviewer has already approved.",
    action: "Decide now",
    foot: "A reminder, sent once, the day before the due date.",
  },
  {
    id: "upload",
    name: "Upload request",
    subject: "Please send the Atmos master for Solace",
    heading: "Alex asked you for a file",
    body: "Upload the Atmos master for Solace. The link accepts files up to 20 GB and closes in 5 days; no account is needed.",
    action: "Upload the file",
    foot: "The file is checked as it arrives and goes straight into the project.",
  },
];

/**
 * The workspace's mail, set up and explained in one place (#591): where it is sent from (the
 * instance's, or the workspace's own provider, with its bounces), then what every message looks
 * like: one message, one action, the lockup, and nothing to configure but the words.
 */
export function EmailSection() {
  const state = useScreenState();
  const [id, setId] = useState("review");
  const [view, setView] = useState<"light" | "dark" | "text">("light");
  const light = view !== "dark";
  const t = templates.find((x) => x.id === id) ?? templates[0];
  // The processing state is an instance that writes its mail to the log, and a workspace with none of its own.
  const own = state !== "processing";
  if (!t) return null;
  return (
    <>
      {!own && (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-panel border border-signal/30 bg-signal/[0.06] px-3.5 py-2.5 text-[13px] text-ink"
        >
          <Icon name="warning" size={14} className="mt-0.5 shrink-0 text-signal" />
          <span>
            This instance writes email to its log; nothing is sent. Give the workspace its own mail
            below, and members, guests and invitations are sent from it.
          </span>
        </div>
      )}
      <Section title="Sending">
        <Row
          name={
            <span className="flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
                <Icon name="mail" size={16} />
              </span>
              {own ? "Resend" : "Mail"}
            </span>
          }
          hint={
            own
              ? "smtp.resend.com:465 · from Endless Hall Records <mail@endlesshall.example> · 2 not sent to after a bounce"
              : "Through the instance's mail. Give the workspace its own, and members, guests and invitations are sent from it."
          }
        >
          <Button variant="secondary" size="md">
            {own ? "Test" : "Use the workspace's own"}
          </Button>
          {own && (
            <ActionMenu
              always
              label="Mail"
              actions={[
                { label: "Edit…", onSelect: () => {} },
                { label: "Bounced addresses…", onSelect: () => {} },
                "divider",
                { label: "Back to the instance's mail…", danger: true, onSelect: () => {} },
              ]}
            />
          )}
        </Row>
      </Section>
      <Section
        title="Templates"
        intro="Every message is the same shape: who, what, one action, and a line about why you got it. The words below are the workspace's to change."
        action={
          <span className="flex items-center gap-2">
            <Select value={id} onChange={(e) => setId(e.target.value)} className="w-44">
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
          </span>
        }
      >
        <fieldset className="m-0 flex min-w-0 gap-1 border-0 px-4 py-2">
          <legend className="sr-only">Preview as</legend>
          {(
            [
              ["light", "Light client"],
              ["dark", "Dark client"],
              ["text", "Plain text"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              onClick={() => setView(id)}
              className={cn(
                "h-8 rounded-control px-3 text-[13px] transition-colors",
                view === id
                  ? "bg-raised text-ink shadow-1"
                  : "text-ink-3 hover:bg-raised/60 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {view === "text" ? (
          <pre className="m-0 bg-ground/60 px-5 py-5 font-sans text-[13px] leading-[20px] whitespace-pre-wrap text-ink-2">
            {[
              `Subject: ${t.subject}`,
              "",
              organisation.name,
              "",
              t.heading,
              "",
              t.body,
              "",
              `${t.action}:`,
              "https://review.endlesshall.example/…",
              "",
              "-- ",
              t.foot,
            ].join("\n")}
          </pre>
        ) : (
          <div className={cn("px-4 py-6 @3xl/app:px-10", light ? "bg-ink-3/25" : "bg-canvas")}>
            <div
              className={cn(
                "mx-auto w-full max-w-[520px] overflow-hidden rounded-panel-lg border",
                light ? "border-ground/15 bg-paper text-ground" : "border-line bg-pane text-ink",
              )}
            >
              <div
                className={cn(
                  "flex items-center gap-2 px-7 pt-7",
                  light ? "text-ground" : "text-ink",
                )}
              >
                <Mark size={18} mono={light} />
                <span className="text-[14px] font-medium">Hekate</span>
                <span
                  className={cn("ml-auto text-[12px]", light ? "text-ground/50" : "text-ink-3")}
                >
                  {organisation.name}
                </span>
              </div>
              <div className="px-7 pt-6 pb-7">
                <h3 className="text-[20px] leading-[26px] font-medium tracking-tight">
                  {t.heading}
                </h3>
                <p
                  className={cn(
                    "mt-3 text-[14px] leading-[22px]",
                    light ? "text-ground/75" : "text-ink-2",
                  )}
                >
                  {t.body}
                </p>
                <span className="mt-5 inline-flex h-10 items-center rounded-control bg-signal px-4 text-[14px] font-medium text-ground">
                  {t.action}
                </span>
                <p
                  className={cn(
                    "mt-6 text-[12px] leading-[18px]",
                    light ? "text-ground/50" : "text-ink-3",
                  )}
                >
                  {t.foot}
                </p>
              </div>
              <div
                className={cn(
                  "border-t px-7 py-4 text-[11px]",
                  light ? "border-ground/10 text-ground/40" : "border-line text-ink-3",
                )}
              >
                Sent by Hekate for {organisation.name} · review.endlesshall.example · Change what
                you are told about
              </div>
            </div>
          </div>
        )}
        <Row name="Subject">
          <Input key={t.id} defaultValue={t.subject} className="w-full @3xl/app:w-96" />
        </Row>
        <Row
          name="Try it"
          hint="A copy of this template, to your own address, with sample content."
        >
          <Button variant="secondary" size="md">
            Send me a test
          </Button>
        </Row>
      </Section>
    </>
  );
}
