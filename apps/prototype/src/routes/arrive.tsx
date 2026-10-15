import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Lockup } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { organisation } from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";

function Frame({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-[380px] flex-col gap-8">
        <Lockup size={22} />
        <div>
          <h1 className="text-[24px] leading-[30px] font-medium tracking-[-0.015em]">{title}</h1>
          {intro && <p className="mt-2 text-ink-2">{intro}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-[14px] text-ink-2">
      {label}
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="h-10 rounded-control border border-edge bg-ground px-3 text-[14px] text-ink shadow-1 placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
      />
    </label>
  );
}

/** Sign in: what the organisation allows. Here: password, passkey and single sign-on. */
export function SignInPage() {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const refused = settings.state === "failed" || settings.state === "refused";
  const ssoOnly = settings.state === "expired";
  return (
    <Frame title="Sign in" intro="Review for sound and picture.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPersona("owner");
          navigate({ to: "/" });
        }}
      >
        {ssoOnly ? (
          <p className="rounded-panel border border-line bg-raised/40 px-4 py-3 text-[14px] text-ink-2">
            {organisation.name} signs in through its identity provider. Passwords are off for
            members.
          </p>
        ) : (
          <>
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
            />
            <Field label="Password" type="password" autoComplete="current-password" />
            {refused && (
              <p className="text-[14px] text-signal">
                {settings.state === "failed"
                  ? "Too many attempts. Wait a minute before trying again."
                  : "That email and password do not match."}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg">
              Sign in
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="gap-2"
          onClick={() => navigate({ to: "/" })}
        >
          <Icon name="key" />
          Sign in with a passkey
        </Button>
        <Button type="button" variant="secondary" size="lg" onClick={() => navigate({ to: "/" })}>
          Continue with Endless Hall SSO
        </Button>
      </form>
      <p className="border-t border-line pt-4 text-[13px] text-ink-3">
        Accounts are by invitation. Guests reviewing a file open the link in their email instead.
      </p>
    </Frame>
  );
}

/** A guest opens the link in their email: it signs them in, or asks for a code first. */
export function GuestLinkPage() {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const state = settings.state;
  if (state === "expired" || state === "refused" || state === "failed") {
    const copy = {
      expired: [
        "This link has expired",
        "Links last three days. Ask whoever sent it for a new one; it will come from Hekate by email.",
      ],
      refused: [
        "This link has already been used",
        "Each link works once. If that was not you, ask whoever sent it to send a new one, which revokes this one.",
      ],
      failed: [
        "This review is closed to you",
        "Your access window has ended, or the review was cancelled. The organisation can open it again.",
      ],
    }[state];
    return (
      <Frame title={copy[0] ?? ""} intro={copy[1]}>
        <Button variant="secondary" size="lg" asChild>
          <Link to="/guest">Back</Link>
        </Button>
      </Frame>
    );
  }
  if (organisation.guestVerification === "code" || state === "processing") {
    return (
      <Frame
        title="Check your email"
        intro="A six-digit code has been sent to the address the review was sent to. It lasts ten minutes."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPersona("guest");
            navigate({ to: "/g/reviews/$reviewId", params: { reviewId: "rev-masters" } });
          }}
        >
          <Field label="Code" placeholder="000 000" autoComplete="one-time-code" />
          <Button type="submit" variant="primary" size="lg">
            Open the review
          </Button>
          <button type="button" className="text-left text-[13px] text-ink-3 hover:text-ink">
            Send another code
          </button>
        </form>
      </Frame>
    );
  }
  return (
    <Frame
      title="Opening your review"
      intro={`${organisation.name} asked you to review Album masters. This link is yours alone and lasts a fortnight once opened.`}
    >
      <Button
        variant="primary"
        size="lg"
        onClick={() => {
          setPersona("guest");
          navigate({ to: "/g/reviews/$reviewId", params: { reviewId: "rev-masters" } });
        }}
      >
        Continue as Mira Solberg
      </Button>
    </Frame>
  );
}

export function GuestSignedOutPage() {
  return (
    <Frame
      title="Open the link in your email"
      intro="Reviews are reached through the link you were sent. It signs you in on this device; there is no password."
    >
      <Button variant="secondary" size="lg" asChild>
        <Link to="/guest/link">Open the sample link</Link>
      </Button>
    </Frame>
  );
}

/* ---------- Installer ---------- */

const installSteps = [
  "Requirements",
  "Database",
  "Storage",
  "Master key",
  "Mail",
  "Address",
  "First organisation",
];

/** The full installer: requirements, database, storage, the master key and its backup, mail, the public address, then the first organisation and owner. */
export function InstallerPage() {
  const navigate = useNavigate();
  const { settings } = useViewer();
  const [step, setStep] = useState(0);
  const failed = settings.state === "failed";
  const next = () => (step < installSteps.length - 1 ? setStep(step + 1) : navigate({ to: "/" }));
  const field = (label: string, value: string, type = "text") => (
    <label key={label} className="flex flex-col gap-1.5 text-[14px] text-ink-2">
      {label}
      <input
        defaultValue={value}
        type={type}
        className="h-10 rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink shadow-1 focus:border-edge-strong focus:outline-none"
      />
    </label>
  );
  const body = [
    <ul
      key="req"
      className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25"
    >
      {[
        ["Node.js 26", "26.2.0", true],
        ["PostgreSQL 18 reachable", failed ? "connection refused on 5432" : "18.1", !failed],
        ["ffmpeg with libaom", "7.1", true],
        ["Writable data directory", "/var/lib/hekate", true],
        ["Public address answers over HTTPS", "pending", true],
      ].map(([name, value, ok]) => (
        <li key={String(name)} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
          <Dot state={ok ? "approved" : "changes_requested"} />
          <span className="flex-1 text-ink">{name}</span>
          <span className={ok ? "text-ink-3" : "text-signal"}>{value}</span>
        </li>
      ))}
    </ul>,
    <div key="db" className="flex flex-col gap-4">
      {field("Connection", "postgres://hekate@db:5432/hekate")}
      {field("Password", "", "password")}
      <p className="text-[13px] text-ink-3">Migrations run on first start and on every upgrade.</p>
    </div>,
    <div key="st" className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Backend
        <select className="h-10 rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink">
          <option>Local disk</option>
          <option>S3-compatible</option>
        </select>
      </label>
      {field("Path", "/var/lib/hekate/objects")}
      <p className="text-[13px] text-ink-3">
        Every object is encrypted with its own key before it is written; the backend only ever holds
        ciphertext.
      </p>
    </div>,
    <div key="key" className="flex flex-col gap-4">
      <p className="text-[14px] text-ink-2">
        The master key wraps every file key. Hekate generated one; keep a copy where the server
        cannot reach it.
      </p>
      <div className="tabular rounded-panel border border-line bg-sunken px-4 py-3 text-[13px] text-ink-2">
        hk1-master-2f9c…a71e (44 characters, hidden)
      </div>
      <label className="flex items-center gap-2 text-[14px] text-ink">
        <input type="checkbox" /> I have backed up the master key
      </label>
    </div>,
    <div key="mail" className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Provider
        <select className="h-10 rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink">
          <option>SMTP</option>
          <option>Resend</option>
          <option>SparkPost</option>
          <option>Mailgun</option>
          <option>SendGrid</option>
          <option>Postal</option>
          <option>Google Workspace</option>
          <option>Microsoft 365</option>
          <option>Log only (development)</option>
        </select>
      </label>
      {field("Host", "smtp.example")}
      {field("From", "Hekate <hekate@endlesshall.example>")}
      <Button variant="secondary" size="md" className="self-start">
        Send a test message
      </Button>
    </div>,
    <div key="addr" className="flex flex-col gap-4">
      {field("Public address", "https://review.endlesshall.example")}
      <p className="text-[13px] text-ink-3">
        Links in mail and the signed media URLs are built from it. Caddy terminates TLS in front.
      </p>
    </div>,
    <div key="org" className="flex flex-col gap-4">
      {field("Organisation", "Endless Hall Records")}
      {field("Your name", "Alex Rivera")}
      {field("Email", "alex@endlesshall.example")}
      {field("Password (12 characters or more)", "", "password")}
      {failed && <p className="text-[14px] text-signal">Passwords need at least 12 characters.</p>}
    </div>,
  ];
  return (
    <div className="flex min-h-full items-start justify-center px-4 py-12">
      <div className="flex w-full max-w-[880px] flex-col gap-8 @3xl/app:flex-row @3xl/app:gap-16">
        <div className="flex shrink-0 flex-col gap-6 @3xl/app:w-[220px]">
          <Lockup size={22} />
          <ol className="flex flex-wrap gap-x-4 gap-y-1 @3xl/app:flex-col">
            {installSteps.map((s, i) => (
              <li
                key={s}
                className={cn(
                  "flex items-center gap-2.5 text-[14px]",
                  i === step ? "text-ink" : i < step ? "text-ink-2" : "text-ink-3",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full text-[11px]",
                    i < step
                      ? "bg-ink text-ground"
                      : i === step
                        ? "bg-signal text-ground"
                        : "border border-line-strong",
                  )}
                >
                  {i < step ? "✓" : i + 1}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          <div>
            <p className="eyebrow">
              Step {step + 1} of {installSteps.length}
            </p>
            <h1 className="mt-1 text-[24px] leading-[30px] font-medium tracking-[-0.015em]">
              {installSteps[step]}
            </h1>
          </div>
          {body[step]}
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button variant="ghost" size="lg" onClick={() => setStep(step - 1)}>
                Back
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              className="ml-auto"
              onClick={next}
              disabled={step === 0 && failed}
            >
              {step === installSteps.length - 1 ? "Finish and sign in" : "Continue"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Accept an invitation: create the account, or sign in to accept. */
export function InvitationPage() {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const state = settings.state;
  if (state === "expired" || state === "refused")
    return (
      <Frame
        title={
          state === "expired" ? "This invitation has expired" : "This invitation was already used"
        }
        intro="Ask whoever invited you to send another; the new one revokes this one."
      >
        <Button variant="secondary" size="lg" asChild>
          <Link to="/sign-in">Sign in</Link>
        </Button>
      </Frame>
    );
  if (state === "failed")
    return (
      <Frame
        title="Signed in as someone else"
        intro="This invitation is for producer@endlesshall.example, and you are signed in as Alex Rivera."
      >
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
          Stay as Alex Rivera
        </Button>
        <Button variant="secondary" size="lg" onClick={() => navigate({ to: "/sign-in" })}>
          Sign out and accept
        </Button>
      </Frame>
    );
  return (
    <Frame
      title="Join Endless Hall Records"
      intro="Ines Arlow invited you as a member. Create your account to accept."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPersona("owner");
          navigate({ to: "/" });
        }}
      >
        <Field label="Name" placeholder="Your name" autoComplete="name" />
        <Field
          label="Email"
          type="email"
          placeholder="producer@endlesshall.example"
          autoComplete="username"
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          placeholder="12 characters or more"
        />
        <Button type="submit" variant="primary" size="lg">
          Create account and join
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          onClick={() => navigate({ to: "/sign-in" })}
        >
          I already have an account
        </Button>
      </form>
    </Frame>
  );
}

/** The visitor's side of an upload request: no account, one folder, a limit and an expiry. */
export function UploadRequestPage({ code }: { code: string }) {
  const { settings } = useViewer();
  const [files, setFiles] = useState<string[]>([]);
  const state = settings.state;
  if (state === "expired")
    return (
      <Frame
        title="This request has closed"
        intro="Uploads were accepted until 20 October 2026. Ask Endless Hall Records to open it again."
      />
    );
  if (state === "failed")
    return (
      <Frame
        title="The limit is reached"
        intro="This request accepted 5 files, and 5 have arrived."
      />
    );
  return (
    <Frame
      title="Send your stems"
      intro={`Endless Hall Records asked for the string stems of Maple Leaf Rag. Up to 5 files, until 20 October. Request ${code}.`}
    >
      <Field label="Your name" placeholder="So we know who sent them" autoComplete="name" />
      <button
        type="button"
        onClick={() => setFiles((f) => [...f, `Strings stem ${f.length + 1}.wav`])}
        className="flex flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40"
      >
        <Icon name="upload" size={20} className="text-ink-3" />
        <span className="text-[14px] text-ink">Drop files here, or choose them</span>
        <span className="text-[13px] text-ink-3">
          WAV or AIFF, up to 4 GB each; uploads resume if the connection drops.
        </span>
      </button>
      {files.length > 0 && (
        <ul className="flex flex-col gap-1">
          {files.map((f, i) => (
            <li key={f} className="flex items-center gap-3 text-[13px] text-ink-2">
              <Icon name="music" size={14} className="text-ink-3" />
              {f}
              <span className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-raised">
                <span
                  className="block h-full bg-ink-2"
                  style={{ width: i === files.length - 1 ? "45%" : "100%" }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[13px] text-ink-3">
        {files.length} of 5 sent. The files go straight into the project's folder; only its members
        see them.
      </p>
    </Frame>
  );
}
