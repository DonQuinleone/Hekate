import {
  bounceSecrets,
  type ChannelKind,
  type ChannelRow,
  channelKindLabels,
  channelKinds,
  channelUrlHints,
  type EventKind,
  eventKinds,
  eventLabels,
  eventsSummary,
  isBounceProvider,
  type MailProvider,
  mailProviders,
  type WorkspaceMail,
  workspaceMailProviders,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import {
  channelsQuery,
  instanceSuppressionsQuery,
  useChannels,
  useMailSender,
  useSendAgain,
  useWorkspaceMail,
  workspaceMailQuery,
  workspaceSuppressionsQuery,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select } from "./ui/input";
import { ActionMenu } from "./ui/menu";
import { StatusDot } from "./ui/status";

const timeFormat = formatDates({ hour: "2-digit", minute: "2-digit" });

const kindIcon: Record<ChannelKind, "slack" | "discord" | "teams" | "webhook"> = {
  slack: "slack",
  discord: "discord",
  teams: "teams",
  webhook: "webhook",
};

/** What a channel's row says of it: where it points, and how it is doing. */
function channelHint(c: ChannelRow) {
  if (c.pausedUntil)
    return `${c.target} · paused after ${c.failures} failures, until ${timeFormat.format(new Date(c.pausedUntil))}`;
  if (c.failures > 0) return `${c.target} · ${c.failures} failed in a row`;
  if (c.lastDeliveredAt) return `${c.target} · last delivered ${ago(c.lastDeliveredAt)}`;
  return c.target;
}

/**
 * Notifications and integrations (#161), as the prototype has them: the workspace's channels,
 * each with a test, and a matrix of which events each carries. A channel that keeps failing
 * pauses itself; Resume starts it again at once.
 */
export function ChannelsSection() {
  const { data: channels } = useQuery(channelsQuery);
  const { change, remove, test } = useChannels();
  const [editing, setEditing] = useState<ChannelRow | "new" | null>(null);
  const [choosing, setChoosing] = useState<ChannelRow | null>(null);
  const [editingMail, setEditingMail] = useState(false);
  const [bounced, setBounced] = useState(false);
  const { data: mail } = useQuery(workspaceMailQuery);
  const sender = useMailSender();
  const [tested, setTested] = useState<{ id: string; ok: boolean; result: string } | null>(null);
  if (!channels) return null;
  const toggle = (c: ChannelRow, kind: EventKind) =>
    change.mutate({
      id: c.id,
      events: c.events.includes(kind) ? c.events.filter((e) => e !== kind) : [...c.events, kind],
    });
  return (
    <>
      <Section
        title="Channels"
        intro="Where events go. Each channel has its own fields and a test; a channel that keeps failing pauses itself."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Channel
          </Button>
        }
      >
        <MailRow onEdit={() => setEditingMail(true)} onBounced={() => setBounced(true)} />
        {sender?.logOnly && (
          <Row
            name="Log only"
            hint="No mail is sent: the instance writes everything to its log, as in development. Give the workspace its own mail, or ask the operator to set the instance's."
          />
        )}
        {channels.length === 0 && (
          <Row
            name="No channels yet"
            hint="Add a Slack, Discord or Microsoft Teams channel, or a webhook of your own, and choose which events it hears of."
          />
        )}
        {channels.map((c) => (
          <Row
            key={c.id}
            name={
              <span className="flex items-center gap-2.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
                  <Icon name={kindIcon[c.kind]} size={16} />
                </span>
                <span className="truncate">{c.name}</span>
                <StatusDot state={c.pausedUntil ? "changes_requested" : "approved"} />
                <span className="sr-only">{c.pausedUntil ? "Paused" : "On"}</span>
              </span>
            }
            hint={
              tested?.id === c.id ? (
                <span role="status" className={cn(!tested.ok && "text-signal")}>
                  {tested.result}
                </span>
              ) : (
                channelHint(c)
              )
            }
          >
            <span className="hidden text-[12px] text-ink-3 @3xl/app:inline">
              {eventsSummary(c.events)}
            </span>
            <div className="flex items-center gap-1">
              {c.pausedUntil ? (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ id: c.id, resume: true })}
                >
                  Resume
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={test.isPending && test.variables === c.id}
                  onClick={() => {
                    setTested(null);
                    test.mutate(c.id, {
                      onSuccess: (r) => setTested({ id: c.id, ...r }),
                      onError: (e) => setTested({ id: c.id, ok: false, result: e.message }),
                    });
                  }}
                >
                  {test.isPending && test.variables === c.id ? "Testing…" : "Test"}
                </Button>
              )}
              <ActionMenu
                always
                label={c.name}
                actions={[
                  { label: "Edit…", onSelect: () => setEditing(c) },
                  { label: "Which events…", onSelect: () => setChoosing(c) },
                  "divider",
                  { label: "Remove", danger: true, onSelect: () => remove.mutate(c.id) },
                ]}
              />
            </div>
          </Row>
        ))}
      </Section>
      {channels.length > 0 && (
        <EventsMatrix channels={channels} onToggle={toggle} disabled={change.isPending} />
      )}
      {editing && (
        <ChannelDialog
          channel={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {editingMail && (
        <WorkspaceMailDialog saved={mail ?? null} onClose={() => setEditingMail(false)} />
      )}
      {bounced && <SuppressionsDialog scope="workspace" onClose={() => setBounced(false)} />}
      {choosing && (
        <EventsDialog
          channel={channels.find((c) => c.id === choosing.id) ?? choosing}
          onClose={() => setChoosing(null)}
        />
      )}
    </>
  );
}

/** Which events each channel carries: a row for each kind, a column for each channel. */
function EventsMatrix({
  channels,
  onToggle,
  disabled,
}: {
  channels: ChannelRow[];
  onToggle: (c: ChannelRow, kind: EventKind) => void;
  disabled: boolean;
}) {
  return (
    <section aria-label="Events" className="flex flex-col gap-3">
      <div className="min-w-0">
        <h2 className="text-[16px] font-medium text-ink">Events</h2>
        <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
          Which events each channel carries.
        </p>
      </div>
      <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-raised/25 shadow-1">
        <table
          className="w-full min-w-[var(--events-width)] border-collapse text-[13px]"
          style={{ "--events-width": `${240 + channels.length * 112}px` } as CSSProperties}
        >
          <thead>
            <tr>
              <th className="label px-4 py-2 text-left font-normal">Event</th>
              {channels.map((c) => (
                <th key={c.id} className="w-[112px] px-2 py-2 text-center font-normal last:pr-4">
                  <span className="label block truncate">{c.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {eventKinds.map((kind) => (
              <tr key={kind} className="border-t border-line">
                <td className="px-4 py-2 text-ink">{eventLabels[kind]}</td>
                {channels.map((c) => (
                  <td key={c.id} className="px-2 py-2 text-center last:pr-4">
                    <Checkbox
                      aria-label={`${eventLabels[kind]}, to ${c.name}`}
                      checked={c.events.includes(kind)}
                      disabled={disabled}
                      onChange={() => onToggle(c, kind)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** One channel's events, as a list: the matrix's column, where a phone has no room for it. */
function EventsDialog({ channel, onClose }: { channel: ChannelRow; onClose: () => void }) {
  const { change } = useChannels();
  const [events, setEvents] = useState<EventKind[]>(channel.events);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate({ id: channel.id, events }, { onSuccess: onClose });
  };
  return (
    <Dialog title={`Which events go to ${channel.name}`} onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <EventChoices events={events} onChange={setEvents} />
        {change.error && <p className="text-[13px] text-signal">{change.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={change.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EventChoices({
  events,
  onChange,
}: {
  events: EventKind[];
  onChange: (events: EventKind[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-[13px] text-ink-2">Events</legend>
      {eventKinds.map((kind) => (
        <label key={kind} className="flex items-center gap-2.5 text-[13px] text-ink">
          <Checkbox
            checked={events.includes(kind)}
            onChange={(e) =>
              onChange(e.target.checked ? [...events, kind] : events.filter((k) => k !== kind))
            }
          />
          {eventLabels[kind]}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A new channel, or one changed: its kind, name and address, and for a new one which events it
 * carries. A webhook's signing secret is shown once, when it is made or made again.
 */
function ChannelDialog({ channel, onClose }: { channel: ChannelRow | null; onClose: () => void }) {
  const { add, change } = useChannels();
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "slack");
  const [name, setName] = useState(channel?.name ?? "");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<EventKind[]>(channel?.events ?? [...eventKinds]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const saving = channel ? change : add;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const done = (r: { secret?: string }) => (r.secret ? setSecret(r.secret) : onClose());
    if (channel)
      change.mutate(
        { id: channel.id, name, ...(url.trim() ? { url: url.trim() } : {}) },
        { onSuccess: done },
      );
    else add.mutate({ kind, name, url: url.trim(), events }, { onSuccess: done });
  };
  const hints = channelUrlHints[kind];
  if (secret)
    return (
      <Dialog
        title="Signing secret"
        description="Shown once. The receiver checks each delivery's Hekate-Signature header with it."
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
          <div className="flex justify-end pt-1">
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Dialog>
    );
  return (
    <Dialog title={channel ? `Edit ${channel.name}` : "New channel"} onClose={onClose} width="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!channel && (
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ChannelKind)}>
              {channelKinds.map((k) => (
                <option key={k} value={k}>
                  {channelKindLabels[k]}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field
          label="Name"
          hint="As settings and the webhook log show it: the channel's own name, say."
        >
          <Input
            value={name}
            required
            maxLength={80}
            placeholder={kind === "webhook" ? "Release desk" : "#masters"}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label={hints.label}
          hint={
            channel
              ? `Empty keeps the address it has, at ${channel.target}.`
              : kind === "webhook"
                ? "Each event arrives as JSON, signed, with its id to tell a repeat from a new one."
                : undefined
          }
        >
          <Input
            type="url"
            value={url}
            required={!channel}
            placeholder={hints.placeholder}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        {!channel && <EventChoices events={events} onChange={setEvents} />}
        {channel?.kind === "webhook" && (
          <Row name="Signing secret" hint="A new one stops the old one working at once." inline>
            <Button
              size="sm"
              disabled={change.isPending}
              onClick={() =>
                change.mutate(
                  { id: channel.id, newSecret: true },
                  { onSuccess: (r) => r.secret && setSecret(r.secret) },
                )
              }
            >
              New secret
            </Button>
          </Row>
        )}
        {saving.error && <p className="text-[13px] text-signal">{saving.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving.isPending}>
            {channel ? "Save" : "Add channel"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The workspace's mail (#161): the instance's until an admin gives the workspace its own, which
 * then sends what members, guests and invitations are sent. It is not in the matrix: members
 * choose what reaches them by mail.
 */
function MailRow({ onEdit, onBounced }: { onEdit: () => void; onBounced: () => void }) {
  const { data: mail, isPending } = useQuery(workspaceMailQuery);
  const { remove, resume, test } = useWorkspaceMail();
  if (isPending) return null;
  const outcome = test.data ?? (test.error ? { ok: false, result: test.error.message } : null);
  const hint = outcome ? (
    <span role="status" className={cn(!outcome.ok && "text-signal")}>
      {outcome.result}
    </span>
  ) : !mail ? (
    "Through the instance's mail. Give the workspace its own, and members, guests and invitations are sent from it."
  ) : mail.pausedUntil ? (
    `${mail.target} · paused after ${mail.failures} failures, until ${timeFormat.format(new Date(mail.pausedUntil))}; the instance's mail sends meanwhile`
  ) : mail.failures > 0 ? (
    `${mail.target} · ${mail.failures} failed in a row${mail.lastError ? `: ${mail.lastError}` : ""}`
  ) : (
    `${mail.target} · from ${mail.from}${mail.suppressed > 0 ? ` · ${mail.suppressed} not sent to after a bounce` : ""}`
  );
  return (
    <Row
      name={
        <span className="flex items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
            <Icon name="mail" size={16} />
          </span>
          <span className="truncate">{mail ? mailProviders[mail.provider].label : "Mail"}</span>
          {mail && <StatusDot state={mail.pausedUntil ? "changes_requested" : "approved"} />}
          {mail && <span className="sr-only">{mail.pausedUntil ? "Paused" : "On"}</span>}
        </span>
      }
      hint={hint}
    >
      <span className="hidden text-[12px] text-ink-3 @3xl/app:inline">As each member chooses</span>
      <div className="flex items-center gap-1">
        {!mail ? (
          <Button variant="secondary" size="md" onClick={onEdit}>
            Use the workspace's own
          </Button>
        ) : mail.pausedUntil ? (
          <Button
            variant="secondary"
            size="md"
            disabled={resume.isPending}
            onClick={() => resume.mutate()}
          >
            Resume
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? "Testing…" : "Test"}
          </Button>
        )}
        {mail && (
          <ActionMenu
            always
            label="Mail"
            actions={[
              { label: "Edit…", onSelect: onEdit },
              ...(mail.bounceUrl ? [{ label: "Bounced addresses…", onSelect: onBounced }] : []),
              "divider",
              {
                label: "Back to the instance's mail",
                danger: true,
                onSelect: () => remove.mutate(),
              },
            ]}
          />
        )}
      </div>
    </Row>
  );
}

function WorkspaceMailDialog({
  saved,
  onClose,
}: {
  saved: WorkspaceMail | null;
  onClose: () => void;
}) {
  const { save } = useWorkspaceMail();
  const [mail, setMail] = useState({
    provider: saved?.provider ?? ("resend" as MailProvider),
    host: saved?.host ?? "",
    port: String(saved?.port ?? mailProviders[saved?.provider ?? "resend"].port ?? 587),
    username: saved?.username ?? "",
    password: "",
    webhookSecret: "",
    tenant: saved?.tenant ?? "",
    clientId: saved?.clientId ?? "",
    url: saved?.url ?? "",
    from: saved?.from ?? "",
  });
  const preset = mailProviders[mail.provider];
  const smtp = preset.transport === "smtp";
  // A secret already stored is kept unless another is typed, for the same provider.
  const keeps = Boolean(saved?.hasSecret && saved.provider === mail.provider);
  const keepsWebhook = Boolean(saved?.hasWebhookSecret && saved.provider === mail.provider);
  const set = (name: keyof typeof mail) => (e: { target: { value: string } }) =>
    setMail({ ...mail, [name]: e.target.value });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      {
        provider: mail.provider,
        from: mail.from,
        ...(smtp && !preset.host && mail.host ? { host: mail.host } : {}),
        ...(smtp && mail.port ? { port: Number(mail.port) } : {}),
        ...(smtp && !preset.username && mail.username ? { username: mail.username } : {}),
        ...(mail.password ? { password: mail.password } : {}),
        ...(mail.webhookSecret ? { webhookSecret: mail.webhookSecret } : {}),
        ...(preset.transport === "microsoft"
          ? { tenant: mail.tenant, clientId: mail.clientId }
          : {}),
        ...(preset.transport === "mailcoach" ? { url: mail.url } : {}),
      },
      { onSuccess: onClose },
    );
  };
  const secret = (
    <Field
      label={preset.secret ?? "Password"}
      hint={keeps ? "Empty keeps the one saved." : undefined}
    >
      <Input
        type="password"
        value={mail.password}
        onChange={set("password")}
        autoComplete="off"
        required={!keeps && (preset.transport !== "smtp" || preset.username !== null)}
      />
    </Field>
  );
  return (
    <Dialog
      title="The workspace's own mail"
      description="Members, guests and invitations are sent through it. Should it keep failing, the instance's mail sends instead until it is put right."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Provider">
          <Select
            value={mail.provider}
            onChange={(e) => {
              const provider = e.target.value as MailProvider;
              setMail({ ...mail, provider, port: String(mailProviders[provider].port ?? "") });
            }}
          >
            {workspaceMailProviders.map((id) => (
              <option key={id} value={id}>
                {mailProviders[id].label}
              </option>
            ))}
          </Select>
        </Field>
        {preset.transport === "microsoft" ? (
          <>
            <Field label="Directory (tenant) ID">
              <Input value={mail.tenant} onChange={set("tenant")} required />
            </Field>
            <Field label="Application (client) ID" hint="An app registration granted Mail.Send.">
              <Input value={mail.clientId} onChange={set("clientId")} required />
            </Field>
            {secret}
          </>
        ) : preset.transport === "mailcoach" ? (
          <>
            <Field label="Address">
              <Input
                value={mail.url}
                onChange={set("url")}
                placeholder="https://endlesshall.mailcoach.app"
                required
              />
            </Field>
            {secret}
          </>
        ) : (
          <>
            {!preset.host && (
              <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-3">
                <Field label="Host">
                  <Input
                    value={mail.host}
                    onChange={set("host")}
                    placeholder={
                      mail.provider === "ses"
                        ? "email-smtp.eu-west-1.amazonaws.com"
                        : "smtp.example.com"
                    }
                    required
                  />
                </Field>
                <Field label="Port">
                  <Input value={mail.port} onChange={set("port")} inputMode="numeric" />
                </Field>
              </div>
            )}
            {!preset.username && (
              <Field label="Username">
                <Input value={mail.username} onChange={set("username")} autoComplete="off" />
              </Field>
            )}
            {secret}
          </>
        )}
        {isBounceProvider(mail.provider) && (
          <Field
            label={bounceSecrets[mail.provider].label}
            hint={
              keepsWebhook
                ? "Empty keeps the one saved."
                : `For bounce reports, so mail stops going to addresses that bounce. ${bounceSecrets[mail.provider].hint}`
            }
          >
            <Input
              type="password"
              value={mail.webhookSecret}
              onChange={set("webhookSecret")}
              autoComplete="off"
            />
          </Field>
        )}
        {isBounceProvider(mail.provider) &&
          saved?.bounceUrl &&
          saved.provider === mail.provider && (
            <Field label="Bounce reports go to" hint="Paste this into the provider's webhook.">
              <Input value={saved.bounceUrl} readOnly onFocus={(e) => e.target.select()} />
            </Field>
          )}
        <Field label="From" hint="An address the provider lets the workspace send as.">
          <Input
            value={mail.from}
            onChange={set("from")}
            placeholder="Endless Hall Records <mail@endlesshall.example>"
            required
          />
        </Field>
        {save.error && <p className="m-0 text-[13px] text-signal">{save.error.message}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Addresses a provider reported as bounced for good or complaining (#161), which mail no longer
 * goes to: the workspace's own provider's, or the instance's. Sending again is for an address put
 * right, or reported in error.
 */
export function SuppressionsDialog({
  scope,
  onClose,
}: {
  scope: "workspace" | "instance";
  onClose: () => void;
}) {
  const { data: rows, isPending } = useQuery(
    scope === "workspace" ? workspaceSuppressionsQuery : instanceSuppressionsQuery,
  );
  const again = useSendAgain(scope);
  return (
    <Dialog
      title="Bounced addresses"
      description="Mail is no longer sent to these: the provider said they bounced for good, or that someone complained."
      onClose={onClose}
      width="md"
    >
      <div className="flex max-h-[60vh] flex-col divide-y divide-line overflow-y-auto rounded-panel border border-line">
        {isPending ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">Loading</p>
        ) : !rows || rows.length === 0 ? (
          <p className="m-0 px-4 py-3 text-[13px] text-ink-3">None: every address is sent to.</p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="truncate text-ink">{r.address}</div>
                <div className="truncate text-[12px] text-ink-3">
                  {r.kind === "bounce" ? "Bounced" : "Complained"} · {ago(r.at)}
                  {r.detail ? ` · ${r.detail}` : ""}
                </div>
              </div>
              <Button
                size="sm"
                disabled={again.isPending && again.variables === r.id}
                onClick={() => again.mutate(r.id)}
              >
                Send again
              </Button>
            </div>
          ))
        )}
      </div>
      {again.isError && (
        <p role="alert" className="m-0 mt-3 text-[13px] text-signal">
          {again.error.message}
        </p>
      )}
    </Dialog>
  );
}
