import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { NewPassword, PASSWORDS_DIFFER, passwordsAgree } from "~/components/new-password";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
import { authClient } from "~/lib/auth";
import { meQuery, quoting } from "~/lib/queries";
import { ErrorLine, Field, Frame } from "./auth-pages";

const roleLabel = { owner: "an owner", admin: "an admin", member: "a member" } as const;

export function InvitePage({ token }: { token: string }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const { data: invitation, error: loadError } = useQuery({
    queryKey: ["invitation", token],
    queryFn: async () => {
      const res = await api.invitations[":token"].$get({ param: { token } });
      if (!res.ok) throw new Error("This invitation link is not valid.");
      return res.json();
    },
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");

  const accept = async (body: { name?: string; password?: string }) => {
    setPending(true);
    setError(null);
    const res = await api.invitations[":token"].accept.$post({ param: { token }, json: body });
    setPending(false);
    if (!res.ok) {
      const b = (await res.json().catch(() => null)) as {
        error?: { message?: string; reference?: string };
      } | null;
      setError(
        quoting(b?.error?.message ?? "Could not accept the invitation.", b?.error?.reference),
      );
      return;
    }
    await client.invalidateQueries();
    await navigate({ to: "/" });
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!passwordsAgree(form)) return setError(PASSWORDS_DIFFER);
    void accept({ name: String(form.get("name")), password });
  };

  if (loadError) {
    return (
      <Frame title="Invitation not found" intro="Ask whoever invited you for a new link.">
        <Link to="/sign-in" className="text-[13px] text-ink-2">
          Go to sign in
        </Link>
      </Frame>
    );
  }
  if (!invitation) return null;
  if (invitation.status !== "valid") {
    return (
      <Frame
        title={`This invitation has ${invitation.status === "expired" ? "expired" : `been ${invitation.status}`}`}
        intro="Ask whoever invited you for a new link."
      >
        <Link to="/sign-in" className="text-[13px] text-ink-2">
          Go to sign in
        </Link>
      </Frame>
    );
  }
  const title = `Join ${invitation.organisation}`;
  // Who invited them, as the prototype says it (#688); the address it was sent to, once.
  const intro = `${invitation.invitedBy ? `${invitation.invitedBy} invited you` : "You are invited"} to ${invitation.organisation} as ${roleLabel[invitation.role]}.`;
  const signedInAsInvitee = me?.user.email.toLowerCase() === invitation.email.toLowerCase();
  // Signed in, but as someone else: say who, and let them stay or sign out to accept.
  if (me && !signedInAsInvitee) {
    const signOutAndAccept = async () => {
      setPending(true);
      await authClient.signOut();
      client.clear();
      setPending(false);
      // With an account, they sign in as it and come back here; without one, this page asks
      // for a name and a password.
      if (invitation.hasAccount)
        await navigate({ to: "/sign-in", search: { redirect: `/invite/${token}` } });
    };
    return (
      <Frame
        title="Signed in as someone else"
        intro={`This invitation is for ${invitation.email}, and you are signed in as ${me.user.name}.`}
      >
        {/* They came to accept: that leads, the way back beside it, as one group (#688). */}
        <div className="flex flex-col gap-2">
          <Button
            variant="primary"
            size="lg"
            disabled={pending}
            onClick={() => void signOutAndAccept()}
          >
            Sign out and accept
          </Button>
          <Button variant="secondary" size="lg" onClick={() => navigate({ to: "/" })}>
            Stay as {me.user.name}
          </Button>
        </div>
      </Frame>
    );
  }
  if (invitation.hasAccount) {
    return (
      <Frame
        title={title}
        intro={signedInAsInvitee ? intro : `${intro} Sign in as ${invitation.email} to accept.`}
      >
        {signedInAsInvitee ? (
          <Button variant="primary" size="lg" disabled={pending} onClick={() => accept({})}>
            Accept invitation
          </Button>
        ) : (
          <Button variant="primary" size="lg" asChild>
            <Link to="/sign-in" search={{ redirect: `/invite/${token}` }}>
              Sign in to accept
            </Link>
          </Button>
        )}
        <ErrorLine message={error} />
      </Frame>
    );
  }
  return (
    <Frame title={title} intro={intro}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="name" label="Your name" autoComplete="name" autoFocus />
        {/* The account is the address the invitation went to. */}
        <Field
          id="email"
          label="Email"
          type="email"
          value={invitation.email}
          readOnly
          required={false}
          autoComplete="username"
        />
        <NewPassword value={password} onChange={setPassword} />
        <ErrorLine message={error} />
        <div className="flex flex-col gap-2">
          <Button variant="primary" size="lg" type="submit" disabled={pending}>
            {pending ? "Joining" : "Create account and join"}
          </Button>
          <Button variant="secondary" size="lg" asChild>
            <Link to="/sign-in" search={{ redirect: `/invite/${token}` }}>
              I already have an account
            </Link>
          </Button>
        </div>
      </form>
    </Frame>
  );
}
