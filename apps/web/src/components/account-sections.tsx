import { type Density, locales, preRolls, skipSteps, type Theme } from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { shortAgent } from "~/lib/agent";
import { authClient } from "~/lib/auth";
import { ago } from "~/lib/comments";
import { applyDensity } from "~/lib/density";
import { languageNames } from "~/lib/locale";
import {
  meQuery,
  sessionsQuery,
  useDeleteAccount,
  usePreferences,
  useSavePreferences,
  useSignOutSession,
  useUpdateProfile,
} from "~/lib/queries";
import { applyTheme, themeChoices } from "~/lib/theme";
import { Avatar } from "./avatar";
import { CodeAppSetup, RecoveryCodes } from "./second-factor";
import { Danger, Row, Section, SwitchRow } from "./settings";
import { Button } from "./ui/button";
import { Choice } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Input, Select } from "./ui/input";
import { StatusDot } from "./ui/status";

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
  const workspaceLocale = me.organisations.find((o) => o.id === me.activeOrganisationId)?.locale;
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
            <option value="">
              {workspaceLocale
                ? `As the workspace has it (${languageNames.of(workspaceLocale) ?? workspaceLocale})`
                : "As the browser has it"}
            </option>
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
      <DeleteAccount email={me.user.email} />
    </>
  );
}

/**
 * Deleting the account, at the foot of the page. What you wrote and decided stays, as a former
 * member's; the address typed out and the password confirm it.
 */
function DeleteAccount({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const remove = useDeleteAccount();
  const client = useQueryClient();
  const navigate = useNavigate();
  const close = () => {
    setOpen(false);
    setTyped("");
    setPassword("");
    remove.reset();
  };
  const matches = typed.trim().toLowerCase() === email.toLowerCase();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    remove.mutate(
      { email: typed, password },
      {
        onSuccess: async () => {
          client.clear();
          await navigate({ to: "/sign-in", search: {} });
        },
      },
    );
  };
  return (
    <Danger>
      <Row
        name="Delete your account"
        hint="Your comments and decisions stay, attributed to a former member."
      >
        <Button size="sm" variant="secondary" className="text-signal" onClick={() => setOpen(true)}>
          Delete…
        </Button>
      </Row>
      {open && (
        <Dialog
          title="Delete your account"
          description="You are signed out everywhere and cannot sign in again. Your name and address leave every workspace; what you wrote and decided stays, as a former member's. This cannot be undone."
          onClose={close}
          width="sm"
        >
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="delete-email" className="label">
                Type {email} to confirm
              </label>
              <Input
                id="delete-email"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="delete-password" className="label">
                Password
              </label>
              <Input
                id="delete-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {remove.error && <Note error>{remove.error.message}</Note>}
            <span className="flex justify-end gap-2">
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="secondary"
                className="text-signal"
                disabled={!matches || !password || remove.isPending}
              >
                {remove.isPending ? "Deleting" : "Delete my account"}
              </Button>
            </span>
          </form>
        </Dialog>
      )}
    </Danger>
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
            <Choice
              checked={everywhere}
              onChange={(e) => setEverywhere(e.target.checked)}
              className="text-[13px] text-ink-2"
            >
              Sign out everywhere else
            </Choice>
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

/** The password asked again before a second factor is removed or its codes replaced. */
function PasswordDialog({
  title,
  description,
  action,
  danger = false,
  run,
  onClose,
}: {
  title: string;
  description: string;
  action: string;
  danger?: boolean;
  run: (password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(await run(password));
    setPending(false);
  };
  return (
    <Dialog title={title} description={description} onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Input
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          placeholder="Password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <Note error>{error}</Note>}
        <span className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={danger ? "secondary" : "primary"}
            className={danger ? "text-signal" : undefined}
            disabled={pending || !password}
          >
            {action}
          </Button>
        </span>
      </form>
    </Dialog>
  );
}

/**
 * The second factor: a code app, and the recovery codes that stand in for it. Removing it, or
 * replacing the codes, asks for the password again.
 */
export function SecondFactorSection() {
  const client = useQueryClient();
  const { data: me } = useQuery(meQuery);
  const [open, setOpen] = useState<"add" | "remove" | "codes" | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!me) return null;
  const { enabled, required, recoveryCodesLeft } = me.secondFactor;
  const close = () => setOpen(null);
  const refresh = () => client.invalidateQueries({ queryKey: ["me"] });
  const wrongPassword = (status: number) =>
    status === 400 ? "That password is not right." : "That did not go through.";
  return (
    <>
      <Section
        title="Second factor"
        intro="A code from an app on your phone, asked for after your password. Passkeys and security keys arrive here too."
      >
        <Row
          name="Code app"
          hint={
            enabled
              ? "On. Asked for at each sign-in, except in browsers you trust."
              : required
                ? "This workspace asks for one."
                : "Off. Any authenticator app works."
          }
        >
          {enabled ? (
            <Button size="sm" variant="ghost" onClick={() => setOpen("remove")}>
              Remove…
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setOpen("add")}>
              Set up…
            </Button>
          )}
        </Row>
      </Section>
      {enabled && (
        <Section
          title="Recovery codes"
          intro="Ten single-use codes for when your phone is lost. Keep them somewhere else."
        >
          <Row
            name={`${recoveryCodesLeft} of 10 unused`}
            hint={
              recoveryCodesLeft <= 3
                ? "Few left: generate new ones, which replace these."
                : "New ones replace these."
            }
          >
            <Button size="sm" variant="secondary" onClick={() => setOpen("codes")}>
              Generate new ones…
            </Button>
          </Row>
        </Section>
      )}
      {open === "add" && (
        <CodeAppSetup
          onCancel={close}
          onDone={close}
          shell={({ title, intro, body }) => (
            <Dialog title={title} description={intro} onClose={close} width="sm">
              {body}
            </Dialog>
          )}
        />
      )}
      {open === "remove" && (
        <PasswordDialog
          title="Remove the code app"
          description={
            required
              ? "This workspace asks for a second factor: you will be asked to add one again before you can carry on. Your recovery codes stop working."
              : "Sign-in will ask for your password alone. Your recovery codes stop working."
          }
          action="Remove"
          danger
          onClose={close}
          run={async (password) => {
            const { error } = await authClient.twoFactor.disable({ password });
            if (error) return wrongPassword(error.status);
            close();
            await refresh();
            return null;
          }}
        />
      )}
      {open === "codes" && !codes && (
        <PasswordDialog
          title="Generate new recovery codes"
          description="The codes you have now stop working."
          action="Generate"
          onClose={close}
          run={async (password) => {
            const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
            if (error || !data) return wrongPassword(error?.status ?? 0);
            setCodes(data.backupCodes);
            await refresh();
            return null;
          }}
        />
      )}
      {codes && (
        <Dialog
          title="Keep your recovery codes"
          description="Each signs you in once if your phone is lost. They are not shown again."
          width="sm"
          onClose={() => {
            setCodes(null);
            close();
          }}
        >
          <div className="flex flex-col gap-5">
            <RecoveryCodes codes={codes} />
            <span className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => {
                  setCodes(null);
                  close();
                }}
              >
                I have kept them
              </Button>
            </span>
          </div>
        </Dialog>
      )}
    </>
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

/**
 * What appears on the recording page and how the player behaves, for you alone. The project
 * decides which tools you may have; this is which of them you want to see.
 */
export function AppearanceSection() {
  const preferences = usePreferences();
  const save = useSavePreferences();
  const choose = (theme: Theme) => {
    applyTheme(theme);
    save.mutate({ theme });
  };
  return (
    <>
      <Section title="Theme">
        <Row name="Theme" hint="The brand in dark and light, and a few others people know." stacked>
          <div className="grid w-full grid-cols-1 gap-2 @xl/app:grid-cols-2 @3xl/app:grid-cols-3">
            <ThemeTile
              name="Follow the system"
              colours={["#0a0a0b", "#f4f4f2"]}
              split
              on={preferences.theme === "system"}
              onChoose={() => choose("system")}
            />
            {themeChoices.map((t) => (
              <ThemeTile
                key={t.id}
                name={t.name}
                colours={t.colours}
                on={preferences.theme === t.id}
                onChoose={() => choose(t.id)}
              />
            ))}
          </div>
        </Row>
        <Row name="Density" hint="How much room each row of a list takes, everywhere.">
          <Select
            aria-label="Density"
            className="w-40"
            value={preferences.density}
            onChange={(e) => {
              const density = e.target.value as Density;
              applyDensity(density);
              save.mutate({ density });
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </Select>
        </Row>
      </Section>
      <Section title="Tools shown">
        <SwitchRow
          name="Spectrogram in the View menu"
          checked={preferences.showSpectrogram}
          onChange={(showSpectrogram) => save.mutate({ showSpectrogram })}
        />
        <SwitchRow
          name="Split channels when a recording opens"
          hint="Each channel in its own lane; a browser keeps its own choice once you change it there."
          checked={preferences.splitChannels}
          onChange={(splitChannels) => save.mutate({ splitChannels })}
        />
        <SwitchRow
          name="Loudness monitoring"
          hint="The loudness meters and their history on the QA view."
          checked={preferences.showLoudness}
          onChange={(showLoudness) => save.mutate({ showLoudness })}
        />
      </Section>
      <Section title="Player">
        <Row name="Skip by" hint="How far the arrow keys move the playhead.">
          <Select
            aria-label="Skip by"
            className="w-32"
            value={String(preferences.skipSeconds)}
            onChange={(e) =>
              save.mutate({ skipSeconds: Number(e.target.value) as (typeof skipSteps)[number] })
            }
          >
            {skipSteps.map((n) => (
              <option key={n} value={n}>
                {n} s
              </option>
            ))}
          </Select>
        </Row>
        <Row name="Before a comment" hint="How much plays before the moment a comment marks.">
          <Select
            aria-label="Before a comment"
            className="w-32"
            value={String(preferences.preRoll)}
            onChange={(e) =>
              save.mutate({ preRoll: Number(e.target.value) as (typeof preRolls)[number] })
            }
          >
            {preRolls.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "None" : `${n} s`}
              </option>
            ))}
          </Select>
        </Row>
        {save.error && (
          <div className="px-4 py-2">
            <Note error>{save.error.message}</Note>
          </div>
        )}
      </Section>
    </>
  );
}

/** One theme to choose: a swatch of its ground, signal and ink, and its name. */
function ThemeTile({
  name,
  colours,
  on,
  split = false,
  onChoose,
}: {
  name: string;
  colours: string[];
  on: boolean;
  /** Half dark, half light, for following the system. */
  split?: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onChoose}
      className={
        on
          ? "flex items-center gap-3 rounded-panel border border-signal/60 bg-signal/[0.06] p-2.5 text-left"
          : "flex items-center gap-3 rounded-panel border border-line p-2.5 text-left transition-colors hover:border-edge"
      }
    >
      {/* The swatch shows the theme's own colours, which are data here rather than chrome. */}
      <span
        aria-hidden="true"
        className="flex h-9 w-14 shrink-0 overflow-hidden rounded-[5px] shadow-1"
        style={{
          background: split
            ? `linear-gradient(135deg, ${colours[0]} 50%, ${colours[1]} 50%)`
            : colours[0],
        }}
      >
        {!split && (
          <span className="m-auto flex gap-1">
            <span className="size-2.5 rounded-full" style={{ background: colours[1] }} />
            <span className="size-2.5 rounded-full" style={{ background: colours[2] }} />
          </span>
        )}
      </span>
      <span className="text-[13px] text-ink">{name}</span>
    </button>
  );
}
