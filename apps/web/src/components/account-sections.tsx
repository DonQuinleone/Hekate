import { locales } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { shortAgent } from "~/lib/agent";
import { authClient } from "~/lib/auth";
import { ago } from "~/lib/comments";
import { meQuery, sessionsQuery, useSignOutSession, useUpdateProfile } from "~/lib/queries";
import { Avatar } from "./avatar";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import { StatusDot } from "./ui/status";

const languageNames = new Intl.DisplayNames(["en-GB"], { type: "language" });
const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
})();

/** A place to say what happened, or what went wrong. */
function Note({ error, children }: { error?: boolean; children: string }) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={error ? "m-0 text-[12px] text-signal" : "m-0 text-[12px] text-ink-2"}
    >
      {children}
    </p>
  );
}

/** The name, kept when it changes and saved with a button, as a settings field does. */
function NameField({ name }: { name: string }) {
  const update = useUpdateProfile();
  const [value, setValue] = useState(name);
  const changed = value.trim() !== name && value.trim().length > 0;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) update.mutate({ name: value.trim() });
      }}
    >
      <Input
        aria-label="Name"
        className="w-64"
        maxLength={120}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {changed && (
        <Button size="sm" type="submit" disabled={update.isPending}>
          Save
        </Button>
      )}
      {update.error && <Note error>{update.error.message}</Note>}
    </form>
  );
}

/** A new address, which takes effect once the link sent to it is followed. */
function EmailField({ email }: { email: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    const { error: failed } = await authClient.changeEmail({
      newEmail: value.trim(),
      callbackURL: "/account/account",
    });
    setPending(false);
    if (failed) setError(failed.message ?? "The address could not be changed");
    else {
      setSent(value.trim());
      setEditing(false);
      setValue("");
    }
  };
  if (!editing)
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-ink">{email}</span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Change…
        </Button>
        {sent && <Note>{`Check ${sent} for a link. The address changes once you follow it.`}</Note>}
      </span>
    );
  return (
    <form onSubmit={send} className="flex flex-wrap items-center gap-2">
      <Input
        autoFocus
        type="email"
        aria-label="New email address"
        placeholder="New address"
        className="w-64"
        maxLength={254}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
      />
      <Button size="sm" type="submit" disabled={pending || !value.includes("@")}>
        Send a link
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <Note error>{error}</Note>}
    </form>
  );
}

/** Who you are to Hekate: picture, name, address, language, time zone, and workspaces. */
export function ProfileSection() {
  const { data: me } = useQuery(meQuery);
  const update = useUpdateProfile();
  if (!me) return null;
  const { user } = me;
  return (
    <>
      <Section title="You">
        <Row name="Picture" hint="Made from your name and its colour.">
          <Avatar id={user.id} name={user.name} size={36} />
        </Row>
        <Row name="Name">
          <NameField key={user.name} name={user.name} />
        </Row>
        <Row name="Email" hint="Sign-in mail and notifications go here.">
          <EmailField email={user.email} />
        </Row>
        <Row name="Language" hint="How dates and numbers read.">
          <Select
            aria-label="Language"
            className="w-56"
            value={user.locale ?? ""}
            onChange={(e) =>
              update.mutate({ locale: (e.target.value || null) as (typeof locales)[number] | null })
            }
          >
            <option value="">As the browser has it</option>
            {locales.map((l) => (
              <option key={l} value={l}>
                {languageNames.of(l) ?? l}
              </option>
            ))}
          </Select>
        </Row>
        <Row name="Time zone" hint="When things happened, and when they are due.">
          <Select
            aria-label="Time zone"
            className="w-56"
            value={user.timeZone ?? ""}
            onChange={(e) => update.mutate({ timeZone: e.target.value || null })}
          >
            <option value="">As the browser has it</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Row>
        <Row
          name="Workspaces"
          hint={me.organisations.map((o) => `${o.name} (${o.role})`).join(", ")}
        />
        {update.error && (
          <div className="px-4 py-2">
            <Note error>{update.error.message}</Note>
          </div>
        )}
      </Section>
      <PasswordSection />
    </>
  );
}

/** A new password, with the current one to prove it is you. */
function PasswordSection() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [everywhere, setEverywhere] = useState(true);
  const [state, setState] = useState<{ done?: boolean; error?: string; pending?: boolean }>({});
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setState({ pending: true });
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: everywhere,
    });
    if (error) setState({ error: error.message ?? "The password could not be changed" });
    else {
      setState({ done: true });
      setOpen(false);
      setCurrent("");
      setNext("");
    }
  };
  return (
    <Section title="Password">
      <Row name="Change password" hint="12 characters or more." stacked={open}>
        {open ? (
          <form onSubmit={save} className="flex w-full flex-col gap-2.5">
            <Input
              type="password"
              autoComplete="current-password"
              aria-label="Current password"
              placeholder="Current password"
              className="w-72"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <Input
              type="password"
              autoComplete="new-password"
              aria-label="New password"
              placeholder="New password"
              className="w-72"
              minLength={12}
              maxLength={256}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <input
                type="checkbox"
                checked={everywhere}
                onChange={(e) => setEverywhere(e.target.checked)}
                className="size-3.5 accent-[var(--hk-ink)]"
              />
              Sign out everywhere else
            </label>
            <span className="flex gap-2">
              <Button
                size="sm"
                type="submit"
                disabled={state.pending || !current || next.length < 12}
              >
                Change password
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </span>
            {state.error && <Note error>{state.error}</Note>}
          </form>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Change…
            </Button>
            {state.done && <Note>Changed.</Note>}
          </span>
        )}
      </Row>
    </Section>
  );
}

/** Every browser and device signed in as you, and a way to sign each out. */
export function SessionsSection() {
  const { data: sessions = [], isPending } = useQuery(sessionsQuery);
  const signOut = useSignOutSession();
  const others = sessions.filter((s) => !s.current);
  return (
    <Section title="Signed in">
      {isPending && <Row name="Loading" />}
      {sessions.map((s) => (
        <Row
          key={s.id}
          name={s.current ? "This browser" : (shortAgent(s.userAgent) ?? "A browser")}
          hint={[
            s.current ? shortAgent(s.userAgent) : null,
            s.ipAddress,
            s.current ? "now" : `last used ${ago(s.lastUsedAt)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {s.current ? (
            <span className="flex items-center gap-2 text-[12px] text-ink-3">
              <StatusDot state="approved" />
              Here
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate(s.id)}
            >
              Sign out
            </Button>
          )}
        </Row>
      ))}
      {others.length > 1 && (
        <Row name="Everywhere else" hint="Signs out every other session.">
          <Button
            size="sm"
            variant="secondary"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate(undefined)}
          >
            Sign out all
          </Button>
        </Row>
      )}
      {signOut.error && (
        <div className="px-4 py-2">
          <Note error>{signOut.error.message}</Note>
        </div>
      )}
    </Section>
  );
}
