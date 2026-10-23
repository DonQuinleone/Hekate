import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Mark, Wordmark } from "~/components/brand";
import { Icon } from "~/components/icons";
import { AddPasskey, usePasskeySignIn } from "~/components/passkeys";
import { CodeAppSetup } from "~/components/second-factor";
import { Button } from "~/components/ui/button";
import { Choice } from "~/components/ui/choice";
import { CodeField } from "~/components/ui/code-field";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { passwordStrength } from "~/lib/password";
import {
  billingQuery,
  meQuery,
  signInMethodsQuery,
  useBillingPortal,
  useSwitchOrganisation,
} from "~/lib/queries";

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

export type SignInView = "forgot" | "sent" | "reset" | "code" | "recovery" | "directory" | "sso";
export interface SignInSearch {
  redirect?: string;
  view?: SignInView;
  email?: string;
  code?: string;
  /**
   * Why someone is back here: their session ended while they were away, or their workspace
   * takes them only through single sign-on.
   */
  reason?: "expired" | "sso";
  /** What an identity provider's sign-in came back with, when it failed. */
  error?: string;
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
  if (search.view === "directory")
    return <DirectorySignIn redirect={search.redirect} back={() => go({})} />;
  if (search.view === "sso") return <SsoSignIn search={search} back={() => go({})} />;
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
  const key = usePasskeySignIn();
  const { data: methods } = useQuery(signInMethodsQuery);
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
    <Frame
      title={methods?.workspace ? `Sign in to ${methods.workspace.name}` : "Sign in"}
      intro="Review for sound and picture."
    >
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
        <ErrorLine message={error ?? key.error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
        <div className={cn("grid gap-2", methods?.sso && "grid-cols-2")}>
          <Button
            variant="secondary"
            size="lg"
            className="gap-2"
            disabled={key.pending}
            onClick={async () => {
              if (await key.signIn()) await arrive(search.redirect, navigate);
            }}
          >
            <Icon name="key" size={16} />
            {key.pending ? "Waiting" : methods?.sso ? "Passkey" : "Sign in with a passkey"}
          </Button>
          {methods?.sso && (
            <Button
              variant="secondary"
              size="lg"
              className="gap-2"
              onClick={() =>
                void navigate({
                  to: "/sign-in",
                  search: {
                    ...(search.redirect ? { redirect: search.redirect } : {}),
                    view: "sso",
                  },
                })
              }
            >
              <Icon name="shield" size={16} />
              Single sign-on
            </Button>
          )}
        </div>
        {methods?.directory && (
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/sign-in",
                search: {
                  ...(search.redirect ? { redirect: search.redirect } : {}),
                  view: "directory",
                },
              })
            }
            className="self-center text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            Sign in with your workspace's directory
          </button>
        )}
      </form>
      <p className="m-0 border-t border-hairline pt-4 text-xs leading-normal text-ink-3">
        Accounts are by invitation. Guests reviewing a file open the link in their email instead.
      </p>
    </Frame>
  );
}

/** An identity provider's refusal, in words: what Better Auth's error codes mean here. */
const ssoProblem = (code: string | undefined) =>
  !code
    ? null
    : /not_linked|account_not_linked/i.test(code)
      ? "An account with this address already exists. Sign in with its password or passkey instead."
      : "The identity provider did not sign you in. Try again, or ask an admin of your workspace.";

/**
 * Single sign-on: which workspace, then off to its identity provider (OIDC or SAML), which
 * sends the person back signed in. The first sign-in makes the account.
 */
function SsoSignIn({ search, back }: { search: SignInSearch; back: () => void }) {
  // On a workspace's own host (#176), its provider: nobody need say which workspace.
  const { data: methods } = useQuery(signInMethodsQuery);
  const here = methods?.workspace ?? null;
  const [error, setError] = useState<string | null>(ssoProblem(search.error));
  const [pending, setPending] = useState(false);
  const providerFor = async (form: HTMLFormElement): Promise<string | null> => {
    if (here) return here.providerId;
    const workspace = String(new FormData(form).get("workspace")).trim();
    const found = await api["sign-in-methods"].sso.$get({ query: { workspace } });
    return found.ok ? ((await found.json()) as { providerId: string }).providerId : null;
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const providerId = await providerFor(e.currentTarget);
    if (!providerId) {
      setPending(false);
      setError(
        here
          ? `${here.name} does not sign in with single sign-on.`
          : "That workspace does not sign in with single sign-on.",
      );
      return;
    }
    const back = search.redirect?.startsWith("/") && !search.redirect.startsWith("//");
    const { data, error } = await authClient.$fetch<{ url: string }>("/sign-in/sso", {
      method: "POST",
      body: {
        providerId,
        callbackURL: back ? search.redirect : "/",
        errorCallbackURL: "/sign-in?view=sso",
      },
    });
    if (error || !data?.url) {
      setPending(false);
      setError(error?.message ?? "That did not go through. Try again.");
      return;
    }
    window.location.assign(data.url);
  };
  return (
    <Frame
      title="Single sign-on"
      intro={
        here
          ? `${here.name} signs you in through its identity provider.`
          : "Which workspace are you signing in to?"
      }
    >
      {search.reason === "sso" && (
        <p
          role="status"
          className="m-0 rounded-panel border border-line bg-raised/40 px-3 py-2.5 text-[13px] text-ink-2"
        >
          Your workspace signs its members in through single sign-on. Sign in that way to carry on
          where you were.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!here && (
          <Field
            id="workspace"
            label="Workspace"
            autoComplete="organization"
            autoFocus
            placeholder="endless-hall-records"
          />
        )}
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Opening the identity provider" : "Continue to the identity provider"}
        </Button>
      </form>
      <Back onClick={back} />
    </Frame>
  );
}

/**
 * Signing in with a workspace's directory (LDAP or Active Directory): which workspace, then the
 * username and password the directory knows. The first sign-in makes the account.
 */
function DirectorySignIn({ redirect, back }: { redirect?: string; back: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  // On a workspace's own host (#176), its directory: nobody need say which workspace.
  const { data: methods } = useQuery(signInMethodsQuery);
  const here = methods?.workspace ?? null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.$fetch("/sign-in/directory", {
      method: "POST",
      body: {
        workspace: here?.slug ?? String(form.get("workspace")),
        username: String(form.get("username")),
        password: String(form.get("password")),
      },
    });
    setPending(false);
    if (error) {
      setError(error.message ?? "That did not go through. Try again.");
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    await arrive(redirect, navigate);
  };
  return (
    <Frame
      title="Sign in with a directory"
      intro="Your workspace signs you in with the username and password you use at work."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!here && (
          <Field
            id="workspace"
            label="Workspace"
            autoComplete="organization"
            autoFocus
            placeholder="endless-hall-records"
          />
        )}
        <Field id="username" label="Username" autoComplete="username" autoFocus={!!here} />
        <Field id="password" label="Password" type="password" autoComplete="current-password" />
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
      <Back onClick={back} />
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
  const key = usePasskeySignIn();
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
        <button
          type="button"
          disabled={key.pending}
          onClick={async () => {
            if (await key.signIn()) await arrive(redirect, navigate);
          }}
          className="-mt-3 self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          Use a passkey or hardware security key
        </button>
        <ErrorLine message={key.error} />
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

/**
 * `/second-factor`: a workspace (or the instance) asks for a second factor this member has
 * not added. Nothing else opens until they add one; they can also sign out.
 */
export function SecondFactorPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const [withKey, setWithKey] = useState(false);
  const confirm = usePasskeySignIn();
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({ to: "/sign-in", search: {} });
  };
  const standing = me?.secondFactor;
  const name = workspace?.name ?? "This workspace";
  const reason = standing?.securityKey
    ? `${name} asks owners and admins to sign in with a passkey or hardware security key.`
    : `${name} asks you to sign in with a second factor.`;
  const foot = (
    <button
      type="button"
      onClick={signOut}
      className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
    >
      Sign out
    </button>
  );
  const shell = ({ title, intro, body }: { title: string; intro: string; body: ReactNode }) => (
    <Frame title={title} intro={intro}>
      {body}
      {!standing?.securityKey && (
        <button
          type="button"
          onClick={() => setWithKey(!withKey)}
          className="-mt-4 self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
        >
          {withKey ? "Use a code app instead" : "Use a passkey or hardware security key instead"}
        </button>
      )}
      {foot}
    </Frame>
  );

  // They have a key: this sign-in only needs confirming with it.
  if (standing && standing.passkeys > 0)
    return (
      <Frame
        title="Confirm it is you"
        intro={`${reason} Use your passkey or hardware security key.`}
      >
        <Button
          variant="primary"
          size="lg"
          className="gap-2"
          disabled={confirm.pending}
          onClick={async () => {
            if (await confirm.signIn()) await navigate({ to: "/" });
          }}
        >
          <Icon name="key" size={16} />
          {confirm.pending ? "Waiting for the key" : "Use my passkey"}
        </Button>
        <ErrorLine message={confirm.error} />
        {foot}
      </Frame>
    );
  // A key is asked for, or chosen: add one, then confirm with it.
  if (standing?.securityKey || withKey)
    return <AddPasskey page reason={reason} onAdded={() => undefined} shell={shell} />;
  return (
    <CodeAppSetup page reason={reason} onDone={() => void navigate({ to: "/" })} shell={shell} />
  );
}

/** An owner pays what is owed, or changes the card, from the suspended page (#179). */
function PayToReopen() {
  const { data } = useQuery(billingQuery);
  const portal = useBillingPortal();
  const open = data?.invoices.find((i) => i.status === "open" && i.url);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {open?.url && (
          <Button variant="primary" size="lg" asChild>
            <a href={open.url}>Pay the invoice</a>
          </Button>
        )}
        {data?.customer && (
          <Button
            variant="secondary"
            size="lg"
            disabled={portal.isPending}
            onClick={() => portal.mutate()}
          >
            Change the card
          </Button>
        )}
      </div>
      {portal.isError && (
        <p role="alert" className="m-0 text-[13px] text-signal">
          {portal.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * A member whose workspace the instance's operators have suspended (#174): why, and the way
 * out, to another workspace of theirs or signed out. Nothing of the workspace is shown.
 */
export function SuspendedPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const switchTo = useSwitchOrganisation();
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const others = me?.organisations.filter((o) => !o.suspended) ?? [];
  const reason = workspace?.suspended?.reason;
  // Suspended for a payment overdue (#178): it opens again as soon as it is paid.
  const payable = workspace?.suspended?.payable ?? false;
  return (
    <Frame
      title={`${workspace?.name ?? "This workspace"} is suspended`}
      intro={
        payable
          ? workspace?.role === "owner"
            ? "A payment for it is 21 days overdue. It opens again as soon as it is paid; nothing in it is lost."
            : "A payment for it is 21 days overdue. It opens again as soon as its owners pay; nothing in it is lost."
          : reason
            ? `The instance’s operators suspended it: ${reason} Nothing in it is lost; it opens again once they reinstate it.`
            : "The instance’s operators suspended it. Nothing in it is lost; it opens again once they reinstate it."
      }
    >
      {payable && workspace?.role === "owner" && <PayToReopen />}
      {others.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] text-ink-2">Your other workspaces</span>
          {others.map((o) => (
            <Button
              key={o.id}
              variant="secondary"
              size="lg"
              className="justify-start"
              disabled={switchTo.isPending}
              onClick={async () => {
                await switchTo.mutateAsync(o.id);
                await navigate({ to: "/" });
              }}
            >
              {o.name}
            </Button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={async () => {
          await authClient.signOut();
          client.clear();
          await navigate({ to: "/sign-in", search: {} });
        }}
        className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
      >
        Sign out
      </button>
    </Frame>
  );
}
