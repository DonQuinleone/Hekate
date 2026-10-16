import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useMemo, useState } from "react";
import { encode } from "uqr";
import { Button } from "~/components/ui/button";
import { CodeField } from "~/components/ui/code-field";
import { Input } from "~/components/ui/input";
import { authClient } from "~/lib/auth";

/**
 * A second factor: a code app (TOTP) and its recovery codes, set up from the account page or,
 * when a workspace asks for one, before anything else. The key and the codes are shown once.
 */

/** A QR code, drawn dark on paper in every theme so any camera reads it. */
export function QrCode({
  value,
  label,
  size = 176,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, width } = useMemo(() => {
    const { data, size: modules } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { path: d, width: modules };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${width} ${width}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-control bg-paper text-paper-ink"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}

/** The key inside a setup link, in groups of four, for typing into an app by hand. */
export function keyOf(uri: string): string {
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  return (
    secret
      .replace(/=+$/, "")
      .match(/.{1,4}/g)
      ?.join(" ") ?? ""
  );
}

/** Recovery codes, shown once, with ways to keep them. */
export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = `Hekate recovery codes. Each works once.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "hekate-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex flex-col gap-3">
      <ol
        aria-label="Recovery codes"
        className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-1.5 rounded-panel border border-line bg-raised/40 px-4 py-3 font-mono text-[14px] tabular-nums text-ink"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="secondary" onClick={download}>
          Download
        </Button>
      </span>
    </div>
  );
}

/** One step of setting up, as the page or dialog around it lays it out. */
export interface SetupStep {
  title: string;
  intro: string;
  body: ReactNode;
}

type Stage =
  | { at: "password" }
  | { at: "scan"; uri: string; codes: string[] }
  | { at: "codes"; codes: string[] };

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 flex items-center gap-2 text-[13px] text-ink">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-signal" />
      {children}
    </p>
  );
}

/**
 * Adding a code app: the password again, then the key to scan and a first code from it, then
 * the recovery codes. `shell` lays each step out (a page or a dialog).
 */
export function CodeAppSetup({
  shell,
  onDone,
  onCancel,
  reason,
  page = false,
}: {
  shell: (step: SetupStep) => ReactNode;
  onDone: () => void;
  onCancel?: () => void;
  /** Why it is asked for, said first: "Endless Hall Records asks for a second factor." */
  reason?: string;
  /** On a page of its own the action spans the width, as on sign-in; in a dialog it sits right. */
  page?: boolean;
}) {
  const client = useQueryClient();
  const [stage, setStage] = useState<Stage>({ at: "password" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const actions = (primary: { label: string; disabled?: boolean; onClick?: () => void }) => {
    const button = (
      <Button
        variant="primary"
        size={page ? "lg" : "md"}
        type={primary.onClick ? "button" : "submit"}
        disabled={primary.disabled}
        onClick={primary.onClick}
      >
        {primary.label}
      </Button>
    );
    if (page) return button;
    return (
      <span className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {button}
      </span>
    );
  };

  if (stage.at === "password") {
    const submit = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const password = String(new FormData(event.currentTarget).get("password"));
      setPending(true);
      setError(null);
      const { data, error } = await authClient.twoFactor.enable({ password });
      setPending(false);
      if (error || !data || !("totpURI" in data) || !data.totpURI) {
        setError(
          error?.status === 400 ? "That password is not right." : "That did not go through.",
        );
        return;
      }
      setStage({ at: "scan", uri: data.totpURI, codes: data.backupCodes ?? [] });
    };
    return shell({
      title: "Add a code app",
      intro: `${reason ? `${reason} ` : ""}Any authenticator app works. First, your password, to be sure it is you.`,
      body: (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="second-factor-password" className="label">
              Password
            </label>
            <Input
              id="second-factor-password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              className="h-10"
            />
          </div>
          {error && <Problem>{error}</Problem>}
          {actions({ label: pending ? "Checking" : "Continue", disabled: pending })}
        </form>
      ),
    });
  }

  if (stage.at === "scan") {
    const submit = async (event: FormEvent) => {
      event.preventDefault();
      if (code.length !== 6) return;
      setPending(true);
      setError(null);
      const { error } = await authClient.twoFactor.verifyTotp({ code });
      setPending(false);
      if (error) {
        setCode("");
        setError("That code is not right. Codes change every 30 seconds.");
        return;
      }
      // The session is renewed with the factor on: what the app knows of you changes too.
      await client.invalidateQueries({ queryKey: ["me"] });
      setStage({ at: "codes", codes: stage.codes });
    };
    return shell({
      title: "Scan the code",
      intro: "Scan it with your app, then type the six digits the app shows.",
      body: (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="flex flex-col items-start gap-4 @md/app:flex-row @md/app:items-center">
            <QrCode value={stage.uri} label="QR code for your authenticator app" />
            <p className="m-0 text-[13px] leading-normal text-ink-3">
              No camera? Type this key into the app instead:
              {/* Whole groups wrap, never a group split across lines. */}
              <span className="mt-1.5 flex flex-wrap gap-x-2 font-mono text-[14px] text-ink">
                {keyOf(stage.uri)
                  .split(" ")
                  .map((group, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: groups repeat; their place is their identity.
                    <span key={i}>{group}</span>
                  ))}
              </span>
            </p>
          </div>
          <CodeField value={code} onChange={setCode} invalid={Boolean(error)} />
          {error && <Problem>{error}</Problem>}
          {actions({
            label: pending ? "Checking" : "Turn on",
            disabled: pending || code.length !== 6,
          })}
        </form>
      ),
    });
  }

  return shell({
    title: "Keep your recovery codes",
    intro:
      "If you lose your phone, each of these signs you in once. Keep them somewhere other than the phone: they are not shown again.",
    body: (
      <div className="flex flex-col gap-5">
        <RecoveryCodes codes={stage.codes} />
        {actions({ label: "I have kept them", onClick: onDone })}
      </div>
    ),
  });
}
