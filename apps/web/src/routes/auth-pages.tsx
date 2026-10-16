import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Mark, Wordmark } from "~/components/brand";
import { CodeAppSetup } from "~/components/second-factor";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { CodeField } from "~/components/ui/code-field";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { passwordStrength } from "~/lib/password";
import { meQuery } from "~/lib/queries";

export function Frame({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-[380px] flex-col gap-8">
        <div className="flex items-center gap-2 text-ink">
          <Mark size={22} aria-hidden="true" />
          <Wordmark height={18} />
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[24px] font-medium tracking-[-0.02em]">{title}</h1>
          <p className="m-0 text-[13px] leading-normal text-ink-3">{intro}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <Input id={id} name={id} className="h-10" required {...props} />
    </div>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="m-0 flex items-center gap-2 text-[13px] text-ink">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-signal" />
      {message}
    </p>
  );
}

export type SignInView = "forgot" | "sent" | "reset" | "code" | "recovery";
export interface SignInSearch {
  redirect?: string;
  view?: SignInView;
  email?: string;
  code?: string;
  /** Why someone is back here: their session ended while they were away. */
  reason?: "expired";
}

/** Sign in, and the forgotten password's states: each a query on /sign-in, so each can be linked. */
export function SignInPage() {
  const search = useSearch({ from: "/sign-in" }) as SignInSearch;
  const navigate = useNavigate();
  const go = (next: SignInSearch) =>
    navigate({
      to: "/sign-in",
      search: { ...(search.redirect ? { redirect: search.redirect } : {}), ...next },
    });
  if (search.view === "forgot")
    return (
      <Forgot
        email={search.email}
        onSent={(email) => go({ view: "sent", email })}
        back={() => go({})}
      />
    );
  if (search.view === "sent")
    return (
      <Sent
        email={search.email ?? ""}
        onCode={(code) => go({ view: "reset", email: search.email ?? "", code })}
        back={() => go({})}
      />
    );
  if (search.view === "code" || search.view === "recovery")
    return (
      <SecondFactor
        recovery={search.view === "recovery"}
        redirect={search.redirect}
        toggle={() => go({ view: search.view === "code" ? "recovery" : "code" })}
        back={() => go({})}
      />
    );
  if (search.view === "reset")
    return (
      <Reset
        email={search.email ?? ""}
        code={search.code ?? ""}
        redirect={search.redirect}
        again={() => go({ view: "forgot", ...(search.email ? { email: search.email } : {}) })}
        back={() => go({})}
      />
    );
  return (
    <SignIn
      search={search}
      forgot={(email) => go({ view: "forgot", ...(email ? { email } : {}) })}
    />
  );
}

/** Back to the start, below each of the forgotten password's states. */
function Back({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
    >
      Back to sign in
    </button>
  );
}

/** Where to go once signed in: a path on this site, never somewhere else. */
async function arrive(redirect: string | undefined, navigate: ReturnType<typeof useNavigate>) {
  if (redirect?.startsWith("/") && !redirect.startsWith("//")) window.location.assign(redirect);
  else await navigate({ to: "/" });
}

function SignIn({ search, forgot }: { search: SignInSearch; forgot: (email: string) => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      // A wait or a lock says how long, in the server's words.
      setError(
        error.status === 429
          ? (error.message ?? "Too many attempts. Wait a minute and try again.")
          : "That email and password do not match.",
      );
      return;
    }
    // A second factor is asked for: no session yet, until its code is given.
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
      await navigate({
        to: "/sign-in",
        search: { ...(search.redirect ? { redirect: search.redirect } : {}), view: "code" },
      });
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    await arrive(search.redirect, navigate);
  };
  return (
    <Frame title="Sign in" intro="Review for sound and picture.">
      {search.reason === "expired" && (
        <p
          role="status"
          className="m-0 rounded-panel border border-line bg-raised/40 px-3 py-2.5 text-[13px] text-ink-2"
        >
          You were signed out: the session ran out, or was ended from another device. Sign in to
          carry on where you were.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field id="password" label="Password" type="password" autoComplete="current-password" />
        <button
          type="button"
          onClick={() => forgot(email)}
          className="-mt-2 self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          Forgotten your password?
        </button>
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
      <p className="m-0 border-t border-hairline pt-4 text-xs leading-normal text-ink-3">
        Accounts are by invitation. Guests reviewing a file open the link in their email instead.
      </p>
    </Frame>
  );
}

/**
 * The second step of signing in, for an account with a code app: its six digits, or one of
 * the recovery codes. A browser can be trusted for 30 days, so it is not asked again there.
 */
function SecondFactor({
  recovery,
  redirect,
  toggle,
  back,
}: {
  recovery: boolean;
  redirect?: string;
  toggle: () => void;
  back: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const ready = recovery ? code.replace(/[^a-z0-9]/gi, "").length === 10 : code.length === 6;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    const { error } = recovery
      ? await authClient.twoFactor.verifyBackupCode({ code, trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: trust });
    setPending(false);
    if (error) {
      setCode("");
      setError(
        error.status === 429 || error.status === 423
          ? (error.message ?? "Too many wrong codes. Wait a while and try again.")
          : error.status === 401 && /two.?factor|session/i.test(error.message ?? "")
            ? "That took too long. Sign in again."
            : recovery
              ? "That recovery code is not right, or it has been used."
              : "That code is not right. Codes change every 30 seconds.",
      );
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    await arrive(redirect, navigate);
  };
  return (
    <Frame
      title={recovery ? "Use a recovery code" : "Enter your code"}
      intro={
        recovery
          ? "One of the codes you kept when you added your code app. Each works once."
          : "The six digits your authenticator app shows for Hekate."
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        {recovery ? (
          <Field
            id="recovery"
            label="Recovery code"
            autoComplete="one-time-code"
            autoFocus
            spellCheck={false}
            placeholder="xxxxx-xxxxx"
            className="h-10 font-mono"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        ) : (
          <CodeField value={code} onChange={setCode} invalid={Boolean(error)} />
        )}
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending || !ready}>
          {pending ? "Checking" : "Continue"}
        </Button>
        <Choice
          checked={trust}
          onChange={(e) => setTrust(e.target.checked)}
          className="text-[13px] text-ink-2"
        >
          Trust this browser for 30 days
        </Choice>
        <button
          type="button"
          onClick={() => {
            setCode("");
            setError(null);
            toggle();
          }}
          className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          {recovery ? "Use your code app instead" : "Lost your phone? Use a recovery code"}
        </button>
      </form>
      <Back onClick={back} />
    </Frame>
  );
}

function Forgot({
  email,
  onSent,
  back,
}: {
  email?: string;
  onSent: (email: string) => void;
  back: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const address = String(new FormData(e.currentTarget).get("email")).trim();
    setPending(true);
    setError(null);
    const { error } = await authClient.emailOtp.requestPasswordReset({ email: address });
    setPending(false);
    if (error) {
      setError(
        error.status === 429
          ? "Too many requests. Wait a few minutes and try again."
          : (error.message ?? "That did not go through. Try again."),
      );
      return;
    }
    onSent(address);
  };
  return (
    <Frame
      title="Forgotten your password?"
      intro="Enter your email. We will send a code, and a link that carries it, to set a new password. Both last ten minutes."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          autoFocus
          defaultValue={email}
        />
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Sending" : "Send me a code"}
        </Button>
      </form>
      <Back onClick={back} />
    </Frame>
  );
}

function Sent({
  email,
  onCode,
  back,
}: {
  email: string;
  onCode: (code: string) => void;
  back: () => void;
}) {
  const [code, setCode] = useState("");
  const [again, setAgain] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  return (
    <Frame
      title="Check your email"
      intro="If that address has an account, a code is on its way. Type it here, or open the link under it on this device."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6) onCode(code);
        }}
        className="flex flex-col gap-5"
      >
        <CodeField value={code} onChange={setCode} />
        <Button variant="primary" size="lg" type="submit" disabled={code.length !== 6}>
          Continue
        </Button>
        <p className="m-0 text-[13px] text-ink-3">
          Nothing after a minute? Look in spam, then{" "}
          <button
            type="button"
            disabled={again === "sending" || !email}
            onClick={async () => {
              setAgain("sending");
              const { error } = await authClient.emailOtp.requestPasswordReset({ email });
              setAgain(error ? "failed" : "sent");
            }}
            className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            {again === "sent" ? "sent again" : "send it again"}
          </button>
          . The code works once, for ten minutes.
        </p>
        {again === "failed" && (
          <ErrorLine message="That did not go through: too many requests, or the mail could not be sent. Wait a few minutes and try again." />
        )}
      </form>
      <Back onClick={back} />
    </Frame>
  );
}

function Reset({
  email,
  code,
  redirect,
  again,
  back,
}: {
  email: string;
  code: string;
  redirect?: string;
  again: () => void;
  back: () => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const strength = passwordStrength(password);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("again") !== password) {
      setError("The two passwords are not the same.");
      return;
    }
    setPending(true);
    setError(null);
    const { error } = await authClient.emailOtp.resetPassword({ email, otp: code, password });
    if (error) {
      setPending(false);
      const wrongCode = /otp|code/i.test(error.message ?? "") || error.status === 403;
      setExpired(wrongCode);
      setError(
        wrongCode
          ? "That code is not right, or it has run out. Ask for a new one."
          : (error.message ?? "That password cannot be used. Choose another."),
      );
      return;
    }
    // Every session ended with the old password; this one starts the new. If signing in does
    // not go straight through (a limit, or a further step), the password is still set: say so.
    const signedIn = await authClient.signIn.email({ email, password });
    setPending(false);
    if (signedIn.error || !signedIn.data || "twoFactorRedirect" in signedIn.data) {
      setDone(true);
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    await arrive(redirect, navigate);
  };
  if (done)
    return (
      <Frame
        title="Your new password is set"
        intro="Every session has ended. Sign in with the new password to carry on."
      >
        <Button variant="primary" size="lg" onClick={back}>
          Sign in
        </Button>
      </Frame>
    );
  return (
    <Frame
      title="Set a new password"
      intro="Twelve characters or more; a few words are easiest to keep. Every session ends, wherever it was signed in."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="-mt-2 flex items-center gap-1" aria-live="polite">
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              aria-hidden="true"
              className={cn(
                "h-1 flex-1 rounded-full",
                n <= strength.score ? "bg-ink-2" : "bg-raised",
              )}
            />
          ))}
          <span className="ml-2 w-16 text-right text-[12px] text-ink-2">
            {password ? strength.label : ""}
          </span>
        </div>
        <Field
          id="again"
          label="Again"
          type="password"
          autoComplete="new-password"
          minLength={12}
        />
        <ErrorLine message={error} />
        {expired ? (
          <Button variant="primary" size="lg" onClick={again}>
            Send a new code
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            type="submit"
            disabled={pending || strength.score === 0}
          >
            {pending ? "Saving" : "Save and sign in"}
          </Button>
        )}
      </form>
      <Back onClick={back} />
    </Frame>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await api.setup.$post({
      json: {
        name: String(form.get("name")),
        email: String(form.get("email")),
        password: String(form.get("password")),
        organisation: String(form.get("organisation")),
      },
    });
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Setup failed. Check the details and try again.");
      return;
    }
    client.setQueryData(["setup"], false);
    await client.invalidateQueries({ queryKey: ["me"] });
    await navigate({ to: "/" });
  };
  return (
    <Frame
      title="Set up Hekate"
      intro="Create the first account. It owns the workspace and can invite everyone else."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="organisation" label="Workspace" placeholder="Studio or company name" autoFocus />
        <Field id="name" label="Your name" autoComplete="name" />
        <Field id="email" label="Email" type="email" autoComplete="username" />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          minLength={12}
        />
        <Field
          id="confirm"
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          minLength={12}
        />
        <p className="m-0 text-xs text-ink-3">At least 12 characters.</p>
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Setting up" : "Create account"}
        </Button>
      </form>
    </Frame>
  );
}

/**
 * `/second-factor`: a workspace (or the instance) asks for a second factor this member has
 * not added. Nothing else opens until they add one; they can also sign out.
 */
export function SecondFactorPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({ to: "/sign-in", search: {} });
  };
  return (
    <CodeAppSetup
      page
      reason={`${workspace?.name ?? "This workspace"} asks everyone to sign in with a second factor.`}
      onDone={() => void navigate({ to: "/" })}
      shell={({ title, intro, body }) => (
        <Frame title={title} intro={intro}>
          {body}
          <button
            type="button"
            onClick={signOut}
            className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            Sign out
          </button>
        </Frame>
      )}
    />
  );
}
