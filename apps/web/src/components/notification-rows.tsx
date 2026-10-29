import {
  alwaysInApp,
  channelsFor,
  type NotificationChannels,
  type NotificationKind,
  type NotificationPreferences,
  notificationCatalogue,
  notificationChannelKeys,
  notificationChannelLabels,
  notificationKinds,
} from "@hekate/shared";
import { Row } from "~/components/settings";
import { Switch } from "~/components/ui/toggle";

/** One channel's switch: named for the event and the channel, headed by the channel alone. */
function Channel({
  kind,
  channel,
  checked,
  onChange,
}: {
  kind: NotificationKind;
  channel: keyof NotificationChannels;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  // A kind that always reaches you in the app is shown on, but not to be turned off.
  const locked = channel === "app" && alwaysInApp.includes(kind);
  const heading = notificationChannelLabels[channel];
  return (
    <span
      className="flex items-center gap-2 text-[12px] text-ink-3"
      title={locked ? "Always on" : undefined}
    >
      <Switch
        label={`${notificationCatalogue[kind].title}, ${heading}`}
        checked={checked}
        disabled={locked}
        onChange={onChange}
      />
      <span aria-hidden="true" className="w-7">
        {heading}
      </span>
    </span>
  );
}

/**
 * Every kind of notification as a row (#504): the event, what it means on a line of its own,
 * then its App and Mail switches. The switches are headed by the channel's name, never by the
 * event's words.
 */
export function NotificationRows({
  preferences,
  onChange,
}: {
  preferences: Pick<NotificationPreferences, "kinds">;
  onChange: (kind: NotificationKind, channel: keyof NotificationChannels, on: boolean) => void;
}) {
  return (
    <>
      {notificationKinds.map((kind) => {
        const on = channelsFor(preferences, kind);
        const { title, description } = notificationCatalogue[kind];
        return (
          <Row key={kind} name={title} hint={description}>
            {notificationChannelKeys.map((channel) => (
              <Channel
                key={channel}
                kind={kind}
                channel={channel}
                checked={on[channel]}
                onChange={(v) => onChange(kind, channel, v)}
              />
            ))}
          </Row>
        );
      })}
    </>
  );
}
