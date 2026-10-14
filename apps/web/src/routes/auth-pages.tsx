import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Mark, Wordmark } from "~/components/brand";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";

function Frame({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
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

function Field({
  id,
  label,
  ...props
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <Input id={id} name={id} className="h-10" required {...props} />
    </div>
  );
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="m-0 flex items-center gap-2 text-[13px] text-ink">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-signal" />
      {message}
    </p>
  );
}

export function SignInPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) {
      setError(
        error.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That email and password do not match.",
      );
      return;
    }
    await client.invalidateQueries({ queryKey: ["me"] });
    await navigate({ to: "/" });
  };
  return (
    <Frame title="Sign in" intro="Review for sound and picture.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="email" label="Email" type="email" autoComplete="username" autoFocus />
        <Field id="password" label="Password" type="password" autoComplete="current-password" />
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
      <p className="m-0 border-t border-hairline pt-4 text-xs leading-normal text-ink-3">
        Accounts are by invitation. Single sign-on, passkeys and security keys arrive in later
        releases.
      </p>
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
      intro="Create the first account. It owns the organisation and can invite everyone else."
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="organisation" label="Organisation" placeholder="Studio name" autoFocus />
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
