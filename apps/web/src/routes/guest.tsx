import { reviewKindNames } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { reviewState } from "~/components/reviews";
import { GuestFrame } from "~/components/shell";
import { Button } from "~/components/ui/button";
import { CodeField } from "~/components/ui/code-field";
import { useConfirm } from "~/components/ui/dialog";
import { MenuList, usePopover } from "~/components/ui/menu";
import { Failed, failureText, Loading } from "~/components/ui/states";
import { StatusPill } from "~/components/ui/status";
import { useBrandAccent } from "~/lib/branding";
import { formatDates, localeKey } from "~/lib/locale";
import { accessNote } from "~/lib/permissions";
import {
  ApiError,
  type GuestArrival,
  type GuestMe,
  type GuestSignedIn,
  guestArrivalQuery,
  guestMeQuery,
  useGuestCode,
  useGuestSignIn,
  useGuestSignOut,
} from "~/lib/queries";
import { ErrorLine, Frame, type FrameBrand } from "~/routes/auth-pages";

const day = formatDates({ day: "numeric", month: "long" });

/**
 * The workspace a guest has just signed out of (#668), so the page they land on still wears
 * its brand. Kept in memory only: a fresh load of that page knows no workspace, and shows
 * Hekate's own lockup, as the anonymous pages do (decision 260).
 */
let signedOutOf: FrameBrand | null = null;

/** One answer for every link that no longer works (decision 260), in the frame of them all. */
function LinkGone({ brand = null }: { brand?: FrameBrand | null }) {
  return (
    <Frame
      brand={brand}
      title="This link no longer works"
      intro="It has been used, or it has expired. Ask whoever invited you for a new one."
    >
      {null}
    </Frame>
  );
}

/** What the link asks of its guest, as its arrival page says it: "review Album masters". */
export function arrivalAsk(reviews: GuestArrival["reviews"]): string {
  const [first, ...rest] = reviews;
  if (!first) return "take part in a review";
  const verb = first.kind === "share" ? "look at" : "review";
  return rest.length === 0
    ? `${verb} ${first.title}`
    : `look at ${first.title} and ${rest.length} more`;
}

/**
 * `/guest/:token`: a magic link. Its page greets the guest and spends the link only when they
 * press Continue (#573): a mail scanner that loads the page, scripts and all, leaves it
 * working. Exchanged then, once, for a session in this browser.
 */
export function GuestLinkPage({ token }: { token: string }) {
  const arrival = useQuery(guestArrivalQuery(token));
  const signIn = useGuestSignIn();
  const navigate = useNavigate();
  // Straight to the review when there is one, otherwise to the list.
  const arrive = (me: GuestSignedIn) => {
    const [only] = me.reviews.filter((r) => r.status === "open");
    if (only && me.reviews.length === 1) {
      void navigate({ to: "/g/reviews/$reviewId", params: { reviewId: only.id }, replace: true });
    } else void navigate({ to: "/g", replace: true });
  };
  const brand: FrameBrand | null = arrival.data
    ? { name: arrival.data.organisation ?? "Workspace", branding: arrival.data.branding }
    : null;
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
  const refused = arrival.error ?? signIn.error;
  if (refused) {
    // A link that is spent or gone gets the one answer; anything else may be tried again.
    if (refused instanceof ApiError && refused.code === "link_gone")
      return <LinkGone brand={signIn.error ? brand : null} />;
    return (
      <Frame brand={brand} title="Opening your review" intro={failureText(refused)}>
        <Button
          variant="secondary"
          size="lg"
          onClick={() => {
            signIn.reset();
            void arrival.refetch();
          }}
        >
          Try again
        </Button>
      </Frame>
    );
  }
  if (!arrival.data) return <Loading className="mx-auto max-w-[380px] px-4 py-12" />;
  const greeting = arrival.data;
  const asked = `${greeting.organisation ?? "A workspace"} asked you to ${arrivalAsk(greeting.reviews)}.`;
  const until = day.format(new Date(greeting.expiresAt));
  return (
    <Frame
      brand={brand}
      title="Opening your review"
      intro={
        greeting.verify === "code"
          ? `${asked} To open it, a code goes to the address it was sent to. The link works until ${until}.`
          : `${asked} This link is yours alone and works until ${until}; once opened, it keeps you signed in on this device for a fortnight.`
      }
    >
      <Button
        variant="primary"
        size="lg"
        disabled={signIn.isPending}
        onClick={() =>
          signIn.mutate(token, {
            onSuccess: (data) => {
              if (!("verify" in data)) arrive(data);
            },
          })
        }
      >
        {greeting.verify === "code"
          ? "Email me a code"
          : greeting.guest
            ? `Continue as ${greeting.guest.name}`
            : "Continue"}
      </Button>
    </Frame>
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
    return <LinkGone brand={brand} />;
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

/**
 * `/guest`: where a guest without a session lands, signed out or never in (#574). Their old
 * link is spent, so it sends them to whoever invited them, never back to that link.
 */
export function GuestSignedOutPage() {
  return (
    <Frame
      brand={signedOutOf}
      title="You are signed out"
      intro="Ask whoever invited you for a new link."
    >
      {null}
    </Frame>
  );
}

/** Who the guest is and who asked them, opening the one thing they may do there: sign out. */
function GuestAccount({ me }: { me: GuestMe }) {
  const signOut = useGuestSignOut();
  const navigate = useNavigate();
  const [open, setOpen, box] = usePopover();
  const [confirm, confirmation] = useConfirm();
  const brand: FrameBrand = { name: me.organisation ?? "Workspace", branding: me.branding };
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${me.guest.name}, account`}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2.5 rounded-control py-1 pr-1 pl-2 text-left transition-colors hover:bg-raised"
      >
        <span className="hidden min-w-0 flex-col items-end leading-tight @3xl/app:flex">
          <span className="truncate text-[13px] text-ink">{me.guest.name}</span>
          {me.organisation && (
            <span className="truncate text-[12px] text-ink-3">{me.organisation}</span>
          )}
        </span>
        <Avatar person={me.guest.id} name={me.guest.name} size={28} />
      </button>
      {open && (
        <MenuList
          anchor={box}
          label="Account"
          onClose={() => setOpen(false)}
          actions={[
            { heading: me.guest.email },
            {
              label: "Sign out…",
              onSelect: () =>
                confirm({
                  title: "Sign out?",
                  description: "You will need a new link from whoever invited you to come back.",
                  action: "Sign out",
                  onConfirm: () =>
                    signOut.mutateAsync(undefined, {
                      onSuccess: () => {
                        signedOutOf = brand;
                        void navigate({ to: "/guest" });
                      },
                    }),
                }),
            },
          ]}
        />
      )}
      {confirmation}
    </div>
  );
}

/** The frame around a guest's pages: who they are, for whom, and signing out. */
export function GuestShell({ children }: { children: ReactNode }) {
  const { data: me } = useQuery(guestMeQuery);
  // The workspace's accent and logo (#185) on every page a guest sees.
  useBrandAccent(me?.branding?.accent);
  const logo = me?.branding?.logo;
  return (
    <GuestFrame
      logo={logo ? { ...logo, name: me?.organisation ?? "Workspace" } : null}
      account={me ? <GuestAccount me={me} /> : null}
    >
      {/* Dates redraw once the workspace's format (#481) is known. */}
      <Fragment key={localeKey()}>{children}</Fragment>
    </GuestFrame>
  );
}

/** `/g`: the reviews a guest has been asked to take part in. */
export function GuestHomePage() {
  const { data: me, error, refetch } = useQuery(guestMeQuery);
  // Never a blank page (#545): the list's shape while it comes, and a way on if it cannot.
  if (error) return <Failed what="Your reviews" error={error} retry={refetch} />;
  if (!me) return <Loading className="mx-auto max-w-3xl px-4 py-8 sm:px-8" />;
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
