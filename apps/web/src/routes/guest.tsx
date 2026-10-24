import { reviewKindNames } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup } from "~/components/brand";
import { reviewState } from "~/components/reviews";
import { GuestFrame } from "~/components/shell";
import { Button } from "~/components/ui/button";
import { CodeField } from "~/components/ui/code-field";
import { StatusPill } from "~/components/ui/status";
import { useBrandAccent } from "~/lib/branding";
import { formatDates } from "~/lib/locale";
import { accessNote } from "~/lib/permissions";
import {
  ApiError,
  type GuestSignedIn,
  guestMeQuery,
  useGuestCode,
  useGuestSignIn,
  useGuestSignOut,
} from "~/lib/queries";
import { ErrorLine, Frame, type FrameBrand } from "~/routes/auth-pages";

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
  // Straight to the review when there is one, otherwise to the list.
  const arrive = (me: GuestSignedIn) => {
    const [only] = me.reviews.filter((r) => r.status === "open");
    if (only && me.reviews.length === 1) {
      void navigate({ to: "/g/reviews/$reviewId", params: { reviewId: only.id }, replace: true });
    } else void navigate({ to: "/g", replace: true });
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    signIn.mutate(token, {
      onSuccess: (data) => {
        if (!("verify" in data)) arrive(data);
      },
    });
  });
  if (signIn.data && "verify" in signIn.data)
    return (
      <GuestCode
        token={token}
        sentTo={signIn.data.sentTo}
        brand={{
          name: signIn.data.organisation ?? "Workspace",
          branding: signIn.data.branding ?? null,
        }}
        onOpened={arrive}
      />
    );
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

/**
 * Where the workspace asks for one, the code sent to the guest's address: the link alone opens
 * nothing, so a forwarded mail is no use to whoever has it. Wrong, expired and spent codes each
 * say what to do next.
 */
function GuestCode({
  token,
  sentTo,
  brand,
  onOpened,
}: {
  token: string;
  sentTo: string;
  /** The workspace whose review it opens, with its logo and accent (#185). */
  brand: FrameBrand;
  onOpened: (me: GuestSignedIn) => void;
}) {
  const { resend, verify } = useGuestCode(token);
  const [code, setCode] = useState("");
  const failed = verify.error instanceof ApiError ? verify.error : null;
  // A code that ran out, or was tried too often, is done with: only another will do.
  const spent = failed?.code === "code_expired" || failed?.code === "code_tries";
  if (
    failed?.code === "link_gone" ||
    (resend.error instanceof ApiError && resend.error.code === "link_gone")
  )
    return (
      <Centred>
        <h1 className="m-0 text-[20px] font-medium">This link no longer works</h1>
        <p className="m-0 text-[14px] text-ink-2">
          This link has been used or has expired. Ask whoever invited you to send a new one.
        </p>
      </Centred>
    );
  return (
    <Frame
      brand={brand}
      title="Check your email"
      intro={`A six-digit code has gone to ${resend.data?.sentTo ?? sentTo}, the address the review was sent to. It lasts ten minutes.`}
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (code.length === 6)
            verify.mutate(code, { onSuccess: onOpened, onError: () => setCode("") });
        }}
      >
        <CodeField value={code} onChange={setCode} invalid={Boolean(failed) && !spent} />
        <ErrorLine message={verify.error?.message ?? resend.error?.message ?? null} />
        <Button
          variant="primary"
          size="lg"
          type="submit"
          disabled={verify.isPending || code.length !== 6 || spent}
        >
          {verify.isPending ? "Checking" : "Open the review"}
        </Button>
        <p className="m-0 text-[13px] text-ink-3">
          Nothing after a minute? Look in spam, then{" "}
          <button
            type="button"
            disabled={resend.isPending}
            onClick={() =>
              resend.mutate(undefined, {
                onSuccess: () => {
                  verify.reset();
                  setCode("");
                },
              })
            }
            className="text-ink-2 underline-offset-2 hover:text-ink hover:underline"
          >
            {resend.isSuccess ? "sent again" : "send another code"}
          </button>
          .
        </p>
      </form>
    </Frame>
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
  // The workspace's accent and logo (#185) on every page a guest sees.
  useBrandAccent(me?.branding?.accent);
  const logo = me?.branding?.logo;
  return (
    <GuestFrame
      logo={logo ? { ...logo, name: me?.organisation ?? "Workspace" } : null}
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
                {review.kind === "share" ? "Shared with you" : reviewKindNames[review.kind]}
                {review.dueAt ? ` · due ${day.format(new Date(review.dueAt))}` : ""}
                {review.submittedAt ? " · you have responded" : ""}
                {accessNote(review) ? ` · ${accessNote(review)}` : ""}
              </span>
            </span>
            {/* A share asks nothing, so it has no review status to show (#138). */}
            {review.kind === "share" ? (
              <span className="text-xs text-ink-3">
                {review.status === "open" ? "Shared" : "No longer shared"}
              </span>
            ) : (
              <StatusPill state={reviewState(review)} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
