import {
  type ApiScope,
  apiScopeLabels,
  type ConnectedAppRow,
  type CreatedOAuthClient,
  type OAuthClientKind,
  type OAuthClientRow,
  oauthClientKindLabels,
  oauthHint,
  redirectUriProblem,
  scopePhrase,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ago } from "~/lib/comments";
import { docsUrl } from "~/lib/links";
import { formatDates } from "~/lib/locale";
import {
  connectedAppsQuery,
  oauthClientsQuery,
  oauthConnectionsQuery,
  useDisconnect,
  useOAuthClients,
} from "~/lib/oauth";
import { ScopeChoices } from "./api-tokens";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select, Textarea } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { StatusDot } from "./ui/status";

const dayFormat = formatDates({ day: "numeric", month: "short", year: "numeric" });

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"} connected`;

/** What a client's row says of it: its kind, where it goes back to, what it may ask, who has it. */
export function clientHint(c: OAuthClientRow) {
  const [first, ...more] = c.redirectUris;
  return [
    oauthClientKindLabels[c.kind],
    more.length > 0 ? `${first} and ${more.length} more` : first,
    c.scopes.join(", "),
    people(c.connected),
  ].join(" · ");
}

/** A connected app's row: what it may do, since when, and when it last called. */
export function connectedHint(a: {
  scopes: ApiScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}) {
  return [
    scopePhrase(a.scopes),
    `connected ${dayFormat.format(new Date(a.connectedAt))}`,
    a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : "not used yet",
  ].join(" · ");
}

/**
 * The workspace's OAuth clients (#447), as the prototype has them: each with its kind, its
 * redirect addresses, the scopes it may ask for and how many have it connected; its menu edits
 * it, rotates its secret, shows who has connected, or deletes it.
 */
export function OAuthClientsSection() {
  const { data: clients } = useQuery(oauthClientsQuery);
  const [editing, setEditing] = useState<OAuthClientRow | "new" | null>(null);
  const [shown, setShown] = useState<{ made: CreatedOAuthClient; rotated: boolean } | null>(null);
  const [rotating, setRotating] = useState<OAuthClientRow | null>(null);
  const [watching, setWatching] = useState<OAuthClientRow | null>(null);
  const [deleting, setDeleting] = useState<OAuthClientRow | null>(null);
  if (!clients) return null;
  return (
    <>
      <Section
        title="OAuth clients"
        intro="Applications registered here can ask people for access with OAuth 2.1 and PKCE. Each gets a client id; confidential clients get a secret shown once."
        action={
          <Button variant="primary" size="md" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Client
          </Button>
        }
      >
        {clients.length === 0 && (
          <Row
            name="No clients yet"
            hint="Register an application that connects to Hekate for the people who use it: a chat integration, a desktop tool, a delivery service."
          />
        )}
        {clients.map((c) => (
          <Row
            key={c.id}
            inline
            name={
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot state={c.connected > 0 ? "approved" : "in_review"} />
                <span className="truncate">{c.name}</span>
                <span className="tabular shrink-0 text-[12px] text-ink-3">
                  {oauthHint(c.clientId)}…
                </span>
              </span>
            }
            hint={<span className="break-words">{clientHint(c)}</span>}
          >
            <ActionMenu
              always
              label={c.name}
              actions={[
                { label: "Edit…", onSelect: () => setEditing(c) },
                ...(c.kind === "confidential"
                  ? [{ label: "Rotate the secret…", onSelect: () => setRotating(c) }]
                  : []),
                { label: "Who has connected", onSelect: () => setWatching(c) },
                "divider",
                { label: "Delete…", danger: true, onSelect: () => setDeleting(c) },
              ]}
            />
          </Row>
        ))}
      </Section>
      {editing && (
        <ClientDialog
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onMade={(made) => {
            setEditing(null);
            setShown({ made, rotated: false });
          }}
        />
      )}
      {shown && (
        <CredentialsDialog
          made={shown.made}
          rotated={shown.rotated}
          onClose={() => setShown(null)}
        />
      )}
      {rotating && (
        <RotateDialog
          client={rotating}
          onClose={() => setRotating(null)}
          onRotated={(made) => {
            setRotating(null);
            setShown({ made, rotated: true });
          }}
        />
      )}
      {watching && <ConnectionsDialog client={watching} onClose={() => setWatching(null)} />}
      {deleting && <DeleteClientDialog client={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

/** The addresses typed one per line, each checked as the server will check it. */
const addressesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

/** A new client, or one edited: its name, kind (fixed once made), redirect addresses and scopes. */
function ClientDialog({
  client,
  onClose,
  onMade,
}: {
  client: OAuthClientRow | null;
  onClose: () => void;
  onMade: (made: CreatedOAuthClient) => void;
}) {
  const { create, change } = useOAuthClients();
  const [name, setName] = useState(client?.name ?? "");
  const [kind, setKind] = useState<OAuthClientKind>(client?.kind ?? "confidential");
  const [addresses, setAddresses] = useState((client?.redirectUris ?? []).join("\n"));
  const [scopes, setScopes] = useState<ApiScope[]>(client?.scopes ?? ["files:read"]);
  const list = addressesOf(addresses);
  const problem = list.map((a) => redirectUriProblem(a)).find((p) => p !== null) ?? null;
  const saving = create.isPending || change.isPending;
  const error = create.error ?? change.error;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (client)
      change.mutate({ id: client.id, name, redirectUris: list, scopes }, { onSuccess: onClose });
    else create.mutate({ name, kind, redirectUris: list, scopes }, { onSuccess: onMade });
  };
  return (
    <Dialog
      title={client ? `Edit ${client.name}` : "New OAuth client"}
      description={
        client
          ? "Fewer scopes take effect at once, for everyone connected."
          : "Confidential clients get a secret, shown once."
      }
      onClose={onClose}
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name" hint="People see it when they are asked to connect it.">
          <Input
            value={name}
            required
            maxLength={80}
            placeholder="Mastering handoff"
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Kind"
          hint={client ? "A client's kind cannot change; register another instead." : undefined}
        >
          <Select
            value={kind}
            disabled={client !== null}
            onChange={(e) => setKind(e.target.value as OAuthClientKind)}
          >
            <option value="confidential">Confidential (server-side, gets a secret)</option>
            <option value="public">Public (desktop or mobile, PKCE only)</option>
          </Select>
        </Field>
        <Field
          label="Redirect addresses"
          hint="One per line, matched exactly: https, http on this computer only, or the application's own scheme."
          error={addresses.trim() ? problem : null}
        >
          <Textarea
            value={addresses}
            required
            placeholder="https://app.example/oauth/callback"
            className="h-20"
            onChange={(e) => setAddresses(e.target.value)}
          />
        </Field>
        <ScopeChoices value={scopes} onChange={setScopes} legend="Scopes it may ask for" />
        {error && <p className="m-0 text-[13px] text-signal">{error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              saving || !name.trim() || list.length === 0 || problem !== null || scopes.length === 0
            }
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** A value to copy, with its button. */
function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
      {label}
      <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 p-2 pl-3">
        <span className="tabular min-w-0 flex-1 truncate text-[12px] text-ink-2">{value}</span>
        <Button
          size="sm"
          aria-label={`Copy the ${label.toLowerCase()}`}
          onClick={async () => {
            await navigator.clipboard?.writeText(value);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

/** A client's id, and its secret once: when it is made, or its secret rotated. */
function CredentialsDialog({
  made,
  rotated,
  onClose,
}: {
  made: CreatedOAuthClient;
  rotated: boolean;
  onClose: () => void;
}) {
  const base = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Dialog
      title={rotated ? `New secret for ${made.client.name}` : `${made.client.name} is registered`}
      description={
        made.secret
          ? "The secret is shown once. Copy it now: Hekate keeps only a hash of it."
          : "A public client has no secret: it proves each exchange with PKCE."
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {!rotated && <Copyable label="Client id" value={made.client.clientId} />}
        {made.secret && <Copyable label="Client secret" value={made.secret} />}
        <p className="m-0 text-[12px] text-ink-3">
          Its endpoints are listed at{" "}
          <span className="tabular break-all text-ink-2">
            {base}/.well-known/oauth-authorization-server
          </span>
          .
        </p>
        <div className="flex justify-end pt-1">
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function RotateDialog({
  client,
  onClose,
  onRotated,
}: {
  client: OAuthClientRow;
  onClose: () => void;
  onRotated: (made: CreatedOAuthClient) => void;
}) {
  const { rotate } = useOAuthClients();
  return (
    <Dialog
      title={`Rotate the secret of ${client.name}?`}
      description="The old secret stops working at once. Tokens already issued keep working; the application needs the new secret to refresh them."
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
            disabled={rotate.isPending}
            onClick={() => rotate.mutate(client.id, { onSuccess: onRotated })}
          >
            Rotate secret
          </Button>
        </>
      }
    >
      {client.secretHint && (
        <p className="m-0 text-[13px] text-ink-3">
          Now <span className="tabular text-ink-2">{client.secretHint}…</span>
          {client.secretRotatedAt
            ? `, rotated ${dayFormat.format(new Date(client.secretRotatedAt))}`
            : `, since ${dayFormat.format(new Date(client.createdAt))}`}
        </p>
      )}
      {rotate.error && <p className="text-[13px] text-signal">{rotate.error.message}</p>}
    </Dialog>
  );
}

/** Who has a client connected now, with what each granted and when it last called for them. */
function ConnectionsDialog({ client, onClose }: { client: OAuthClientRow; onClose: () => void }) {
  const { data: connections, isPending } = useQuery(oauthConnectionsQuery(client.id));
  return (
    <Dialog
      title={`Who has connected ${client.name}`}
      description="Each acts as the person who connected it, within what they granted. They disconnect it in Account, Connected apps."
      onClose={onClose}
    >
      <div
        data-connections
        className="flex flex-col divide-y divide-line rounded-panel border border-line"
      >
        {isPending ? (
          <Row name="Loading" />
        ) : !connections || connections.length === 0 ? (
          <Row name="Nobody yet" hint="Someone who connects it from the application shows here." />
        ) : (
          connections.map((p) => (
            <Row
              key={p.id}
              name={
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="truncate">{p.name}</span>
                  <span className="truncate text-[12px] text-ink-3">{p.email}</span>
                </span>
              }
              hint={connectedHint(p)}
            />
          ))
        )}
      </div>
    </Dialog>
  );
}

function DeleteClientDialog({ client, onClose }: { client: OAuthClientRow; onClose: () => void }) {
  const { remove } = useOAuthClients();
  return (
    <Dialog
      title={`Delete ${client.name}?`}
      description={`${client.connected > 0 ? `${people(client.connected)} lose it at once: ` : ""}every token it holds stops working, and the application can no longer ask anyone. This cannot be undone.`}
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
            disabled={remove.isPending}
            onClick={() => remove.mutate(client.id, { onSuccess: onClose })}
          >
            Delete client
          </Button>
        </>
      }
    >
      {remove.error && <p className="text-[13px] text-signal">{remove.error.message}</p>}
    </Dialog>
  );
}

/**
 * Account's connected apps (#447): the applications the member let into this workspace, each
 * with what it may do, and Disconnect, which stops every token it holds at once.
 */
export function ConnectedAppsSection() {
  const { data: apps } = useQuery(connectedAppsQuery);
  const disconnect = useDisconnect();
  const [reading, setReading] = useState<ConnectedAppRow | null>(null);
  if (!apps) return null;
  return (
    <>
      <Section
        title="Connected apps"
        intro="Applications you have let into this workspace through OAuth. Each sees only what you granted, and only what you can see."
      >
        {apps.length === 0 && (
          <Row
            name="No connected apps"
            hint="When you let an application in from its own screen, it shows here, with what it may do."
          />
        )}
        {apps.map((a) => (
          <Row
            key={a.id}
            inline
            name={<span className="truncate">{a.name}</span>}
            hint={connectedHint(a)}
          >
            <ActionMenu
              always
              label={a.name}
              actions={[
                { label: "What it may do…", onSelect: () => setReading(a) },
                "divider",
                {
                  label: "Disconnect",
                  danger: true,
                  onSelect: () => disconnect.mutate(a.id),
                },
              ]}
            />
          </Row>
        ))}
        {disconnect.error && <Row name="Not disconnected" hint={disconnect.error.message} />}
      </Section>
      <Section
        title="For developers"
        intro="An application that connects to Hekate on people's behalf is registered by a workspace, under its settings."
      >
        <Row
          name="Register an application"
          hint="Client id and secret, redirect addresses, scopes; in Workspace settings under API and OAuth clients."
        >
          <Button variant="ghost" size="md" asChild>
            <a href={`${docsUrl}/use/oauth/`} target="_blank" rel="noreferrer">
              Open the guide
            </a>
          </Button>
        </Row>
      </Section>
      {reading && (
        <Dialog
          title={`What ${reading.name} may do`}
          description="It acts as you, in this workspace alone, and can do no more than you can."
          onClose={() => setReading(null)}
          footer={
            <>
              <Button
                variant="ghost"
                size="md"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate(reading.id, { onSuccess: () => setReading(null) })}
              >
                Disconnect
              </Button>
              <Button variant="primary" size="md" onClick={() => setReading(null)}>
                Done
              </Button>
            </>
          }
        >
          <ScopeList scopes={reading.scopes} />
        </Dialog>
      )}
    </>
  );
}

/** Scopes granted or asked for, each with what it allows. */
export function ScopeList({ scopes }: { scopes: readonly ApiScope[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
      {scopes.map((s) => (
        <li key={s} className="flex min-w-0 flex-col @md/app:flex-row @md/app:gap-3">
          <span className="tabular shrink-0 text-ink @md/app:w-28">{s}</span>
          <span className="text-ink-3">{apiScopeLabels[s]}</span>
        </li>
      ))}
    </ul>
  );
}
