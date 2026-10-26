import {
  type ApiLogRow,
  type ApiScope,
  type ApiTokenKind,
  type ApiTokenLifetime,
  type ApiTokenRow,
  apiBase,
  apiScopeLabels,
  apiScopes,
  apiTokenExpired,
  apiTokenLifetimes,
  MCP_PATH,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  personalTokensQuery,
  serviceTokensQuery,
  useApiTokens,
  workspaceApiLogQuery,
} from "~/lib/api-tokens";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { docsUrl } from "~/lib/links";
import { formatDates } from "~/lib/locale";
import { meQuery } from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { StatusDot } from "./ui/status";

const dayFormat = formatDates({ day: "numeric", month: "short", year: "numeric" });
const callTime = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** What a token's row says of it: its scopes, when it was made and used, and when it ends. */
export function tokenHint(t: ApiTokenRow, now = new Date()) {
  const ends = t.expiresAt
    ? apiTokenExpired(t, now)
      ? `expired ${dayFormat.format(new Date(t.expiresAt))}`
      : `expires ${dayFormat.format(new Date(t.expiresAt))}`
    : "never expires";
  return [
    t.scopes.join(", "),
    `made ${dayFormat.format(new Date(t.createdAt))}${t.kind === "service" && t.createdBy ? ` by ${t.createdBy}` : ""}`,
    t.lastUsedAt ? `last used ${ago(t.lastUsedAt)}` : "never used",
    ends,
  ].join(" · ");
}

/**
 * API tokens (#198), as the prototype has them: a member's own in Account, the workspace's
 * service tokens in its settings. Each row says what the token may do and when it was last
 * used; its menu renames it, changes its scopes or revokes it. A new token is shown once.
 */
export function TokensSection({ kind }: { kind: ApiTokenKind }) {
  const { data: tokens } = useQuery(kind === "personal" ? personalTokensQuery : serviceTokensQuery);
  const [making, setMaking] = useState(false);
  const [editing, setEditing] = useState<{ token: ApiTokenRow; part: "name" | "scopes" } | null>(
    null,
  );
  const [revoking, setRevoking] = useState<ApiTokenRow | null>(null);
  if (!tokens) return null;
  const personal = kind === "personal";
  const create = (
    <Button variant={personal ? "primary" : "secondary"} size="md" onClick={() => setMaking(true)}>
      {personal ? (
        <>
          <Icon name="plus" size={14} />
          Token
        </>
      ) : (
        "Create"
      )}
    </Button>
  );
  return (
    <>
      <Section
        title={personal ? "Your tokens" : "Service tokens"}
        intro={
          personal
            ? "A token can do no more than you can, and only what its scopes allow. It reaches this workspace alone, and is shown once."
            : "Tokens that act as the workspace rather than a person, for the release pipeline and the like. Scoped and logged like any other."
        }
        action={personal ? create : undefined}
      >
        {tokens.length === 0 && (
          <Row
            name="No tokens yet"
            hint={
              personal
                ? "Make one for a script or tool of yours. It reaches this workspace alone."
                : "Make one for a pipeline that works for the workspace, not for one person."
            }
          />
        )}
        {tokens.map((t) => {
          const expired = apiTokenExpired(t);
          return (
            <Row
              key={t.id}
              inline
              name={
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot state={expired ? "cancelled" : "approved"} />
                  <span className="truncate">{t.name}</span>
                  <span className="tabular shrink-0 text-[12px] text-ink-3">{t.hint}…</span>
                  <span className="sr-only">{expired ? "Expired" : "Live"}</span>
                </span>
              }
              hint={tokenHint(t)}
            >
              <ActionMenu
                always
                label={t.name}
                actions={[
                  { label: "Rename…", onSelect: () => setEditing({ token: t, part: "name" }) },
                  {
                    label: "Change scopes…",
                    onSelect: () => setEditing({ token: t, part: "scopes" }),
                  },
                  "divider",
                  { label: "Revoke…", danger: true, onSelect: () => setRevoking(t) },
                ]}
              />
            </Row>
          );
        })}
        {!personal && (
          <Row name="New service token" hint="Shown once; owners and admins only.">
            {create}
          </Row>
        )}
      </Section>
      {making && <NewTokenDialog kind={kind} onClose={() => setMaking(false)} />}
      {editing && (
        <EditTokenDialog
          kind={kind}
          token={editing.token}
          part={editing.part}
          onClose={() => setEditing(null)}
        />
      )}
      {revoking && <RevokeDialog kind={kind} token={revoking} onClose={() => setRevoking(null)} />}
    </>
  );
}

/** The scopes to choose from, each with what it allows: a token's, or an OAuth client's (#447). */
export function ScopeChoices({
  value,
  onChange,
  legend = "Scopes",
}: {
  value: ApiScope[];
  onChange: (scopes: ApiScope[]) => void;
  legend?: string;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 text-[13px] text-ink-2">
      <legend className="mb-1.5">{legend}</legend>
      {apiScopes.map((s) => (
        <label key={s} className="flex cursor-pointer items-start gap-2.5">
          <Checkbox
            className="mt-0.5"
            checked={value.includes(s)}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? apiScopes.filter((x) => x === s || value.includes(x))
                  : value.filter((x) => x !== s),
              )
            }
          />
          <span className="flex min-w-0 flex-col @md/app:flex-row @md/app:gap-3">
            <span className="tabular shrink-0 text-ink @md/app:w-28">{s}</span>
            <span className="text-ink-3">{apiScopeLabels[s]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const lifetimeLabels: Record<ApiTokenLifetime, string> = {
  30: "In 30 days",
  90: "In 90 days",
  365: "In a year",
};

/** A new token: a name, the least scopes it needs, and how long it lasts. Then the token, once. */
function NewTokenDialog({ kind, onClose }: { kind: ApiTokenKind; onClose: () => void }) {
  const { create } = useApiTokens(kind);
  const { data: me } = useQuery(meQuery);
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>(["files:read"]);
  const [lifetime, setLifetime] = useState<string>(kind === "personal" ? "90" : "never");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      {
        name,
        scopes,
        expiresInDays: lifetime === "never" ? null : (Number(lifetime) as ApiTokenLifetime),
      },
      { onSuccess: (r) => setSecret(r.secret) },
    );
  };
  if (secret)
    return (
      <Dialog
        title="Your new token"
        description="Shown once. Copy it now: Hekate keeps only a hash of it."
        onClose={onClose}
        width="sm"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 p-2 pl-3">
            <span className="tabular min-w-0 flex-1 truncate text-[12px] text-ink-2">{secret}</span>
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(secret);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="m-0 text-[12px] text-ink-3">
            Send it as{" "}
            <span className="tabular text-ink-2">Authorization: Bearer {secret.slice(0, 7)}…</span>
          </p>
          <div className="flex justify-end pt-1">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );
  return (
    <Dialog
      title={kind === "personal" ? "New API token" : "New service token"}
      description="Pick the least it needs. You will see the token once."
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            value={name}
            required
            maxLength={80}
            placeholder={kind === "personal" ? "Release pipeline" : "Archive sync"}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <ScopeChoices value={scopes} onChange={setScopes} />
        <div className="grid gap-3 @md/app:grid-cols-2">
          <Field label="Expires">
            <Select value={lifetime} onChange={(e) => setLifetime(e.target.value)}>
              {apiTokenLifetimes.map((d) => (
                <option key={d} value={d}>
                  {lifetimeLabels[d]}
                </option>
              ))}
              <option value="never">Never</option>
            </Select>
          </Field>
          <Field
            label="Workspace"
            hint={kind === "personal" ? "Switch workspace to make one for another." : undefined}
          >
            <span className="flex h-8 items-center truncate text-[14px] text-ink">
              {workspace?.name ?? ""}
            </span>
          </Field>
        </div>
        {create.error && <p className="m-0 text-[13px] text-signal">{create.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={create.isPending || !name.trim() || scopes.length === 0}
          >
            Create token
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A token renamed, or given other scopes: it keeps working as it is until saved. */
function EditTokenDialog({
  kind,
  token,
  part,
  onClose,
}: {
  kind: ApiTokenKind;
  token: ApiTokenRow;
  part: "name" | "scopes";
  onClose: () => void;
}) {
  const { change } = useApiTokens(kind);
  const [name, setName] = useState(token.name);
  const [scopes, setScopes] = useState<ApiScope[]>(token.scopes);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate(
      { id: token.id, ...(part === "name" ? { name } : { scopes }) },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      title={part === "name" ? `Rename ${token.name}` : `Scopes of ${token.name}`}
      description={
        part === "scopes"
          ? "The token keeps its value; what it may do changes from its next call."
          : undefined
      }
      onClose={onClose}
      width={part === "name" ? "sm" : "md"}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {part === "name" ? (
          <Field label="Name">
            <Input
              value={name}
              required
              maxLength={80}
              autoFocus
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        ) : (
          <ScopeChoices value={scopes} onChange={setScopes} />
        )}
        {change.error && <p className="m-0 text-[13px] text-signal">{change.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={change.isPending || (part === "name" ? !name.trim() : scopes.length === 0)}
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({
  kind,
  token,
  onClose,
}: {
  kind: ApiTokenKind;
  token: ApiTokenRow;
  onClose: () => void;
}) {
  const { revoke } = useApiTokens(kind);
  return (
    <Dialog
      title={`Revoke ${token.name}?`}
      description="Whatever uses it is refused from its next call. This cannot be undone; make another token instead."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(token.id, { onSuccess: onClose })}
          >
            Revoke token
          </Button>
        </>
      }
    >
      {revoke.error && <p className="text-[13px] text-signal">{revoke.error.message}</p>}
    </Dialog>
  );
}

/** Account's "Using the API": where calls go, how a token is sent, and the reference (#197). */
export function UsingTheApiSection() {
  const base = addressOf(apiBase());
  return (
    <Section
      title="Using the API"
      intro="Every call is logged against the token; the workspace's admins see it in the API log."
    >
      <Row name="Base address" inline>
        <span className="tabular truncate text-[13px] text-ink-2">{base}</span>
      </Row>
      <Row name="Sending a token" hint="In each call's Authorization header, as a bearer token.">
        <span className="tabular truncate text-[13px] text-ink-2">
          Authorization: Bearer hk_pat_…
        </span>
      </Row>
      <Row name="Reference" hint="OpenAPI 3.1, with examples for every call.">
        <Button variant="ghost" size="md" asChild>
          <a href={`${docsUrl}/use/api/`} target="_blank" rel="noreferrer">
            Open the reference
          </a>
        </Button>
      </Row>
    </Section>
  );
}

/** Where this host answers a path: the address someone types into a client, as it is here. */
const addressOf = (path: string) =>
  typeof window === "undefined" ? path : `${window.location.origin}${path}`;

/**
 * Notifications and integrations' "API and MCP", as the prototype has it: where the workspace's
 * keys are made, and the MCP endpoint (decision 231) at this host's own address, to copy into an
 * assistant. The endpoint takes a token, never a session, so the address alone opens nothing.
 */
export function ApiAndMcpSection() {
  const address = addressOf(MCP_PATH);
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(address)
      .then(() => setCopied("copied"))
      .catch(() => setCopied("failed"));
  };
  return (
    <Section title="API and MCP">
      <Row name="API keys" hint="Scoped to the workspace; shown once.">
        <Button variant="secondary" size="md" asChild>
          <Link to="/settings/$section" params={{ section: "api" }}>
            New key
          </Link>
        </Button>
      </Row>
      <Row
        name="MCP endpoint"
        hint={
          <>
            <span className="tabular break-all">{address}</span> · tools for what waits on you,
            reviews, comments, decisions and QA reports
          </>
        }
      >
        <Button variant="secondary" size="md" onClick={copy}>
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy it by hand" : "Copy"}
        </Button>
      </Row>
    </Section>
  );
}

/** The workspace's "Scopes": what a token may be given. */
export function ScopesSection() {
  return (
    <Section
      title="Scopes"
      intro="What a token may be given. A token holds the ones it was made with; writing a kind includes reading it."
    >
      {apiScopes.map((s) => (
        <Row key={s} name={<span className="tabular">{s}</span>} hint={apiScopeLabels[s]} />
      ))}
    </Section>
  );
}

/** One call in the API log: when, which token, the call, its answer and how long it took. */
export function ApiLogEntry({
  row: r,
  workspace = false,
}: {
  row: ApiLogRow;
  workspace?: boolean;
}) {
  return (
    <div
      data-log-entry
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] @3xl/app:grid-cols-[150px_minmax(0,1fr)_minmax(0,1.4fr)_60px_70px]"
    >
      <span className="tabular text-ink-3">{callTime.format(new Date(r.at))}</span>
      <span
        className={cn(
          "tabular justify-self-end @3xl/app:order-4 @3xl/app:justify-self-start",
          r.status >= 400 ? "text-signal" : "text-ink-3",
        )}
      >
        {r.status}
      </span>
      <span className="col-span-2 flex min-w-0 flex-col @3xl/app:order-2 @3xl/app:col-span-1">
        <span className="truncate text-ink-2">
          {r.token.name}
          {r.token.kind === "service" ? " (service)" : ""}
        </span>
        {workspace && <span className="truncate text-[12px] text-ink-3">{r.workspace.name}</span>}
      </span>
      <span
        className="tabular col-span-2 truncate text-ink @3xl/app:order-3 @3xl/app:col-span-1"
        title={`${r.method} ${r.path}`}
      >
        {r.method} {r.path}
      </span>
      <span className="tabular hidden text-right text-ink-3 @3xl/app:order-5 @3xl/app:block">
        {r.durationMs} ms
      </span>
    </div>
  );
}

/** The workspace's own API log: the latest calls its tokens made, members' own among them. */
export function WorkspaceApiLogSection() {
  const { data: rows, isPending } = useQuery(workspaceApiLogQuery);
  return (
    <Section
      title="API log"
      intro="The latest calls made with this workspace's tokens, members' own among them, over the last week."
    >
      {isPending ? (
        <Row name="Loading" />
      ) : !rows || rows.length === 0 ? (
        <Row name="No calls yet" hint="A call made with any token here shows up at once." />
      ) : (
        rows.map((r) => <ApiLogEntry key={r.id} row={r} />)
      )}
    </Section>
  );
}
