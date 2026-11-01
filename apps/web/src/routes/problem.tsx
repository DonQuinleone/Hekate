import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { Icon } from "~/components/icons";
import { Shell } from "~/components/shell";
import { Button } from "~/components/ui/button";
import { Failed, isRefusal, referenceOf } from "~/components/ui/states";
import { authClient } from "~/lib/auth";
import { ListeningProvider } from "~/lib/listening-room";
import { ApiError, meQuery } from "~/lib/queries";
import { RecorderProvider } from "~/lib/recorders/provider";
import { Frame } from "./auth-pages";

export type ProblemKind = "not-found" | "refused" | "error";

/**
 * Which shell a page is drawn in, if any: a page that cannot be shown there takes the pane,
 * not a shell of its own, and leads back to that shell's home.
 */
export const InShell = createContext<"member" | "guest" | null>(null);

/** What each page says, as the prototype's (apps/prototype/src/routes/problem.tsx). */
export function problemCopy(
  kind: ProblemKind,
  who: { name: string; email: string } | null,
): { title: string; intro: string } {
  if (kind === "refused")
    return {
      title: "You cannot open this",
      intro: who
        ? `You are signed in as ${who.name} (${who.email}), and this account has no access to it. Ask whoever runs it to add you, or sign in as someone else.`
        : "This is not open to you. Sign in with the account that has access to it.",
    };
  if (kind === "error")
    return {
      title: "Something went wrong",
      intro:
        "Hekate could not show this page. Your work is kept. Try again; if it happens again, tell whoever runs Hekate what you were doing, with the reference if there is one.",
    };
  return {
    title: "This page does not exist",
    intro: "The address may be mistyped, or what was here has moved or been deleted.",
  };
}

/** The kind of page a thrown error calls for: a refusal from the server is not a failure. */
export const problemOf = (error: unknown): ProblemKind => (isRefusal(error) ? "refused" : "error");

function Reference({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-ink-3">
      Reference <span className="tabular text-ink-2 select-all">{value}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

/**
 * When a page cannot be shown (#546): an address that leads nowhere, a page this account may
 * not open, or something that went wrong, each with a way on. Signed in, it takes the page's
 * place in the shell; signed out, it stands on the sign-in frame.
 */
export function ProblemPage({
  kind,
  error,
  reset,
}: {
  kind: ProblemKind;
  error?: unknown;
  /** Try again: the router's reset for an error it caught. */
  reset?: () => void;
}) {
  const inShell = useContext(InShell);
  const { data: me, isPending } = useQuery({
    ...meQuery,
    retry: false,
    enabled: inShell !== "guest",
  });
  const client = useQueryClient();
  const navigate = useNavigate();
  const who = me && inShell !== "guest" ? { name: me.user.name, email: me.user.email } : null;
  const copy = problemCopy(kind, who);
  const reference = referenceOf(error);
  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({ to: "/sign-in" });
  };
  const ways = (
    <div className="flex flex-col items-start gap-4">
      {kind === "error" && reference && <Reference value={reference} />}
      <div className="flex flex-wrap items-center gap-2">
        {kind === "error" && (
          <Button
            variant="primary"
            onClick={() => {
              void client.invalidateQueries();
              if (reset) reset();
              else window.location.reload();
            }}
          >
            Try again
          </Button>
        )}
        {kind === "refused" && me && inShell !== "guest" && (
          <Button variant="primary" onClick={() => void signOut()}>
            Sign in as someone else
          </Button>
        )}
        <Button variant={kind === "not-found" ? "primary" : "secondary"} asChild>
          {inShell === "guest" ? (
            <Link to="/g">Back to your reviews</Link>
          ) : (
            <Link to="/">{me || inShell ? "Back to Home" : "Sign in"}</Link>
          )}
        </Button>
      </div>
    </div>
  );
  const body = (
    <div className="flex min-h-full items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-[420px] flex-col gap-6">
        <span className="flex size-9 items-center justify-center rounded-full border border-line-strong text-ink-2">
          <Icon
            name={kind === "error" ? "close" : kind === "refused" ? "lock" : "search"}
            size={15}
          />
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[24px] leading-[30px] font-medium tracking-[-0.015em]">
            {copy.title}
          </h1>
          <p className="m-0 text-ink-2">{copy.intro}</p>
        </div>
        {ways}
      </div>
    </div>
  );
  if (inShell) return body;
  // Until it is known who is here, nothing: no frame that turns into a shell a moment later.
  if (isPending) return null;
  if (me) return <ShellAround>{body}</ShellAround>;
  return (
    <Frame title={copy.title} intro={copy.intro}>
      {ways}
    </Frame>
  );
}

/** The shell as the app draws it, for a page reached outside the app's own routes. */
export function ShellAround({ children }: { children: ReactNode }) {
  return (
    <InShell.Provider value="member">
      <ListeningProvider>
        <RecorderProvider>
          <Shell>{children}</Shell>
        </RecorderProvider>
      </ListeningProvider>
    </InShell.Provider>
  );
}

/**
 * A page whose subject could not be loaded: a refusal from the server is the not found or
 * refused page, as an address that leads nowhere would be; anything else is Failed, with Try
 * again.
 */
export function PageFailed({
  what,
  error,
  retry,
}: {
  what: string;
  error: unknown;
  retry: () => unknown;
}) {
  if (error instanceof ApiError && error.code === "forbidden")
    return <ProblemPage kind="refused" error={error} />;
  if (error instanceof ApiError && error.code === "not_found")
    return <ProblemPage kind="not-found" error={error} />;
  return <Failed what={what} error={error} retry={retry} />;
}
