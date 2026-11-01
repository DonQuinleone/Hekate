import {
  type ChannelKind,
  type ChannelRow,
  channelKindLabels,
  channelKinds,
  channelUrlHints,
  type EventKind,
  eventKinds,
  eventLabels,
  eventsSummary,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import {
  channelsQuery,
  instanceSuppressionsQuery,
  useChannels,
  useSendAgain,
  workspaceSuppressionsQuery,
} from "~/lib/queries";
import { Icon } from "./icons";
import { Row, Section } from "./settings";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";
import { Dialog, useConfirm } from "./ui/dialog";
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
 * The workspace's channels (#161), as the prototype has them: each with a test, and a matrix of
 * which events each carries. A channel that keeps failing pauses itself; Resume starts it again
 * at once. The workspace's mail is set up on the Email page (#591).
 */
export function ChannelsSection() {
  const { data: channels } = useQuery(channelsQuery);
  const [confirm, confirmation] = useConfirm();
  const { change, remove, test } = useChannels();
  const [editing, setEditing] = useState<ChannelRow | "new" | null>(null);
  const [choosing, setChoosing] = useState<ChannelRow | null>(null);
  const [tested, setTested] = useState<{ id: string; ok: boolean; result: string } | null>(null);
  if (!channels) return null;
  const toggle = (c: ChannelRow, kind: EventKind) =>
    change.mutate({
      id: c.id,
      events: c.events.includes(kind) ? c.events.filter((e) => e !== kind) : [...c.events, kind],
    });
  return (
    <>
      {/* The page is Channels (#681): its first section needs no heading of its own. */}
      <Section
        intro="Each channel has its own fields and a test; a channel that keeps failing pauses itself."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            New channel
          </Button>
        }
      >
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
                  {
                    label: "Remove…",
                    danger: true,
                    onSelect: () =>
                      confirm({
                        title: `Remove ${c.name}?`,
                        description:
                          "Nothing more is sent to it. What it was sent before stays where it went.",
                        action: "Remove channel",
                        onConfirm: () => remove.mutateAsync(c.id),
                      }),
                  },
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
      {choosing && (
        <EventsDialog
          channel={channels.find((c) => c.id === choosing.id) ?? choosing}
          onClose={() => setChoosing(null)}
        />
      )}
      {confirmation}
    </>
  );
}

/**
 * Which events each channel carries: a row for each kind, a column for each channel. On a phone
 * one channel's column is shown at a time, chosen above the table, as Defaults' Tool access does
 * (#681), so every channel is reachable without a sideways scroll that hides the others.
 */
function EventsMatrix({
  channels,
  onToggle,
  disabled,
}: {
  channels: ChannelRow[];
  onToggle: (c: ChannelRow, kind: EventKind) => void;
  disabled: boolean;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = channels.find((c) => c.id === chosen)?.id ?? channels[0]?.id;
  const column = (c: ChannelRow) => (c.id === shown ? "" : "hidden @3xl/app:table-cell");
  return (
    <section aria-label="Events" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-medium text-ink">Events</h2>
          <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
            Which events each channel carries.
          </p>
        </div>
        {channels.length > 1 && (
          <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
            <label htmlFor="events-channel-shown">Channel</label>
            <Select
              id="events-channel-shown"
              size="sm"
              value={shown}
              onChange={(event) => setChosen(event.target.value)}
              className="w-auto"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-raised/25 shadow-1">
        <table
          className="w-full border-collapse text-[13px] @3xl/app:min-w-[var(--events-width)]"
          style={{ "--events-width": `${240 + channels.length * 112}px` } as CSSProperties}
        >
          <thead>
            <tr>
              <th className="label px-4 py-2 text-left font-normal">Event</th>
              {channels.map((c) => (
                <th
                  key={c.id}
                  className={cn("w-[112px] px-2 py-2 text-center font-normal last:pr-4", column(c))}
                >
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
                  <td key={c.id} className={cn("px-2 py-2 text-center last:pr-4", column(c))}>
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
        <Field label="Name" hint="Shown in this list and in the webhook log.">
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
          <Loading size="panel" />
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
