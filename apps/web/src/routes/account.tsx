import { channelsFor, type NotificationPreferences } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import {
  AppearanceSection,
  ProfileSection,
  SecondFactorSection,
  SessionsSection,
} from "~/components/account-sections";
import { TokensSection, UsingTheApiSection } from "~/components/api-tokens";
import { MailLogNotice } from "~/components/mail-log-notice";
import { NotificationRows } from "~/components/notification-rows";
import { ConnectedAppsSection } from "~/components/oauth";
import { PageHeader } from "~/components/page-header";
import { PasskeysSection } from "~/components/passkeys";
import { type NavSection, Row, Section, SettingsLayout } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { Segmented } from "~/components/ui/segmented";
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
    id: "security",
    label: "Security",
    intro:
      "How sign-in is guarded, and every browser and device signed in as you. Sign out any you do not recognise, then change your password.",
  },
  {
    id: "tokens",
    label: "API tokens",
    intro: "For scripts and tools of your own, against Hekate's API.",
  },
  {
    id: "apps",
    label: "Connected apps",
    intro: "Applications that act for you here, with what each may do.",
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

function Notifications() {
  const { data: prefs } = useQuery(notificationPreferencesQuery);
  const { data: follows } = useQuery(followsQuery);
  const save = useSaveNotificationPreferences();
  const unfollow = useUnfollow();
  if (!prefs) return <p className="m-0 text-ink-3">Loading</p>;
  const change = (next: Partial<NotificationPreferences>) => save.mutate({ ...prefs, ...next });
  return (
    <>
      <MailLogNotice />
      <Section title="How" intro="By mail at once, or gathered into a digest.">
        <Row
          name="By mail"
          hint={prefs.mailMode === "digest" ? "Daily digests go at 08:00 UTC." : undefined}
        >
          <Segmented
            label="By mail"
            value={prefs.mailMode}
            options={[
              { value: "instant", label: "At once" },
              { value: "digest", label: "Digest" },
            ]}
            onChange={(mailMode) => change({ mailMode })}
          />
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
        <NotificationRows
          preferences={prefs}
          onChange={(kind, channel, on) =>
            change({
              kinds: { ...prefs.kinds, [kind]: { ...channelsFor(prefs, kind), [channel]: on } },
            })
          }
        />
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
  // "sessions" was this section's earlier name; links to it still arrive.
  const id = section === "sessions" ? "security" : section;
  const current = sections.find((s) => s.id === id) ?? sections[0];
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
        {current.id === "security" && (
          <>
            <SecondFactorSection />
            <PasskeysSection />
            <SessionsSection />
          </>
        )}
        {current.id === "tokens" && (
          <>
            <TokensSection kind="personal" />
            <UsingTheApiSection />
          </>
        )}
        {current.id === "apps" && <ConnectedAppsSection />}
        {current.id === "notifications" && <Notifications />}
        {current.id === "appearance" && <AppearanceSection />}
      </SettingsLayout>
    </>
  );
}
