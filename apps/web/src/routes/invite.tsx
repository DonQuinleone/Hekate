import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button } from "~/components/ui/button";
import { api } from "~/lib/api";
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
    if (form.get("password") !== form.get("confirm"))
      return setError("The passwords do not match.");
    void accept({ name: String(form.get("name")), password: String(form.get("password")) });
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
  const intro = `You are invited as ${roleLabel[invitation.role]}, as ${invitation.email}.`;
  if (invitation.hasAccount) {
    const signedInAsInvitee = me?.user.email === invitation.email;
    return (
      <Frame title={title} intro={intro}>
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
          {pending ? "Joining" : "Create account and join"}
        </Button>
      </form>
    </Frame>
  );
}
