import {
  type InstallCheck,
  type InstallState,
  type InstallStep,
  installStepLabels,
  installSteps,
  type MailProvider,
  mailProviderIds,
  mailProviders,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Lockup } from "~/components/brand";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
import { api } from "~/lib/api";
import { cn } from "~/lib/cn";
import { checkCode, codeHeaders, installState, type StepResult, setupCode } from "~/lib/install";
import { ApiError, installQuery, json, setupQuery } from "~/lib/queries";
import { ErrorLine } from "~/routes/auth-pages";

type RailStep = InstallStep | "owner";
const rail: RailStep[] = [...installSteps, "owner"];

/** Why a request failed, in the server's words. */
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong. Try again.";

/**
 * `/setup`: the installer (#127, decision 061). While the server is unconfigured it walks
 * through requirements, database, storage, the master key, mail and the address; then, as on
 * any server without an owner, the first workspace. Each step is tested before it is saved,
 * and a new page picks up where the last one stopped.
 */
export function InstallerPage() {
  const { data: installing } = useQuery(installQuery);
  const [code, setCode] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  // A code kept from earlier in this tab is tried once; the page asks again if it was wrong.
  useEffect(() => {
    const kept = setupCode.get();
    if (!kept || code) return;
    if (installing === false) {
      setCode(kept);
      return;
    }
    if (installing) checkCode(kept).then(() => setCode(kept), setupCode.clear);
  }, [installing, code]);

  if (installing === undefined) return <Layout current={0} />;
  if (created) return <Ready workspace={created} />;
  if (!installing)
    return (
      <Layout current={rail.length - 1}>
        <OwnerStep code={code} onCode={setCode} onCreated={(workspace) => setCreated(workspace)} />
      </Layout>
    );
  if (!code)
    return (
      <Layout current={0}>
        <StepHeading step="requirements" />
        <CodeForm onCode={setCode} />
      </Layout>
    );
  return <Install code={code} onLost={() => setCode(null)} />;
}

/** The steps while the server installs, from the first not yet saved. */
function Install({ code, onLost }: { code: string; onLost: () => void }) {
  const client = useQueryClient();
  const { data: state, error } = useQuery({
    queryKey: ["install-state"],
    queryFn: () => installState(code),
    retry: false,
  });
  const [viewing, setViewing] = useState<InstallStep | null>(null);
  useEffect(() => {
    if (error instanceof ApiError && error.code?.startsWith("setup_code")) {
      setupCode.clear();
      onLost();
    }
  }, [error, onLost]);
  if (!state) return <Layout current={0} />;
  const step = viewing ?? (state.step === "ready" ? "address" : state.step);
  const index = installSteps.indexOf(step);
  const advance = async (next: InstallState | undefined) => {
    if (next) client.setQueryData(["install-state"], next);
    if (index === installSteps.length - 1) {
      // Every step saved: the server checks the whole and starts in full.
      await json(await api.install.finish.$post(undefined, codeHeaders(code)));
      await client.invalidateQueries({ queryKey: installQuery.queryKey });
      await client.invalidateQueries({ queryKey: setupQuery.queryKey });
      return;
    }
    setViewing(installSteps[index + 1] ?? null);
  };
  const back = index > 0 ? () => setViewing(installSteps[index - 1] ?? null) : undefined;
  const props = { code, state, advance, back };
  return (
    <Layout current={index} done={state.done}>
      <StepHeading step={step} />
      {step === "requirements" && <RequirementsStep {...props} />}
      {step === "database" && <DatabaseStep {...props} />}
      {step === "storage" && <StorageStep {...props} />}
      {step === "masterKey" && <MasterKeyStep {...props} />}
      {step === "mail" && <MailStep {...props} />}
      {step === "address" && <AddressStep {...props} />}
    </Layout>
  );
}

interface StepProps {
  code: string;
  state: InstallState;
  advance: (next: InstallState | undefined) => Promise<void>;
  back: (() => void) | undefined;
}

/** The page: the brand and the steps at the left (above, on a phone), the step at the right. */
function Layout({
  current,
  done = [],
  children,
}: {
  current: number;
  done?: readonly InstallStep[];
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-start justify-center px-4 py-12">
      <div className="flex w-full max-w-[880px] flex-col gap-8 @3xl/app:flex-row @3xl/app:gap-16">
        <div className="flex shrink-0 flex-col gap-6 @3xl/app:w-[220px]">
          <Lockup size={22} />
          <ol
            aria-label="Steps"
            className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 @3xl/app:flex-col"
          >
            {rail.map((s, i) => {
              const ticked = i < current || (s !== "owner" && done.includes(s) && i !== current);
              return (
                <li
                  key={s}
                  aria-current={i === current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 text-[14px]",
                    i === current ? "text-ink" : ticked ? "text-ink-2" : "text-ink-3",
                  )}
                >
                  <span
                    className="flex size-5 shrink-0 items-center justify-center"
                    aria-hidden="true"
                  >
                    {i === current ? (
                      <span className="size-3.5 rounded-full bg-signal shadow-[0_0_0_3px_var(--hk-signal-line)]" />
                    ) : ticked ? (
                      <span className="flex size-5 items-center justify-center rounded-full bg-ok text-ground">
                        <Icon name="check" size={12} />
                      </span>
                    ) : (
                      <span className="size-2 rounded-full bg-ink" />
                    )}
                  </span>
                  {installStepLabels[s]}
                  {ticked && <span className="sr-only"> (done)</span>}
                </li>
              );
            })}
          </ol>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </div>
  );
}

function StepHeading({ step }: { step: RailStep }) {
  return (
    <div>
      <p className="eyebrow m-0">
        Step {rail.indexOf(step) + 1} of {rail.length}
      </p>
      <h1 className="m-0 mt-1 text-[24px] leading-[30px] font-medium tracking-[-0.015em]">
        {installStepLabels[step]}
      </h1>
    </div>
  );
}

/** A checklist: each line met, short, or worth knowing (by the dot's fill, as QA shows it). */
function Checks({ checks }: { checks: readonly InstallCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 p-0">
      {checks.map((c) => (
        <li key={c.name} className="flex items-center gap-3 px-4 py-2.5 text-[14px]">
          <span
            aria-hidden="true"
            className={cn(
              "inline-block size-[7px] shrink-0 rounded-full",
              c.state === "ok" && "bg-ok",
              c.state === "warn" && "border-[1.5px] border-signal",
              c.state === "fail" && "bg-signal",
            )}
          />
          <span className="flex-1 text-ink">
            {c.name}
            <span className="sr-only">
              {c.state === "ok" ? ": met" : c.state === "warn" ? ": warning" : ": not met"}
            </span>
          </span>
          <span
            className={cn(
              // A long path breaks anywhere rather than widening the page.
              "min-w-0 text-right [overflow-wrap:anywhere]",
              c.state === "fail" ? "text-signal" : c.state === "warn" ? "text-ink-2" : "text-ink-3",
            )}
          >
            {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Back, and the step's one primary action. */
function Footer({
  back,
  label = "Continue",
  pending,
  disabled,
}: {
  back: (() => void) | undefined;
  label?: string;
  pending: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {back && (
        <Button type="button" variant="ghost" size="lg" onClick={back}>
          Back
        </Button>
      )}
      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="ml-auto"
        disabled={pending || disabled}
      >
        {pending ? "Checking" : label}
      </Button>
    </div>
  );
}

// A path in a note breaks anywhere rather than widening the page on a phone.
const Note = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-[13px] text-ink-3 [overflow-wrap:anywhere]">{children}</p>
);

/** Shown in place of a field the environment sets: what it is, and where to change it. */
function Fixed({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
      {label}
      <span className="tabular truncate rounded-control border border-line bg-raised/40 px-3 py-2 text-[14px] text-ink">
        {value}
      </span>
      <span className="text-[12px] text-ink-3">Set in the environment; change it there.</span>
    </div>
  );
}

/** Runs a step's request, keeping its checks and what went wrong. */
function useStep() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<InstallCheck[]>([]);
  const run = async (request: () => Promise<Response>): Promise<StepResult | null> => {
    setPending(true);
    setError(null);
    try {
      const result = await json<StepResult>(await request());
      setChecks(result.checks);
      return result;
    } catch (e) {
      setError(messageOf(e));
      return null;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, setError, checks, run };
}

function CodeForm({ onCode }: { onCode: (code: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await checkCode(value);
      setupCode.set(value);
      onCode(value);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="m-0 text-[14px] text-ink-2">
        Hekate printed a setup code when it started, so only whoever runs the server can set it up.
      </p>
      <Field label="Setup code" hint="In the server's log: docker compose logs app" error={error}>
        <Input
          name="code"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          className="tabular h-10 max-w-[240px] tracking-[0.08em]"
          autoFocus
        />
      </Field>
      <Footer back={undefined} pending={pending} disabled={value.trim().length < 12} />
    </form>
  );
}

function RequirementsStep({ code, advance, back }: StepProps) {
  const { data } = useQuery({
    queryKey: ["install-requirements"],
    queryFn: async () =>
      json<{ checks: InstallCheck[] }>(
        await api.install.checks.requirements.$get(undefined, codeHeaders(code)),
      ),
  });
  const step = useStep();
  const blocked = data?.checks.some((c) => c.state === "fail") ?? true;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await step.run(() =>
          api.install.steps.requirements.$post(undefined, codeHeaders(code)),
        );
        if (result) await advance(result.state);
      }}
    >
      {data ? <Checks checks={data.checks} /> : <Note>Checking…</Note>}
      <Note>
        Everything here comes from the image or the host; change it there and reload this page.
      </Note>
      <ErrorLine message={step.error} />
      <Footer back={back} pending={step.pending} disabled={blocked} />
    </form>
  );
}

function DatabaseStep({ code, state, advance, back }: StepProps) {
  const fixed = state.fixed.includes("database");
  const [url, setUrl] = useState("");
  const step = useStep();
  const tested = step.checks.length > 0;
  const test = () =>
    step.run(() =>
      api.install.steps.database.$post({ json: fixed ? {} : { url } }, codeHeaders(code)),
    );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = tested ? { state: undefined } : await test();
        if (result) await advance(result.state);
      }}
    >
      {fixed ? (
        <Fixed label="Connection" value={state.database.url ?? ""} />
      ) : (
        <Field label="Connection" hint="A role of its own, owning one database.">
          <Input
            name="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="postgres://hekate:secret@db:5432/hekate"
            autoComplete="off"
            spellCheck={false}
            className="h-10"
          />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="md" onClick={test} disabled={step.pending}>
          Test the connection
        </Button>
      </div>
      <Checks checks={step.checks} />
      <Note>
        The tables are made now, and brought up to date on every upgrade; the job queue lives here
        too.
      </Note>
      <ErrorLine message={step.error} />
      <Footer back={back} pending={step.pending} />
    </form>
  );
}

function StorageStep({ code, state, advance, back }: StepProps) {
  const fixed = state.fixed.includes("storage");
  const [kind, setKind] = useState<"local" | "s3">(state.storage.kind);
  const [path, setPath] = useState(
    state.storage.kind === "local" ? (state.storage.path ?? "/data/storage") : "/data/storage",
  );
  const [s3, setS3] = useState({
    endpoint: state.storage.kind === "s3" ? (state.storage.endpoint ?? "") : "",
    bucket: state.storage.kind === "s3" ? state.storage.bucket : "",
    region: state.storage.kind === "s3" ? (state.storage.region ?? "") : "",
    accessKeyId: "",
    secretAccessKey: "",
    forcePathStyle: false,
  });
  const step = useStep();
  const tested = step.checks.length > 0;
  const pathFixed = state.storage.kind === "local" && state.storage.pathFixed;
  const test = () =>
    step.run(() =>
      api.install.steps.storage.$post(
        {
          json:
            kind === "local"
              ? { kind, ...(pathFixed ? {} : { path }) }
              : {
                  kind,
                  bucket: s3.bucket,
                  region: s3.region,
                  forcePathStyle: s3.forcePathStyle,
                  ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
                  ...(s3.accessKeyId ? { accessKeyId: s3.accessKeyId } : {}),
                  ...(s3.secretAccessKey ? { secretAccessKey: s3.secretAccessKey } : {}),
                },
        },
        codeHeaders(code),
      ),
    );
  const set = (name: keyof typeof s3) => (e: { target: { value: string } }) =>
    setS3({ ...s3, [name]: e.target.value });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = tested ? { state: undefined } : await test();
        if (result) await advance(result.state);
      }}
    >
      {fixed ? (
        <Fixed
          label="Backend"
          value={
            state.storage.kind === "s3"
              ? `S3-compatible · ${state.storage.bucket}`
              : `Local disk · ${state.storage.path ?? ""}`
          }
        />
      ) : (
        <>
          <Field label="Backend">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as "local" | "s3")}
              className="h-10"
            >
              <option value="local">Local disk</option>
              <option value="s3">S3-compatible</option>
            </Select>
          </Field>
          {kind === "local" ? (
            pathFixed ? (
              <Fixed label="Path" value={path} />
            ) : (
              <Field label="Path" hint="On a volume of its own, with room to grow.">
                <Input value={path} onChange={(e) => setPath(e.target.value)} className="h-10" />
              </Field>
            )
          ) : (
            <>
              <Field
                label="Endpoint"
                hint="The address of an S3-compatible service. Leave empty for Amazon S3 itself."
              >
                <Input
                  value={s3.endpoint}
                  onChange={set("endpoint")}
                  placeholder="https://s3.eu-west-2.amazonaws.com"
                  className="h-10"
                />
              </Field>
              <div className="grid gap-4 @md/app:grid-cols-2">
                <Field label="Bucket">
                  <Input value={s3.bucket} onChange={set("bucket")} className="h-10" />
                </Field>
                <Field label="Region">
                  <Input
                    value={s3.region}
                    onChange={set("region")}
                    placeholder="eu-west-2"
                    className="h-10"
                  />
                </Field>
              </div>
              <div className="grid gap-4 @md/app:grid-cols-2">
                <Field label="Access key">
                  <Input
                    value={s3.accessKeyId}
                    onChange={set("accessKeyId")}
                    autoComplete="off"
                    className="h-10"
                  />
                </Field>
                <Field label="Secret">
                  <Input
                    type="password"
                    value={s3.secretAccessKey}
                    onChange={set("secretAccessKey")}
                    autoComplete="off"
                    className="h-10"
                  />
                </Field>
              </div>
              <span className="flex items-center gap-2 text-[14px] text-ink">
                <Checkbox
                  id="path-style"
                  checked={s3.forcePathStyle}
                  onChange={(e) => setS3({ ...s3, forcePathStyle: e.target.checked })}
                />
                <label htmlFor="path-style">Path-style addresses (most self-hosted services)</label>
              </span>
            </>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="md" onClick={test} disabled={step.pending}>
          Write and read a test object
        </Button>
      </div>
      <Checks checks={step.checks} />
      <Note>
        Every object is encrypted with its own key before it is written; the backend only ever holds
        ciphertext.
      </Note>
      <ErrorLine message={step.error} />
      <Footer back={back} pending={step.pending} />
    </form>
  );
}

/** 32 random bytes from the browser, base64: the key never has to come from the server. */
const newMasterKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
};

function MasterKeyStep({ code, state, advance, back }: StepProps) {
  const fixed = state.fixed.includes("masterKey");
  const [mode, setMode] = useState<"generate" | "own">("generate");
  const [generated] = useState(newMasterKey);
  const [own, setOwn] = useState("");
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const step = useStep();
  const save = () => {
    const blob = new Blob([`Hekate master key (MASTER_KEY)\n${generated}\n`], {
      type: "text/plain",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hekate-master-key.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const key = fixed ? undefined : mode === "generate" ? generated : own.trim();
        const result = await step.run(() =>
          api.install.steps["master-key"].$post(
            { json: { ...(key ? { key } : {}), stored: true } },
            codeHeaders(code),
          ),
        );
        if (result) await advance(result.state);
      }}
    >
      <p className="m-0 text-[14px] text-ink-2">
        The master key wraps every file key. Lose it and the files are gone with it; keep a copy
        where the server cannot reach it.
      </p>
      {fixed ? (
        <Note>The environment gives the master key (MASTER_KEY); nothing is written here.</Note>
      ) : (
        <>
          <Segmented
            label="Master key"
            value={mode}
            onChange={setMode}
            options={[
              { value: "generate", label: "Generate one now" },
              { value: "own", label: "I have one" },
            ]}
            className="self-start"
          />
          {mode === "generate" ? (
            <>
              <div className="flex items-center gap-2 rounded-panel border border-line bg-sunken py-1.5 pr-1.5 pl-4 text-[13px] text-ink">
                <span
                  data-testid="master-key"
                  className="tabular min-w-0 flex-1 truncate font-mono"
                >
                  {generated}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await navigator.clipboard?.writeText(generated);
                    setCopied(true);
                  }}
                >
                  <Icon name="copy" size={13} />
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={save}>
                  <Icon name="download" size={13} />
                  Save
                </Button>
              </div>
              <Note>
                Made in this browser and shown once. The installer keeps it in the settings file (
                {state.settingsFile}), readable by the server alone.
              </Note>
            </>
          ) : (
            <Field label="Master key" hint="44 characters, from your password manager or vault.">
              <Input
                type="password"
                value={own}
                onChange={(e) => setOwn(e.target.value)}
                autoComplete="off"
                className="h-10"
              />
            </Field>
          )}
        </>
      )}
      <span className="flex items-center gap-2 text-[14px] text-ink">
        <Checkbox id="stored" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        <label htmlFor="stored">
          I have stored the master key somewhere the server cannot reach
        </label>
      </span>
      <ErrorLine message={step.error} />
      <Footer
        back={back}
        pending={step.pending}
        disabled={!stored || (!fixed && mode === "own" && own.trim().length < 44)}
      />
    </form>
  );
}

function MailStep({ code, state, advance, back }: StepProps) {
  const fixed = state.fixed.includes("mail");
  const [mail, setMail] = useState({
    provider: state.mail.provider as MailProvider,
    host: state.mail.host ?? "",
    port: String(state.mail.port ?? mailProviders[state.mail.provider].port ?? 587),
    username: "",
    password: "",
    tenant: state.mail.tenant ?? "",
    clientId: state.mail.clientId ?? "",
    url: state.mail.url ?? "",
    from: state.mail.from ?? `Hekate <hekate@${window.location.hostname}>`,
  });
  const [to, setTo] = useState("");
  /** The settings a test message last went out with: only those can be saved. */
  const [tested, setTested] = useState<string | null>(null);
  const test = useStep();
  const step = useStep();
  const preset = mailProviders[mail.provider];
  const smtp = preset.transport === "smtp";
  // Only what the provider's way of sending takes (#71).
  const body = () => ({
    provider: mail.provider,
    from: mail.from,
    ...(smtp && !preset.host && mail.host ? { host: mail.host } : {}),
    ...(smtp && mail.port ? { port: Number(mail.port) } : {}),
    ...(smtp && !preset.username && mail.username ? { username: mail.username } : {}),
    ...(preset.transport !== "log" && mail.password ? { password: mail.password } : {}),
    ...(preset.transport === "microsoft" ? { tenant: mail.tenant, clientId: mail.clientId } : {}),
    ...(preset.transport === "mailcoach" ? { url: mail.url } : {}),
  });
  const set = (name: keyof typeof mail) => (e: { target: { value: string } }) =>
    setMail({ ...mail, [name]: e.target.value });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await step.run(() =>
          api.install.steps.mail.$post({ json: body() }, codeHeaders(code)),
        );
        if (result) await advance(result.state);
      }}
    >
      {fixed ? (
        <Fixed
          label="Mail"
          value={[
            state.mail.host
              ? `${state.mail.host}:${state.mail.port ?? ""}`
              : (state.mail.url ??
                (state.mail.tenant
                  ? `${mailProviders.microsoft.label} · ${state.mail.tenant}`
                  : "")),
            state.mail.from ?? "",
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      ) : (
        <>
          <Field label="Provider">
            <Select
              value={mail.provider}
              onChange={(e) => {
                const provider = e.target.value as MailProvider;
                setMail({
                  ...mail,
                  provider,
                  port: String(mailProviders[provider].port ?? ""),
                });
              }}
              className="h-10"
            >
              {mailProviderIds.map((id) => (
                <option key={id} value={id}>
                  {mailProviders[id].label}
                </option>
              ))}
            </Select>
          </Field>
          {preset.transport === "log" ? (
            <p className="m-0 rounded-panel border border-line bg-raised/40 px-4 py-3 text-[13px] text-ink-2">
              Messages are written to the log instead of sent. For development only.
            </p>
          ) : preset.transport === "microsoft" ? (
            <>
              <p className="m-0 text-[13px] text-ink-3">
                Sent through Microsoft Graph as the From mailbox, by an app registration granted the
                Mail.Send application permission.
              </p>
              <div className="grid gap-4 @md/app:grid-cols-2">
                <Field label="Directory (tenant) ID">
                  <Input value={mail.tenant} onChange={set("tenant")} className="h-10" />
                </Field>
                <Field label="Application (client) ID">
                  <Input value={mail.clientId} onChange={set("clientId")} className="h-10" />
                </Field>
              </div>
              <Field label={preset.secret}>
                <Input
                  type="password"
                  value={mail.password}
                  onChange={set("password")}
                  autoComplete="off"
                  className="h-10"
                />
              </Field>
            </>
          ) : preset.transport === "mailcoach" ? (
            <div className="grid gap-4 @md/app:grid-cols-2">
              <Field label="Address">
                <Input
                  value={mail.url}
                  onChange={set("url")}
                  placeholder="https://endlesshall.mailcoach.app"
                  className="h-10"
                />
              </Field>
              <Field label={preset.secret}>
                <Input
                  type="password"
                  value={mail.password}
                  onChange={set("password")}
                  autoComplete="off"
                  className="h-10"
                />
              </Field>
            </div>
          ) : (
            <>
              {!preset.host && (
                <div className="grid gap-4 @md/app:grid-cols-[minmax(0,1fr)_120px]">
                  <Field label="Host">
                    <Input
                      value={mail.host}
                      onChange={set("host")}
                      placeholder={
                        mail.provider === "ses"
                          ? "email-smtp.eu-west-1.amazonaws.com"
                          : "smtp.example.com"
                      }
                      className="h-10"
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      value={mail.port}
                      onChange={set("port")}
                      inputMode="numeric"
                      className="h-10"
                    />
                  </Field>
                </div>
              )}
              <div className={cn("grid gap-4", !preset.username && "@md/app:grid-cols-2")}>
                {!preset.username && (
                  <Field label="Username">
                    <Input
                      value={mail.username}
                      onChange={set("username")}
                      autoComplete="off"
                      className="h-10"
                    />
                  </Field>
                )}
                <Field label={preset.secret ?? "Password"}>
                  <Input
                    type="password"
                    value={mail.password}
                    onChange={set("password")}
                    autoComplete="off"
                    className="h-10"
                  />
                </Field>
              </div>
            </>
          )}
          <Field label="From" hint="Set SPF and DKIM for this domain, or messages land in spam.">
            <Input value={mail.from} onChange={set("from")} className="h-10" />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Send a test to" className="min-w-[220px] flex-1">
              <Input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
                className="h-10"
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="h-10"
              disabled={test.pending || !to}
              onClick={async () => {
                const sent = body();
                const result = await test.run(() =>
                  api.install.checks.mail.$post({ json: { mail: sent, to } }, codeHeaders(code)),
                );
                if (result) setTested(JSON.stringify(sent));
              }}
            >
              Send a test message
            </Button>
          </div>
          <Checks checks={test.checks} />
          <ErrorLine message={test.error} />
        </>
      )}
      {!fixed && tested !== JSON.stringify(body()) && (
        <p className="m-0 text-[13px] text-ink-3">
          Send a test message with these settings to continue.
        </p>
      )}
      <ErrorLine message={step.error} />
      <Footer
        back={back}
        pending={step.pending}
        disabled={!fixed && tested !== JSON.stringify(body())}
      />
    </form>
  );
}

function AddressStep({ code, state, advance, back }: StepProps) {
  const fixed = state.fixed.includes("address");
  const [publicUrl, setPublicUrl] = useState(state.address.publicUrl ?? window.location.origin);
  const check = useStep();
  const step = useStep();
  const body = fixed ? {} : { publicUrl };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await step.run(() =>
          api.install.steps.address.$post({ json: body }, codeHeaders(code)),
        );
        if (!result) return;
        try {
          await advance(result.state);
        } catch (err) {
          step.setError(messageOf(err));
        }
      }}
    >
      {fixed ? (
        <Fixed label="Public address" value={state.address.publicUrl ?? ""} />
      ) : (
        <Field
          label="Public address"
          hint="Links in mail and the signed media addresses are built from it."
        >
          <Input
            value={publicUrl}
            onChange={(e) => setPublicUrl(e.target.value)}
            className="h-10"
          />
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={check.pending}
          onClick={() =>
            check.run(() => api.install.checks.address.$post({ json: body }, codeHeaders(code)))
          }
        >
          Check the address
        </Button>
      </div>
      <Checks checks={step.checks.length > 0 ? step.checks : check.checks} />
      <ErrorLine message={check.error ?? step.error} />
      <Footer back={back} pending={step.pending} label="Save and start Hekate" />
    </form>
  );
}

/** The first workspace and its owner: the last step, on any server without an owner. */
function OwnerStep({
  code,
  onCode,
  onCreated,
}: {
  code: string | null;
  onCode: (code: string) => void;
  onCreated: (workspace: string) => void;
}) {
  const client = useQueryClient();
  const [typed, setTyped] = useState("");
  // A code from earlier in this tab may be stale if the server restarted: then ask for it.
  const [askCode, setAskCode] = useState(!code);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (form.get("password") !== form.get("confirm")) {
      setError("The passwords do not match.");
      return;
    }
    const usedCode = askCode || !code ? typed : code;
    setPending(true);
    setError(null);
    const workspace = String(form.get("organisation"));
    const res = await api.setup.$post(
      {
        json: {
          name: String(form.get("name")),
          email: String(form.get("email")),
          password: String(form.get("password")),
          organisation: workspace,
        },
      },
      codeHeaders(usedCode),
    );
    setPending(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
      } | null;
      if (body?.error?.code?.startsWith("setup_code")) {
        setupCode.clear();
        setAskCode(true);
      }
      setError(body?.error?.message ?? "Setup failed. Check the details and try again.");
      return;
    }
    setupCode.set(usedCode);
    onCode(usedCode);
    client.setQueryData(setupQuery.queryKey, false);
    await client.invalidateQueries({ queryKey: ["me"] });
    onCreated(workspace);
  };
  return (
    <>
      <StepHeading step="owner" />
      <form onSubmit={submit} className="flex flex-col gap-4">
        {(askCode || !code) && (
          <Field label="Setup code" hint="In the server's log: docker compose logs app">
            <Input
              name="code"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="XXXX-XXXX-XXXX"
              autoComplete="one-time-code"
              spellCheck={false}
              className="tabular h-10 max-w-[240px] tracking-[0.08em]"
              required
            />
          </Field>
        )}
        <Field label="Workspace" hint="Your studio, label or company. You can rename it later.">
          <Input name="organisation" required maxLength={120} className="h-10" />
        </Field>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required maxLength={120} className="h-10" />
        </Field>
        <Field label="Email">
          <Input name="email" type="email" autoComplete="username" required className="h-10" />
        </Field>
        <div className="grid gap-4 @md/app:grid-cols-2">
          <Field label="Password" hint="12 characters or more.">
            <Input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              className="h-10"
            />
          </Field>
          <Field label="Confirm password">
            <Input
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              className="h-10"
            />
          </Field>
        </div>
        <ErrorLine message={error} />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" size="lg" className="ml-auto" disabled={pending}>
            {pending ? "Creating" : "Create and finish"}
          </Button>
        </div>
      </form>
    </>
  );
}

function Ready({ workspace }: { workspace: string }) {
  const navigate = useNavigate();
  return (
    <Layout current={rail.length}>
      <div>
        <p className="eyebrow m-0">Done</p>
        <h1 className="m-0 mt-1 text-[24px] leading-[30px] font-medium tracking-[-0.015em]">
          Hekate is ready
        </h1>
        <p className="m-0 mt-2 text-ink-2">
          {workspace} exists and you are its owner. Invite your team from its settings.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="primary" size="lg" onClick={() => navigate({ to: "/" })}>
          Open Hekate
        </Button>
      </div>
    </Layout>
  );
}
