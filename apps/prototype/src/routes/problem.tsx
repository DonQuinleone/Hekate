import { Link } from "@tanstack/react-router";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { personById } from "~/data";
import { useViewer } from "~/viewer/context";
import { Frame } from "./arrive";

export type ProblemKind = "not-found" | "refused" | "error";

/** A failure's reference, as the server records it (#159), for the sample. */
const REFERENCE = "HK-7F3A-2C";

/**
 * When a page cannot be shown (#546): an address that leads nowhere, a page this account may
 * not open, or something that went wrong. Each says what happened and gives a way on. Signed in,
 * it sits in the shell, the page's place in the pane; signed out, on the standalone frame.
 */
export function ProblemPage({ kind, framed = false }: { kind: ProblemKind; framed?: boolean }) {
  const { persona } = useViewer();
  const person = personById(persona.personId);
  const copy = {
    "not-found": {
      title: "This page does not exist",
      intro: "The address may be mistyped, or what was here has moved or been deleted.",
    },
    refused: {
      title: "You cannot open this",
      intro: `You are signed in as ${person.name} (${person.email}), and this account has no access to it. Ask whoever runs it to add you, or sign in as someone else.`,
    },
    error: {
      title: "Something went wrong",
      intro:
        "Hekate could not show this page. Your work is kept. Try again; if it happens again, quote the reference to whoever runs Hekate.",
    },
  }[kind];
  const ways = (
    <div className="flex flex-col items-start gap-4">
      {kind === "error" && (
        <span className="inline-flex items-center gap-2 text-[13px] text-ink-3">
          Reference <span className="tabular text-ink-2">{REFERENCE}</span>
          <Button size="sm" variant="ghost">
            Copy
          </Button>
        </span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {kind === "error" && <Button variant="primary">Try again</Button>}
        {kind === "refused" && (
          <Button variant="primary" asChild>
            <Link to="/sign-in">Sign in as someone else</Link>
          </Button>
        )}
        <Button variant={kind === "not-found" ? "primary" : "secondary"} asChild>
          <Link to="/">Back to Home</Link>
        </Button>
      </div>
    </div>
  );
  if (framed)
    return (
      <Frame title={copy.title} intro={copy.intro}>
        {ways}
      </Frame>
    );
  return (
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
}
