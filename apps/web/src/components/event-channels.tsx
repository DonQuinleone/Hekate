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
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import { channelsQuery, useChannels } from "~/lib/queries";
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
