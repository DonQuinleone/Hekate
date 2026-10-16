import {
  alwaysInApp,
  channelsFor,
  type NotificationKind,
  type NotificationPreferences,
  notificationKinds,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { AppearanceSection, ProfileSection, SessionsSection } from "~/components/account-sections";
import { PageHeader } from "~/components/page-header";
import { type NavSection, Row, Section, SettingsLayout } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import {
  followsQuery,
  notificationPreferencesQuery,
  useSaveNotificationPreferences,
  useUnfollow,
} from "~/lib/queries";

const sections: (NavSection & { intro: string })[] = [
  {
    id: "account",
    label: "Account",
    intro: "Who you are to Hekate, and how you sign in.",
  },
  {
    id: "sessions",
    label: "Sessions",
    intro:
      "Every browser and device signed in as you. Sign out any you do not recognise, then change your password.",
  },
  {
    id: "notifications",
    label: "Notifications",
    intro: "What reaches you, and how. These choices are yours, in this workspace.",
  },
  {
    id: "appearance",
    label: "Appearance",
    intro:
      "How Hekate looks, what the recording page shows you, and how the player behaves. Yours alone.",
  },
];

const kindCopy: Record<NotificationKind, string> = {
  review_requested: "A review is asked of you",
  decision: "A decision or feedback on a review you asked for",
  reply: "Someone replies to you",
  mention: "Someone mentions you",
  version: "A new version of a track you follow",
  processing_failed: "Processing fails on your upload",
  guest_opened: "A guest opens a review you asked for",
};

function Channel({
  label,
  checked,
  locked = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  /** Always on: shown, but not to be turned off. */
  locked?: boolean;
  onChange: (on: boolean) => void;
}) {
  const [, channel] = label.split(", ");
  return (
    <span
      className="flex items-center gap-2 text-[12px] text-ink-3"
      title={locked ? "Always on" : undefined}
    >
      <Switch label={label} checked={checked} disabled={locked} onChange={onChange} />
      <span aria-hidden="true" className="w-7">
        {channel}
      </span>
    </span>
  );
}

function Notifications() {
  const { data: prefs } = useQuery(notificationPreferencesQuery);
  const { data: follows } = useQuery(followsQuery);
  const save = useSaveNotificationPreferences();
  const unfollow = useUnfollow();
  if (!prefs) return <p className="m-0 text-ink-3">Loading</p>;
  const change = (next: Partial<NotificationPreferences>) => save.mutate({ ...prefs, ...next });
  const setKind = (kind: NotificationKind, channel: "app" | "mail", on: boolean) =>
    change({ kinds: { ...prefs.kinds, [kind]: { ...channelsFor(prefs, kind), [channel]: on } } });
  return (
    <>
      <Section title="How" intro="By mail at once, or gathered into a digest.">
        <Row
          name="By mail"
          hint={prefs.mailMode === "digest" ? "Daily digests go at 08:00 UTC." : undefined}
        >
          <fieldset className="m-0 flex rounded-control border border-line bg-ground/60 p-0.5">
            <legend className="sr-only">By mail</legend>
            {(["instant", "digest"] as const).map((m) => (
              <label
                key={m}
                className={cn(
                  "flex h-7 cursor-pointer items-center rounded-[4px] px-3 text-[13px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal",
                  prefs.mailMode === m
                    ? "bg-overlay text-ink shadow-2"
                    : "text-ink-3 hover:text-ink",
                )}
              >
                <input
                  type="radio"
                  name="mail-mode"
                  value={m}
                  checked={prefs.mailMode === m}
                  onChange={() => change({ mailMode: m })}
                  className="sr-only"
                />
                {m === "instant" ? "At once" : "Digest"}
              </label>
            ))}
          </fieldset>
          {prefs.mailMode === "digest" && (
            <Select
              aria-label="How often"
              value={prefs.digest}
              onChange={(e) =>
                change({ digest: e.target.value as NotificationPreferences["digest"] })
              }
              className="w-32"
            >
              <option value="hourly">Hourly</option>
              <option value="daily">Daily</option>
            </Select>
          )}
        </Row>
      </Section>
      <Section
        title="What"
        intro="Per event, in the app and by mail. Reviews asked of you and mentions always reach you in the app."
      >
        {notificationKinds.map((kind) => {
          const on = channelsFor(prefs, kind);
          return (
            <Row key={kind} name={kindCopy[kind]}>
              <Channel
                label={`${kindCopy[kind]}, App`}
                checked={on.app}
                locked={alwaysInApp.includes(kind)}
                onChange={(v) => setKind(kind, "app", v)}
              />
              <Channel
                label={`${kindCopy[kind]}, Mail`}
                checked={on.mail}
                onChange={(v) => setKind(kind, "mail", v)}
              />
            </Row>
          );
        })}
      </Section>
      <Section
        title="Following"
        intro="Tracks and reviews you are told about beyond your own part in them."
      >
        {follows && follows.length === 0 && (
          <Row
            name="Nothing yet"
            hint="You follow a track when you make it or add a version to it."
          />
        )}
        {follows?.map((f) => (
          <Row key={f.id} name={f.name} hint={f.projectName}>
            <Button
              variant="ghost"
              disabled={unfollow.isPending}
              onClick={() => unfollow.mutate(f.id)}
            >
              Unfollow
            </Button>
          </Row>
        ))}
      </Section>
    </>
  );
}

/** `/account/$section`: what is yours alone, in every workspace (notifications in this one). */
export function AccountPage({ section }: { section: string }) {
  const current = sections.find((s) => s.id === section) ?? sections[0];
  if (!current) return null;
  return (
    <>
      <PageHeader title="Your account" />
      <SettingsLayout
        title={current.label}
        intro={current.intro}
        sections={sections}
        current={current.id}
        base="/account/$section"
        param="section"
      >
        {current.id === "account" && <ProfileSection />}
        {current.id === "sessions" && <SessionsSection />}
        {current.id === "notifications" && <Notifications />}
        {current.id === "appearance" && <AppearanceSection />}
      </SettingsLayout>
    </>
  );
}
