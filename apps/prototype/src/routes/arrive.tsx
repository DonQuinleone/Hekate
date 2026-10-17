import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Lockup } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
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
        <div className="flex justify-center">
          <Lockup size={30} />
        </div>
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
type SignInView =
  | "sign-in"
  | "forgot"
  | "sent"
  | "code"
  | "recovery"
  | "enrol"
  | "reset"
  | "sso"
  | "directory";

/** A QR code as an authenticator app scans it: drawn dark on paper in every theme. */
function QrSample({ size = 176 }: { size?: number }) {
  const n = 29;
  // A fixed pattern that reads as a QR code: three finders and a scatter of modules.
  const finder = (x: number, y: number) =>
    `M${x} ${y}h7v7h-7zM${x + 1} ${y + 1}v5h5v-5zM${x + 2} ${y + 2}h3v3h-3z`;
  let d = finder(2, 2) + finder(n - 9, 2) + finder(2, n - 9);
  for (let y = 2; y < n - 2; y++)
    for (let x = 2; x < n - 2; x++) {
      const inFinder = (x < 10 && y < 10) || (x > n - 11 && y < 10) || (x < 10 && y > n - 11);
      if (!inFinder && (x * 7 + y * 13 + x * y) % 5 < 2) d += `M${x} ${y}h1v1h-1z`;
    }
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-control bg-paper text-paper-ink"
    >
      <path d={d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const codeBoxes =
  "h-14 w-full rounded-control border border-edge-strong bg-raised text-center text-[22px] tabular text-ink shadow-1 focus:border-ink-2 focus:outline-none focus-visible:shadow-none";

/** Six boxes for a code; typing moves on, pasting fills them. */
function CodeField({ length = 6 }: { length?: number }) {
  return (
    <div role="group" className="grid grid-cols-6 gap-2" aria-label="Code">
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          inputMode="numeric"
          maxLength={1}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          className={codeBoxes}
          onInput={(e) => {
            const el = e.currentTarget;
            if (el.value && el.nextElementSibling instanceof HTMLInputElement)
              el.nextElementSibling.focus();
          }}
        />
      ))}
    </div>
  );
}

/** Sign in: what the organisation allows. Password, passkey and single sign-on side by side; the second factor, the forgotten password, the emailed link and its code are the same page in other states. */
export function SignInPage({ view: initial }: { view?: string }) {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const refused = settings.state === "failed" || settings.state === "refused";
  const [view, setView] = useState<SignInView>((initial as SignInView) || "sign-in");
  const done = () => {
    setPersona("owner");
    navigate({ to: "/" });
  };
  const back = (
    <button
      type="button"
      className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
      onClick={() => setView("sign-in")}
    >
      Back to sign in
    </button>
  );

  if (view === "code")
    return (
      <Frame
        title="Enter your code"
        intro="From your authenticator app, or the hardware security key you registered."
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <CodeField />
          {refused && (
            <p className="text-[14px] text-signal">
              That code is not right. Codes change every 30 seconds.
            </p>
          )}
          <Button type="submit" variant="primary" size="lg">
            Continue
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" size="lg" className="gap-2" onClick={done}>
              <Icon name="key" />
              Hardware security key
            </Button>
            <Button type="button" variant="secondary" size="lg" onClick={() => setView("recovery")}>
              Recovery code
            </Button>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" /> Trust this browser for 30 days
          </label>
        </form>
        {back}
      </Frame>
    );

  if (view === "recovery")
    return (
      <Frame
        title="Use a recovery code"
        intro="One of the codes you kept when you added your code app. Each works once."
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Recovery code
            <Input placeholder="xxxxx-xxxxx" className="h-10 font-mono" spellCheck={false} />
          </label>
          {refused && (
            <p className="text-[14px] text-signal">
              That recovery code is not right, or it has been used.
            </p>
          )}
          <Button type="submit" variant="primary" size="lg">
            Continue
          </Button>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" /> Trust this browser for 30 days
          </label>
          <button
            type="button"
            className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
            onClick={() => setView("code")}
          >
            Use your code app instead
          </button>
        </form>
        {back}
      </Frame>
    );

  // A workspace that asks for a second factor holds back a member without one: before anything
  // else, they add a code app (password, then this, then their recovery codes).
  if (view === "enrol")
    return (
      <Frame
        title="Scan the code"
        intro={`${organisation.name} asks everyone to sign in with a second factor. Scan this with any authenticator app, then type the six digits it shows.`}
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <QrSample />
            <p className="m-0 text-[13px] leading-normal text-ink-3">
              No camera? Type this key into the app instead:
              <span className="mt-1.5 block font-mono text-[14px] break-all text-ink">
                JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP
              </span>
            </p>
          </div>
          <CodeField />
          {refused && (
            <p className="text-[14px] text-signal">
              That code is not right. Codes change every 30 seconds.
            </p>
          )}
          <Button type="submit" variant="primary" size="lg">
            Turn on
          </Button>
        </form>
        <button
          type="button"
          className="-mt-4 self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          Use a passkey or hardware security key instead
        </button>
        <button
          type="button"
          className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
          onClick={() => setView("sign-in")}
        >
          Sign out
        </button>
      </Frame>
    );

  if (view === "forgot")
    return (
      <Frame
        title="Forgotten your password?"
        intro="Enter your email. We will send a code, and a link that carries it, to set a new password. Both last ten minutes."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setView("sent");
          }}
        >
          <Field label="Email" type="email" autoComplete="username" placeholder="you@example.com" />
          <Button type="submit" variant="primary" size="lg">
            Send me a code
          </Button>
        </form>
        {back}
      </Frame>
    );

  if (view === "sent")
    return (
      <Frame
        title="Check your email"
        intro="If that address has an account, a link to set a new password is on its way. Open it on this device, or type the code under it here."
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            setView("reset");
          }}
        >
          <CodeField />
          <Button type="submit" variant="primary" size="lg">
            Continue
          </Button>
          <p className="text-[13px] text-ink-3">
            Nothing after a minute? Look in spam, then{" "}
            <button type="button" className="text-ink-2 hover:text-ink">
              send it again
            </button>
            . The link and the code last ten minutes and work once.
          </p>
        </form>
        {back}
      </Frame>
    );

  if (view === "reset")
    return (
      <Frame
        title="Set a new password"
        intro="Twelve characters or more; a few words are easiest to keep. Every session ends, wherever it was signed in."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <Field label="New password" type="password" autoComplete="new-password" />
          <div className="-mt-2 flex items-center gap-1" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => (
              <span
                key={n}
                className={cn("h-1 flex-1 rounded-full", n <= 3 ? "bg-ink-2" : "bg-raised")}
              />
            ))}
            <span className="ml-2 text-[12px] text-ink-3">strong</span>
          </div>
          <Field label="Again" type="password" autoComplete="new-password" />
          <Button type="submit" variant="primary" size="lg">
            Save and sign in
          </Button>
        </form>
        {back}
      </Frame>
    );

  if (view === "directory")
    return (
      <Frame
        title="Sign in with a directory"
        intro="Your workspace signs you in with the username and password you use at work."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <Field label="Workspace" autoComplete="organization" placeholder="endless-hall-records" />
          <Field label="Username" autoComplete="username" />
          <Field label="Password" type="password" autoComplete="current-password" />
          <Button type="submit" variant="primary" size="lg">
            Sign in
          </Button>
        </form>
        {back}
      </Frame>
    );

  if (view === "sso")
    return (
      <Frame title="Single sign-on" intro="Which workspace are you signing in to?">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            done();
          }}
        >
          <Field label="Workspace" autoComplete="organization" placeholder="endless-hall-records" />
          <Button type="submit" variant="primary" size="lg">
            Continue to the identity provider
          </Button>
        </form>
        {back}
      </Frame>
    );

  return (
    <Frame title="Sign in" intro="Listen, decide, release.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setView("code");
        }}
      >
        <Field label="Email" type="email" autoComplete="username" placeholder="you@example.com" />
        <Field label="Password" type="password" autoComplete="current-password" />
        <button
          type="button"
          className="-mt-2 self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
          onClick={() => setView("forgot")}
        >
          Forgotten your password?
        </button>
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
        <div className="flex items-center gap-3 text-[12px] text-ink-3">
          <span className="h-px flex-1 bg-line" />
          or
          <span className="h-px flex-1 bg-line" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="secondary" size="lg" className="gap-2" onClick={done}>
            <Icon name="passkey" />
            Passkey
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="gap-2"
            onClick={() => setView("sso")}
          >
            <Icon name="shield" />
            Single sign-on
          </Button>
        </div>
        <button
          type="button"
          className="self-center text-[13px] text-ink-3 transition-colors hover:text-ink"
          onClick={() => setView("directory")}
        >
          Sign in with your workspace's directory
        </button>
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
        "Your access window has ended, or the review was cancelled. The workspace can open it again.",
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
        intro="A six-digit code has gone to m•••@example.test, the address the review was sent to. It lasts ten minutes."
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            setPersona("guest");
            navigate({ to: "/g/reviews/$reviewId", params: { reviewId: "rev-masters" } });
          }}
        >
          <CodeField />
          <Button type="submit" variant="primary" size="lg">
            Open the review
          </Button>
          <p className="m-0 text-[13px] text-ink-3">
            Nothing after a minute? Look in spam, then{" "}
            <button type="button" className="text-ink-2 hover:text-ink hover:underline">
              send another code
            </button>
            .
          </p>
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
  "First workspace",
];

/** The full installer, one step per address: requirements, database, storage, the master key and its backup, mail, the public address, the first organisation, then ready. */
export function InstallerPage({ step: initial = 0 }: { step?: number }) {
  const navigate = useNavigate();
  const { settings } = useViewer();
  const [step, setStep] = useState(Math.min(Math.max(initial, 0), installSteps.length));
  const failed = settings.state === "failed";
  const [backend, setBackend] = useState("Local disk");
  const [provider, setProvider] = useState("SMTP");
  const [keyMode, setKeyMode] = useState<"generate" | "own">("generate");
  const next = () => setStep(step + 1);
  const field = (label: string, value: string, type = "text", hint?: string) => (
    <label key={label} className="flex flex-col gap-1.5 text-[14px] text-ink-2">
      {label}
      <input
        defaultValue={value}
        type={type}
        className="h-10 rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink shadow-1 focus:border-edge-strong focus:outline-none"
      />
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
  const select = (
    label: string,
    value: string,
    options: string[],
    onChange: (v: string) => void,
  ) => (
    <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
  const check = (name: string, value: string, ok: boolean) => (
    <li key={name} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
      <Dot state={ok ? "approved" : "changes_requested"} />
      <span className="flex-1 text-ink">{name}</span>
      <span className={ok ? "text-ink-3" : "text-signal"}>{value}</span>
    </li>
  );
  const body = [
    <div key="req" className="flex flex-col gap-4">
      {field(
        "Setup code",
        "7KQ2-M9XD-4HPW",
        "text",
        "In the server's log: docker compose logs app. Only whoever runs the server can set it up.",
      )}
      <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
        {check("Node.js 26", "26.2.0", true)}
        {check("ffmpeg", "7.1.1", true)}
        {check("Poppler", "25.03.0", true)}
        {check("Fonts", "installed", true)}
        {check(
          "Writable settings directory",
          failed ? "/config cannot be written to" : "/config",
          !failed,
        )}
        {check("Disk", "182.4 GB free", true)}
        {check("Memory", "7.8 GB of 16 GB free", true)}
      </ul>
      <p className="text-[13px] text-ink-3">
        Everything here comes from the image or the host; change it there and reload this page.
      </p>
    </div>,
    <div key="db" className="flex flex-col gap-4">
      {field(
        "Connection",
        "postgres://hekate:••••@db:5432/hekate",
        "text",
        "Set in the environment by the Compose file; change it there.",
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md">
          Test the connection
        </Button>
        <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <Dot state="approved" /> Reached in 4 ms · PostgreSQL 18.1
        </span>
      </div>
      <p className="text-[13px] text-ink-3">
        The tables are made now, and brought up to date on every upgrade; the job queue lives here
        too.
      </p>
    </div>,
    <div key="st" className="flex flex-col gap-4">
      {select("Backend", backend, ["Local disk", "S3-compatible"], setBackend)}
      {backend === "Local disk" ? (
        field(
          "Path",
          "/var/lib/hekate/objects",
          "text",
          "On a volume of its own, with room to grow.",
        )
      ) : (
        <>
          {field("Endpoint", "https://s3.eu-west-2.amazonaws.com")}
          <div className="grid gap-4 @md/app:grid-cols-2">
            {field("Bucket", "endlesshall-review")}
            {field("Region", "eu-west-2")}
          </div>
          <div className="grid gap-4 @md/app:grid-cols-2">
            {field("Access key", "")}
            {field("Secret", "", "password")}
          </div>
        </>
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md">
          Write and read a test object
        </Button>
        <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
          <Dot state="approved" /> OK · 11 ms
        </span>
      </div>
      <p className="text-[13px] text-ink-3">
        Every object is encrypted with its own key before it is written; the backend only ever holds
        ciphertext.
      </p>
    </div>,
    <div key="key" className="flex flex-col gap-4">
      <p className="text-[14px] text-ink-2">
        The master key wraps every file key. Lose it and the files are gone with it; keep a copy
        where the server cannot reach it.
      </p>
      <div className="flex gap-2">
        {(["generate", "own"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setKeyMode(m)}
            className={cn(
              "h-9 rounded-control border px-3 text-[13px] transition-colors",
              keyMode === m
                ? "border-edge bg-raised text-ink"
                : "border-line text-ink-2 hover:text-ink",
            )}
          >
            {m === "generate" ? "Generate one now" : "I have one"}
          </button>
        ))}
      </div>
      {keyMode === "generate" ? (
        <>
          <div className="tabular flex items-center gap-3 rounded-panel border border-line bg-sunken px-4 py-3 text-[13px] text-ink">
            <span className="min-w-0 flex-1 truncate">
              hk1-master-2f9c7a11-4e0b-4b6d-9d3e-8c1f5a2b7e44-a71e
            </span>
            <Button variant="ghost" size="sm">
              <Icon name="copy" size={13} />
              Copy
            </Button>
            <Button variant="ghost" size="sm">
              <Icon name="download" size={13} />
              Save
            </Button>
          </div>
          <p className="text-[13px] text-ink-3">
            Made in this browser and shown once. The installer keeps it in the settings file
            (/config/hekate.env), readable by the server alone.
          </p>
        </>
      ) : (
        field("Master key", "", "password", "44 characters, from your password manager or vault.")
      )}
      <label className="flex items-center gap-2 text-[14px] text-ink">
        <input type="checkbox" /> I have stored the master key somewhere the server cannot reach
      </label>
    </div>,
    <div key="mail" className="flex flex-col gap-4">
      {select(
        "Provider",
        provider,
        [
          "SMTP",
          "Resend",
          "SparkPost",
          "Mailgun",
          "SendGrid",
          "Postal",
          "Google Workspace",
          "Microsoft 365",
          "Log only (development)",
        ],
        setProvider,
      )}
      {provider === "SMTP" ? (
        <>
          <div className="grid gap-4 @md/app:grid-cols-[minmax(0,1fr)_120px]">
            {field("Host", "smtp.endlesshall.example")}
            {field("Port", "587")}
          </div>
          <div className="grid gap-4 @md/app:grid-cols-2">
            {field("Username", "hekate")}
            {field("Password", "", "password")}
          </div>
        </>
      ) : provider.startsWith("Log") ? (
        <p className="rounded-panel border border-line bg-raised/40 px-4 py-3 text-[13px] text-ink-2">
          Messages are written to the log instead of sent. For development only.
        </p>
      ) : (
        field("API key", "", "password")
      )}
      {field(
        "From",
        "Hekate <hekate@endlesshall.example>",
        "text",
        "Set SPF and DKIM for this domain or messages land in spam.",
      )}
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="md">
          Send a test message
        </Button>
        <span className="text-[13px] text-ink-3">to alex@endlesshall.example</span>
      </div>
    </div>,
    <div key="addr" className="flex flex-col gap-4">
      {field(
        "Public address",
        "https://review.endlesshall.example",
        "text",
        "Links in mail and the signed media URLs are built from it.",
      )}
      <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
        {check("DNS resolves", "203.0.113.8", true)}
        {check("HTTPS answers", "certificate valid, and it is this server", true)}
      </ul>
    </div>,
    <div key="org" className="flex flex-col gap-4">
      {field(
        "Workspace",
        "Endless Hall Records",
        "text",
        "Your studio, label or company. You can rename it later.",
      )}
      {field("Your name", "Alex Rivera")}
      {field("Email", "alex@endlesshall.example")}
      <div className="grid gap-4 @md/app:grid-cols-2">
        {field("Password", "", "password", "12 characters or more.")}
        {field("Confirm password", "", "password")}
      </div>
      {failed && <p className="text-[14px] text-signal">Passwords need at least 12 characters.</p>}
    </div>,
  ];
  const finished = step >= installSteps.length;
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
                <span className="flex size-5 shrink-0 items-center justify-center">
                  {i < step ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-ok text-ground">
                      <Icon name="check" size={12} />
                    </span>
                  ) : i === step ? (
                    <span className="size-3.5 rounded-full bg-signal shadow-[0_0_0_3px_var(--hk-signal-line)]" />
                  ) : (
                    <span className="size-2 rounded-full bg-ink" />
                  )}
                </span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6">
          {finished ? (
            <>
              <div>
                <p className="eyebrow">Done</p>
                <h1 className="mt-1 text-[24px] leading-[30px] font-medium tracking-[-0.015em]">
                  Hekate is ready
                </h1>
                <p className="mt-2 text-ink-2">
                  Endless Hall Records exists, you are its owner, and the worker is warming up.
                </p>
              </div>
              <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
                {check("Database migrated", "0044", true)}
                {check("Master key in the environment", "wrapped copy in tonight's backup", true)}
                {check("Worker", "4 lanes", true)}
                {check("First workspace", "Endless Hall Records", true)}
              </ul>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
                  Open Hekate
                </Button>
                <Button variant="ghost" size="lg" onClick={() => navigate({ to: "/instance" })}>
                  Instance management
                </Button>
              </div>
            </>
          ) : (
            <>
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
                <Button variant="primary" size="lg" className="ml-auto" onClick={next}>
                  {step === installSteps.length - 1
                    ? "Create and finish"
                    : step === installSteps.length - 2
                      ? "Save and start Hekate"
                      : "Continue"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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
/**
 * A member whose workspace the instance's operators suspended (#174): why, and the way out,
 * to another workspace of theirs or signed out. Nothing of the workspace is shown.
 */
export function SuspendedPage() {
  const navigate = useNavigate();
  return (
    <Frame
      title="Lantern Pictures is suspended"
      intro="The instance’s operators suspended it: The invoice for October is unpaid. Nothing in it is lost; it opens again once they reinstate it."
    >
      <div className="flex flex-col gap-2">
        <span className="text-[13px] text-ink-2">Your other workspaces</span>
        <Button
          variant="secondary"
          size="lg"
          className="justify-start"
          onClick={() => navigate({ to: "/" })}
        >
          {organisation.name}
        </Button>
      </div>
      <Link
        to="/sign-in"
        className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
      >
        Sign out
      </Link>
    </Frame>
  );
}

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
