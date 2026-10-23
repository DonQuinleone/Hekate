import { type SignUpLink, slugFrom } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { meQuery, quoting, signUpInfoQuery } from "~/lib/queries";
import { ErrorLine, Field, Frame, PasswordMeter } from "./auth-pages";

/** The trial, in a sentence, or nothing. */
const trialLine = (days: number | null) => (days ? ` It starts with a ${days}-day trial.` : "");

/** What a refused request said, in the server's words. */
async function problem(res: Response, fallback: string) {
  const body = (await res.json().catch(() => null)) as {
    error?: { message?: string; reference?: string };
  } | null;
  return quoting(body?.error?.message ?? fallback, body?.error?.reference);
}

function ToSignIn({ label = "Sign in", redirect }: { label?: string; redirect?: string }) {
  return (
    <Button variant="secondary" size="lg" asChild>
      <Link to="/sign-in" search={redirect ? { redirect } : {}}>
        {label}
      </Link>
    </Button>
  );
}

/**
 * `/sign-up` (#184): with open sign-up, the email first, which a link confirms; invite-only or
 * closed, the way in instead.
 */
export function SignUpPage() {
  const { data: info, error: loadError } = useQuery(signUpInfoQuery);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (loadError)
    return (
      <Frame title="Sign-up did not load" intro={loadError.message}>
        <ToSignIn />
      </Frame>
    );
  if (!info) return null;
  if (info.mode !== "open")
    return (
      <Frame
        title={info.mode === "invite" ? "Workspaces are by invitation" : "Sign-up is closed"}
        intro={
          info.mode === "invite"
            ? "Someone the instance's operators invite makes a workspace at the link in their invitation. Ask them for one."
            : "The instance's operators make its workspaces. To join one, ask its owner for an invitation."
        }
      >
        <ToSignIn />
      </Frame>
    );
  if (sentTo)
    return (
      <Frame
        title="Check your email"
        intro={`A link to make your workspace is on its way to ${sentTo}. It lasts a day and works once.`}
      >
        <p className="m-0 text-[13px] text-ink-3">
          Nothing after a minute? Look in spam, then{" "}
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            ask again
          </button>
          .
        </p>
      </Frame>
    );
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim();
    setPending(true);
    setError(null);
    const res = await api["sign-up"].start.$post({ json: { email } });
    setPending(false);
    if (!res.ok) return setError(await problem(res, "That did not go through. Try again."));
    setSentTo(email);
  };
  return (
    <Frame
      title="Make a workspace"
      intro={`Start with your email: a link confirms it, then you name the workspace and choose its address.${trialLine(info.trialDays)}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="email" label="Email" type="email" autoComplete="email" autoFocus />
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Sending" : "Send me a link"}
        </Button>
      </form>
      <p className="m-0 border-t border-hairline pt-4 text-xs leading-normal text-ink-3">
        Already have an account?{" "}
        <Link
          to="/sign-in"
          className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
        >
          Sign in
        </Link>
        .
      </p>
    </Frame>
  );
}

/** `/sign-up/$token`: the link, confirmed. Name the workspace, and make the account if need be. */
export function SignUpLinkPage({ token }: { token: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: link, error: loadError } = useQuery({
    queryKey: ["sign-up", token],
    queryFn: async (): Promise<SignUpLink> => {
      const res = await api["sign-up"][":token"].$get({ param: { token } });
      if (!res.ok) throw new Error("This link is not valid.");
      return (await res.json()) as SignUpLink;
    },
    retry: false,
  });
  const [workspace, setWorkspace] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (loadError)
    return (
      <Frame
        title="This link is not valid"
        intro="It has been used already, or withdrawn. Ask for another, or sign in."
      >
        <ToSignIn />
      </Frame>
    );
  if (!link) return null;
  if (!link.allowed)
    return (
      <Frame title="Sign-up is closed" intro={link.refusal ?? ""}>
        <ToSignIn />
      </Frame>
    );
  if (link.expired)
    return (
      <Frame
        title="This link has expired"
        intro={
          link.invited
            ? "Invitations last a week. Ask the instance's operators to send another."
            : "Links last a day. Ask for another with the same email."
        }
      >
        {link.invited ? (
          <ToSignIn />
        ) : (
          <Button variant="primary" size="lg" asChild>
            <Link to="/sign-up">Ask for another</Link>
          </Button>
        )}
      </Frame>
    );
  const signedInAsHolder = me?.user.email === link.email;
  if (link.hasAccount && !signedInAsHolder)
    return (
      <Frame
        title="Sign in to carry on"
        intro={`${link.email} has an account here. Sign in as it, then name the new workspace.`}
      >
        <ToSignIn label={`Sign in as ${link.email}`} redirect={`/sign-up/${token}`} />
      </Frame>
    );

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!link.hasAccount && form.get("again") !== password)
      return setError("The two passwords are not the same.");
    setPending(true);
    setError(null);
    const res = await api["sign-up"][":token"].$post({
      param: { token },
      json: {
        workspace,
        slug,
        ...(link.hasAccount ? {} : { name: String(form.get("name")), password }),
      },
    });
    if (!res.ok) {
      setPending(false);
      return setError(await problem(res, "The workspace could not be made. Try again."));
    }
    const { address } = (await res.json()) as { address: string | null };
    await client.invalidateQueries();
    // With subdomains on (#176), the workspace answers at its own address.
    if (address) window.location.assign(address);
    else await navigate({ to: "/" });
  };
  const at = link.subdomains ? `${slug || "your-workspace"}.${link.subdomains}` : null;
  return (
    <Frame
      title="Make your workspace"
      intro={`${link.invited ? "You are invited to make a workspace of your own" : "Your email is confirmed"}, as ${link.email}.${trialLine(link.trialDays)}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          id="workspace"
          label="Workspace name"
          autoComplete="organization"
          autoFocus
          maxLength={120}
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            if (!slugTouched) setSlug(slugFrom(e.target.value));
          }}
        />
        <div className="flex flex-col gap-1.5">
          <Field
            id="slug"
            label="Subdomain"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
          />
          <p className="m-0 truncate text-xs text-ink-3">
            {at ?? "Lower-case letters, digits and hyphens: how the workspace is named to sign in."}
          </p>
        </div>
        {!link.hasAccount && (
          <>
            <Field id="name" label="Your name" autoComplete="name" maxLength={120} />
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <PasswordMeter password={password} />
            <Field
              id="again"
              label="Again"
              type="password"
              autoComplete="new-password"
              minLength={12}
            />
          </>
        )}
        <ErrorLine message={error} />
        <Button variant="primary" size="lg" type="submit" disabled={pending}>
          {pending ? "Making it" : "Make the workspace"}
        </Button>
      </form>
    </Frame>
  );
}
