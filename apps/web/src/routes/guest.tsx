import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup } from "~/components/brand";
import { reviewState } from "~/components/reviews";
import { GuestFrame } from "~/components/shell";
import { Button } from "~/components/ui/button";
import { StatusPill } from "~/components/ui/status";
import { formatDates } from "~/lib/locale";
import { accessNote } from "~/lib/permissions";
import { guestMeQuery, useGuestSignIn, useGuestSignOut } from "~/lib/queries";

const day = formatDates({ day: "numeric", month: "long" });

function Centred({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-6 px-4 py-16">
      <Lockup size={20} />
      <div className="flex w-full max-w-md flex-col gap-3 text-center">{children}</div>
    </div>
  );
}

/** `/guest/:token`: a magic link. Exchanged once for a session in this browser. */
export function GuestLinkPage({ token }: { token: string }) {
  const signIn = useGuestSignIn();
  const navigate = useNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    signIn.mutate(token, {
      onSuccess: (me) => {
        const [only] = me.reviews.filter((r) => r.status === "open");
        if (only && me.reviews.length === 1) {
          void navigate({
            to: "/g/reviews/$reviewId",
            params: { reviewId: only.id },
            replace: true,
          });
        } else void navigate({ to: "/g", replace: true });
      },
    });
  }, [token, signIn, navigate]);
  return (
    <Centred>
      {signIn.error ? (
        <>
          <h1 className="m-0 text-[20px] font-medium">This link no longer works</h1>
          <p className="m-0 text-[14px] text-ink-2">{signIn.error.message}</p>
        </>
      ) : (
        <p className="m-0 text-[14px] text-ink-3">Signing you in</p>
      )}
    </Centred>
  );
}

/** `/guest`: where a guest without a session lands. */
export function GuestSignedOutPage() {
  return (
    <Centred>
      <h1 className="m-0 text-[20px] font-medium">Open the link in your email</h1>
      <p className="m-0 text-[14px] text-ink-2">
        Reviews from outside the workspace start from the link you were sent. Each link works once,
        on one device; ask whoever invited you for a new one if it has expired.
      </p>
    </Centred>
  );
}

/** The frame around a guest's pages: who they are, for whom, and signing out. */
export function GuestShell({ children }: { children: ReactNode }) {
  const { data: me } = useQuery(guestMeQuery);
  const signOut = useGuestSignOut();
  const navigate = useNavigate();
  return (
    <GuestFrame
      account={
        <>
          <span className="hidden min-w-0 flex-col items-end leading-tight @3xl/app:flex">
            <span className="truncate text-[13px] text-ink">{me?.guest.name}</span>
            <span className="truncate text-[12px] text-ink-3">
              {me?.guest.label ? `${me.guest.label}, guest` : "Guest"}
              {me?.organisation ? ` · ${me.organisation}` : ""}
            </span>
          </span>
          {me && <Avatar id={me.guest.id} name={me.guest.name} size={28} />}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              signOut.mutate(undefined, { onSuccess: () => void navigate({ to: "/guest" }) })
            }
          >
            Sign out
          </Button>
        </>
      }
    >
      {children}
    </GuestFrame>
  );
}

/** `/g`: the reviews a guest has been asked to take part in. */
export function GuestHomePage() {
  const { data: me } = useQuery(guestMeQuery);
  if (!me) return null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-[24px] font-medium tracking-[-0.02em]">Your reviews</h1>
        <p className="m-0 text-[13px] text-ink-3">
          {me.organisation ? `${me.organisation} asked you to review these.` : ""}
        </p>
      </div>
      <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
        {me.reviews.map((review) => (
          <li
            key={review.id}
            className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline py-2.5"
          >
            <span className="flex min-w-0 flex-col">
              {review.accessOpen ? (
                <Link
                  to="/g/reviews/$reviewId"
                  params={{ reviewId: review.id }}
                  className="truncate text-sm font-medium text-ink no-underline hover:text-signal"
                >
                  {review.title}
                </Link>
              ) : (
                // Outside their access window it cannot be opened, so it is not a link.
                <span className="truncate text-sm font-medium text-ink-3">{review.title}</span>
              )}
              <span className="text-xs text-ink-3">
                {review.kind === "approval" ? "Approval" : "Feedback"}
                {review.dueAt ? ` · due ${day.format(new Date(review.dueAt))}` : ""}
                {review.submittedAt ? " · you have responded" : ""}
                {accessNote(review) ? ` · ${accessNote(review)}` : ""}
              </span>
            </span>
            <StatusPill state={reviewState(review)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
