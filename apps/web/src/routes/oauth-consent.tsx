import type { AuthorizeParams } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { ScopeList } from "~/components/oauth";
import { Button } from "~/components/ui/button";
import { authClient } from "~/lib/auth";
import { authorizeQuery, useAuthorize } from "~/lib/oauth";
import { meQuery } from "~/lib/queries";
import { ErrorLine, Frame } from "./auth-pages";

/** Sends the browser on to the application, with its answer. */
const leave = (address: string) => window.location.assign(address);

/**
 * The consent screen (#447): an application registered by a workspace asks a member of it for
 * access. It names the application, the workspace, what it would be allowed and where the
 * answer goes; Allow sends a code back, Cancel a refusal. A request that cannot be trusted
 * (an unknown application, an address it did not register) is shown here and sent nowhere.
 * One already granted as much goes straight back.
 */
export function ConsentPage({ params }: { params: AuthorizeParams }) {
  const { data: me } = useQuery(meQuery);
  const { data, error, isPending } = useQuery(authorizeQuery(params));
  const decide = useAuthorize();
  const navigate = useNavigate();
  const client = useQueryClient();
  const answered = useRef(false);

  const answer = (approve: boolean) => {
    if (answered.current) return;
    answered.current = true;
    decide.mutate(
      { ...params, approve },
      {
        onSuccess: (r) => {
          if (r.redirect) leave(r.redirect);
          else answered.current = false;
        },
        onError: () => {
          answered.current = false;
        },
      },
    );
  };

  const view = data && "request" in data ? data.request : null;
  const refusal = data && "refusal" in data ? data.refusal : null;
  // Already granted, or refused with somewhere to say so: back to the application at once.
  useEffect(() => {
    if (view?.granted) answer(true);
    else if (refusal?.redirect) leave(refusal.redirect);
  });

  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({
      to: "/sign-in",
      search: { redirect: window.location.pathname + window.location.search },
    });
  };

  if (isPending || view?.granted || refusal?.redirect)
    return (
      <Frame title="Connecting" intro="One moment: checking the application.">
        {null}
      </Frame>
    );

  if (error || refusal)
    return (
      <Frame
        title="This application cannot connect"
        intro={`${refusal?.description ?? error?.message ?? ""} Nothing was shared with it.`}
      >
        <div className="flex flex-col gap-2">
          <Button variant="secondary" size="lg" asChild>
            <Link to="/">Go to Hekate</Link>
          </Button>
          <button
            type="button"
            onClick={signOut}
            className="self-start text-[13px] text-ink-3 transition-colors hover:text-ink"
          >
            Sign in as someone else
          </button>
        </div>
      </Frame>
    );

  if (!view) return null;
  return (
    <Frame
      title={`Connect ${view.client.name}`}
      intro={`It would act as you in ${view.workspace.name}, and can do no more than you can.`}
    >
      <div className="flex flex-col gap-3">
        <span className="text-[13px] text-ink-2">It asks to</span>
        <div data-consent-scopes className="rounded-panel border border-line bg-raised/25 p-3">
          <ScopeList scopes={view.scopes} />
        </div>
        <p className="m-0 text-[13px] text-ink-3">
          Your answer goes back to <span className="tabular text-ink-2">{view.returnsTo}</span>. You
          can disconnect it at any time in Account, Connected apps.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <ErrorLine message={decide.error?.message ?? null} />
        <Button
          variant="primary"
          size="lg"
          disabled={decide.isPending}
          onClick={() => answer(true)}
        >
          Allow
        </Button>
        <Button
          variant="secondary"
          size="lg"
          disabled={decide.isPending}
          onClick={() => answer(false)}
        >
          Cancel
        </Button>
      </div>
      {me && (
        <p className="m-0 text-[13px] text-ink-3">
          Signed in as <span className="text-ink-2">{me.user.name}</span>.{" "}
          <button
            type="button"
            onClick={signOut}
            className="text-ink-3 underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            Not you?
          </button>
        </p>
      )}
    </Frame>
  );
}
