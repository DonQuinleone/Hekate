import { Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Lockup } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { organisation } from "~/data";
import { useViewer } from "~/viewer/context";

function Frame({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-[380px] flex-col gap-8">
        <Lockup size={22} />
        <div>
          <h1 className="text-[24px] leading-[30px] font-medium tracking-[-0.015em]">{title}</h1>
          {intro && <p className="mt-2 text-ink-2">{intro}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  type = "text",
  placeholder,
  autoComplete,
}: {
  label: string;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <label htmlFor={id} className="flex flex-col gap-1.5 text-[14px] text-ink-2">
      {label}
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="h-10 rounded-control border border-edge bg-ground px-3 text-[14px] text-ink shadow-1 placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
      />
    </label>
  );
}

/** Sign in: what the organisation allows. Here: password, passkey and single sign-on. */
export function SignInPage() {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const refused = settings.state === "failed" || settings.state === "refused";
  const ssoOnly = settings.state === "expired";
  return (
    <Frame title="Sign in" intro="Review for sound and picture.">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setPersona("owner");
          navigate({ to: "/" });
        }}
      >
        {ssoOnly ? (
          <p className="rounded-panel border border-line bg-raised/40 px-4 py-3 text-[14px] text-ink-2">
            {organisation.name} signs in through its identity provider. Passwords are off for
            members.
          </p>
        ) : (
          <>
            <Field
              label="Email"
              type="email"
              autoComplete="username"
              placeholder="you@example.com"
            />
            <Field label="Password" type="password" autoComplete="current-password" />
            {refused && (
              <p className="text-[14px] text-signal">
                {settings.state === "failed"
                  ? "Too many attempts. Wait a minute before trying again."
                  : "That email and password do not match."}
              </p>
            )}
            <Button type="submit" variant="primary" size="lg">
              Sign in
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="gap-2"
          onClick={() => navigate({ to: "/" })}
        >
          <Icon name="key" />
          Sign in with a passkey
        </Button>
        <Button type="button" variant="secondary" size="lg" onClick={() => navigate({ to: "/" })}>
          Continue with Endless Hall SSO
        </Button>
      </form>
      <p className="border-t border-line pt-4 text-[13px] text-ink-3">
        Accounts are by invitation. Guests reviewing a file open the link in their email instead.
      </p>
    </Frame>
  );
}

/** A guest opens the link in their email: it signs them in, or asks for a code first. */
export function GuestLinkPage() {
  const navigate = useNavigate();
  const { settings, setPersona } = useViewer();
  const state = settings.state;
  if (state === "expired" || state === "refused" || state === "failed") {
    const copy = {
      expired: [
        "This link has expired",
        "Links last three days. Ask whoever sent it for a new one; it will come from Hekate by email.",
      ],
      refused: [
        "This link has already been used",
        "Each link works once. If that was not you, ask whoever sent it to send a new one, which revokes this one.",
      ],
      failed: [
        "This review is closed to you",
        "Your access window has ended, or the review was cancelled. The organisation can open it again.",
      ],
    }[state];
    return (
      <Frame title={copy[0] ?? ""} intro={copy[1]}>
        <Button variant="secondary" size="lg" asChild>
          <Link to="/guest">Back</Link>
        </Button>
      </Frame>
    );
  }
  if (organisation.guestVerification === "code" || state === "processing") {
    return (
      <Frame
        title="Check your email"
        intro="A six-digit code has been sent to the address the review was sent to. It lasts ten minutes."
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPersona("guest");
            navigate({ to: "/g/reviews/$reviewId", params: { reviewId: "rev-masters" } });
          }}
        >
          <Field label="Code" placeholder="000 000" autoComplete="one-time-code" />
          <Button type="submit" variant="primary" size="lg">
            Open the review
          </Button>
          <button type="button" className="text-left text-[13px] text-ink-3 hover:text-ink">
            Send another code
          </button>
        </form>
      </Frame>
    );
  }
  return (
    <Frame
      title="Opening your review"
      intro={`${organisation.name} asked you to review Album masters. This link is yours alone and lasts a fortnight once opened.`}
    >
      <Button
        variant="primary"
        size="lg"
        onClick={() => {
          setPersona("guest");
          navigate({ to: "/g/reviews/$reviewId", params: { reviewId: "rev-masters" } });
        }}
      >
        Continue as Mira Solberg
      </Button>
    </Frame>
  );
}

export function GuestSignedOutPage() {
  return (
    <Frame
      title="Open the link in your email"
      intro="Reviews are reached through the link you were sent. It signs you in on this device; there is no password."
    >
      <Button variant="secondary" size="lg" asChild>
        <Link to="/guest/link">Open the sample link</Link>
      </Button>
    </Frame>
  );
}
