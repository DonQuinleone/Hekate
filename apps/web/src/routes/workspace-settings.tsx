import {
  accessWindowDays,
  type CommentScope,
  type CustomProfile,
  type DateFormat,
  type DefaultRoleName,
  type DownloadLevel,
  dateFormatLabels,
  defaultRoleNames,
  deliveryProfileIds,
  deliveryProfiles,
  encryptionWords,
  formatBytes,
  type GuestVerification,
  guestLinkDays,
  handlingWords,
  locales,
  mayExportWorkspace,
  type ProfileRef,
  type ProjectProfile,
  playerTools,
  profiles,
  type SecondFactorPolicy,
  type SignInMethod,
  type SupportMode,
  secondFactorPolicies,
  sessionDayChoices,
  signInMethodLabels,
  signInMethods,
  type TimeFormat,
  timeFormatLabels,
  type WorkspaceSettingsInput,
} from "@hekate/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import {
  ApiAndMcpSection,
  ScopesSection,
  TokensSection,
  WorkspaceApiLogSection,
} from "~/components/api-tokens";
import { Avatar } from "~/components/avatar";
import { BillingSection } from "~/components/billing";
import { BrandingSection } from "~/components/branding";
import { CategoryDialog } from "~/components/category-dialog";
import { deliveryHint, ProfileEditor, ProfileOptions } from "~/components/delivery-profiles";
import { DirectorySection } from "~/components/directory";
import { EmailTemplatesSection } from "~/components/email-templates";
import { Empty } from "~/components/empty";
import { ChannelsSection } from "~/components/event-channels";
import { Icon, type IconName } from "~/components/icons";
import { LeakTracingSection } from "~/components/leak-tracing";
import { OAuthClientsSection } from "~/components/oauth";
import { PageHeader } from "~/components/page-header";
import { PlayerToolsTable } from "~/components/player-tools";
import { TransfersSection } from "~/components/project-transfer";
import {
  Danger,
  dateFormatChoices,
  Row,
  Section,
  SettingsLayout,
  SwitchRow,
  timeFormatChoices,
} from "~/components/settings";
import { SsoSection } from "~/components/sso";
import { type AskedFrom, SupportSection } from "~/components/support";
import { Button } from "~/components/ui/button";
import { ToggleChip } from "~/components/ui/chip";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Floating } from "~/components/ui/floating";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu, type MenuAction, usePopover } from "~/components/ui/menu";
import { StorageUsageRow, UsageRows } from "~/components/usage";
import { DeleteWorkspace, WorkspaceExports } from "~/components/workspace-lifecycle";
import {
  actionCopy,
  exportUrl,
  filtered,
  type LogFilterKey,
  type LogFilters,
  type LogSince,
  logFilterKeys,
  logSince,
  logSinceLabels,
  without,
} from "~/lib/access-log";
import { shortAgent } from "~/lib/agent";
import { cn } from "~/lib/cn";
import { formatDates, languageNames } from "~/lib/locale";
import {
  type AccessEvent,
  accessLogQuery,
  type CommentCategory,
  customProfilesQuery,
  directoryQuery,
  invitationsQuery,
  type Me,
  type Member,
  membersQuery,
  meQuery,
  projectsQuery,
  type StorageUsage,
  ssoQuery,
  storageUsageQuery,
  useCustomProfileMutations,
  useOrganisationMutations,
  useReconcile,
  useRenameWorkspace,
  useRevokeGuest,
  useSaveWorkspaceSettings,
  useWorkspaceCategoryMutations,
  useWorkspaceStorage,
  workspaceCategoriesQuery,
  workspaceGuestsQuery,
  workspaceOperationsQuery,
  workspaceSettingsQuery,
  workspaceSettingsWithLimitsQuery,
  workspaceStorageQuery,
} from "~/lib/queries";

type Role = Member["role"];
const roleLabel: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const roles: Role[] = ["owner", "admin", "member"];

const dateFormat = formatDates({ day: "numeric", month: "short" });
const timeFormat = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

interface SectionSpec {
  id: string;
  label: string;
  group: string;
  /** The least role that sees the section. */
  from: Role;
  intro: string;
  /** Its page on the documentation site. */
  docs?: string;
}

/** The workspace's settings, grouped as in the prototype; more sections arrive with their issues. */
const allSections: SectionSpec[] = [
  {
    id: "general",
    label: "General",
    group: "Workspace",
    from: "admin",
    intro:
      "The workspace's name, how new projects start, guest links and its language; for owners, exporting or deleting it.",
  },
  {
    id: "defaults",
    label: "Defaults",
    group: "Workspace",
    from: "admin",
    intro:
      "What a review grants its reviewers, and what a new project starts with, unless the request or the project says otherwise.",
  },
  {
    id: "categories",
    label: "Comment categories",
    group: "Workspace",
    from: "admin",
    intro:
      "The labels a comment can carry, such as Noise or Balance, and where triage sends each kind. Every new project starts with these.",
  },
  {
    id: "delivery",
    label: "Delivery profiles",
    group: "Workspace",
    from: "admin",
    intro: "What QA measures recordings against: the built-in profiles, and the workspace's own.",
  },
  {
    id: "branding",
    label: "Branding",
    group: "Workspace",
    from: "admin",
    intro:
      "The workspace's logo and accent, on its sign-in page, guest pages and email. Hekate's own mark stays in the app.",
    docs: "/use/branding/",
  },
  {
    id: "email",
    label: "Email templates",
    group: "Workspace",
    from: "admin",
    intro: "The messages Hekate sends for the workspace, as each kind of mail client shows them.",
  },
  {
    id: "members",
    label: "Members",
    group: "Access",
    from: "member",
    intro: "Who has an account here, who is invited, and which guests hold a link.",
    docs: "/use/guests/",
  },
  {
    id: "security",
    label: "Security",
    group: "Access",
    from: "admin",
    intro:
      "How members sign in: the ways allowed, the second factor, single sign-on or a directory, and how long a session lasts.",
    docs: "/security/model/",
  },
  {
    id: "notifications",
    label: "Notifications and integrations",
    group: "Access",
    from: "admin",
    intro: "Where the workspace's events go: Slack, Discord, Microsoft Teams and webhooks.",
    docs: "/use/integrations/",
  },
  {
    id: "api",
    label: "API and OAuth clients",
    group: "Access",
    from: "admin",
    intro:
      "Applications that ask people for access, tokens that act for the workspace, what either may be given, and every call one made.",
    docs: "/use/oauth/",
  },
  {
    id: "billing",
    label: "Billing",
    group: "Plan and help",
    from: "admin",
    intro: "The plan, what it includes, what it costs, and every invoice.",
    docs: "/operate/billing/",
  },
  {
    id: "support",
    label: "Support",
    group: "Plan and help",
    from: "member",
    intro: "Ask the people who run this instance, with the error reference if there is one.",
    docs: "/use/support/",
  },
  {
    id: "transfers",
    label: "Transfers",
    group: "Operations",
    from: "member",
    intro: "Projects moving in from, or out to, another workspace, and what each waits for.",
  },
  {
    id: "storage",
    label: "Storage",
    group: "Operations",
    from: "admin",
    intro: "Where new files are kept. Everything is encrypted before any backend sees it.",
    docs: "/install/storage/",
  },
  {
    id: "leaks",
    label: "Leak tracing",
    group: "Operations",
    from: "owner",
    intro: "Find which recipient a leaked file was watermarked for.",
    docs: "/use/leak-tracing/",
  },
  {
    id: "log",
    label: "Access log",
    group: "Operations",
    from: "admin",
    intro: "Every key issue, page render and download, and the changes that matter.",
    docs: "/security/model/#audit",
  },
  {
    id: "operations",
    label: "Operations",
    group: "Operations",
    from: "owner",
    intro:
      "How the workspace's files are kept, what they take against the plan, and taking everything away or deleting it. The instance itself is its operators'.",
    docs: "/use/export-and-delete/",
  },
];

const rank: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/** The file or review the help menu was opened on, from `file:<id>` or `review:<id>`. */
const askedFrom = (from?: string): AskedFrom | undefined => {
  const [kind, id] = from?.split(":") ?? [];
  return (kind === "file" || kind === "review") && id ? { kind, id } : undefined;
};

/**
 * The sections a role may open. Members see Members, Transfers and Support; the server checks
 * every call again. Billing shows only with the billing module on (#179), Support only with the
 * support module (#181).
 */
export const sectionsFor = (role: Role, billing = false, support: SupportMode = "off") =>
  allSections.filter(
    (s) =>
      rank[role] >= rank[s.from] &&
      (s.id !== "billing" || billing) &&
      (s.id !== "support" || support !== "off"),
  );

function General({ role }: { role: Role }) {
  const { data: me } = useQuery(meQuery);
  const rename = useRenameWorkspace();
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  const [name, setName] = useState<string | null>(null);
  if (!me || !workspace) return null;
  const value = name ?? workspace.name;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && value !== workspace.name)
      rename.mutate(value, { onSuccess: () => setName(null) });
  };
  return (
    <>
      <Section title="Workspace">
        <Row
          name="Name"
          hint={
            role === "owner"
              ? "Shown to members, guests and in every email."
              : "Only an owner can change it."
          }
        >
          {role === "owner" ? (
            <form onSubmit={save} className="flex items-center gap-2">
              <Input
                aria-label="Workspace name"
                value={value}
                onChange={(e) => setName(e.target.value)}
                className="w-64"
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={rename.isPending || !value.trim() || value === workspace.name}
              >
                Save
              </Button>
            </form>
          ) : (
            <span className="text-[14px] text-ink-2">{workspace.name}</span>
          )}
        </Row>
        {rename.error && (
          <p className="px-4 py-2 text-[13px] text-signal">{rename.error.message}</p>
        )}
        <WorkspaceRows />
      </Section>
      <Section
        title="Workspaces you are in"
        intro="Switch from the menu at the foot of the sidebar."
      >
        {me.organisations.map((o) => (
          <Row
            key={o.id}
            name={o.name}
            hint={`${roleLabel[o.role]}${o.id === me.activeOrganisationId ? " · open now" : ""}`}
          />
        ))}
      </Section>
    </>
  );
}

/** Saves one change to the workspace's settings, and says if it was refused. */
function useSettings() {
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const save = useSaveWorkspaceSettings();
  return {
    settings,
    change: (change: WorkspaceSettingsInput) => save.mutate(change),
    pending: save.isPending,
    error: save.error && (
      <p role="alert" className="px-4 py-2 text-[13px] text-signal">
        {save.error.message}
      </p>
    ),
  };
}

/** The guest link lifetime, the language and the dates, in the General section's Workspace panel. */
function WorkspaceRows() {
  const { settings, change, pending, error } = useSettings();
  // The instance's own date and time formats (#481), which this workspace follows unless it chooses.
  const { data: limits } = useQuery(workspaceSettingsWithLimitsQuery);
  const instance = limits?.instance ?? { dateFormat: "iso", timeFormat: "24h" };
  if (!settings) return null;
  return (
    <>
      <Row name="New projects start as" hint="The profile only decides which tools appear.">
        <Select
          aria-label="New projects start as"
          className="w-40"
          disabled={pending}
          value={settings.defaultProfile}
          onChange={(e) => change({ defaultProfile: e.target.value as ProjectProfile })}
        >
          {(Object.keys(profiles) as ProjectProfile[]).map((p) => (
            <option key={p} value={p}>
              {profiles[p].label}
            </option>
          ))}
        </Select>
      </Row>
      <Row
        name="Guests sign in with"
        hint="The link alone, or the link plus a code sent to their email, so a forwarded link opens nothing."
      >
        <Select
          aria-label="Guests sign in with"
          className="w-56"
          disabled={pending}
          value={settings.guestVerification}
          onChange={(e) => change({ guestVerification: e.target.value as GuestVerification })}
        >
          <option value="link">The link alone</option>
          <option value="code">A code by email</option>
        </Select>
      </Row>
      <Row
        name="Guest links last"
        hint="A guest's link works once, for this long after it is sent."
      >
        <Select
          aria-label="Guest links last"
          className="w-40"
          disabled={pending}
          value={settings.guestLinkDays}
          onChange={(e) =>
            change({ guestLinkDays: Number(e.target.value) as (typeof guestLinkDays)[number] })
          }
        >
          {guestLinkDays.map((d) => (
            <option key={d} value={d}>
              {d} days
            </option>
          ))}
        </Select>
      </Row>
      <Row name="Language" hint="For members who have not chosen their own in Account.">
        <Select
          aria-label="Language"
          className="w-56"
          disabled={pending}
          value={settings.locale ?? ""}
          onChange={(e) =>
            change({ locale: (e.target.value || null) as (typeof locales)[number] | null })
          }
        >
          <option value="">As each browser has it</option>
          {locales.map((l) => (
            <option key={l} value={l}>
              {languageNames.of(l) ?? l}
            </option>
          ))}
        </Select>
      </Row>
      <Row name="Dates" hint="How dates read here, in lists, comments, mail and exports.">
        <Select
          aria-label="Dates"
          className="w-56"
          disabled={pending}
          value={settings.dateFormat ?? ""}
          onChange={(e) => change({ dateFormat: (e.target.value || null) as DateFormat | null })}
        >
          <option value="">Instance default ({dateFormatLabels[instance.dateFormat]})</option>
          {dateFormatChoices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Row>
      <Row name="Times" hint="The clock beside them.">
        <Select
          aria-label="Times"
          className="w-56"
          disabled={pending}
          value={settings.timeFormat ?? ""}
          onChange={(e) => change({ timeFormat: (e.target.value || null) as TimeFormat | null })}
        >
          <option value="">Instance default ({timeFormatLabels[instance.timeFormat]})</option>
          {timeFormatChoices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Row>
      {error}
    </>
  );
}

const policyLabel: Record<SecondFactorPolicy, string> = {
  off: "Nobody",
  admins: "Owners and admins",
  everyone: "Everyone",
};

/** "1 day", "7 days". */
const daysWords = (n: number) => (n === 1 ? "1 day" : `${n} days`);

/**
 * The ways members may sign in (decision 248), as chips that turn on and off: a password and a
 * passkey always, single sign-on and the directory once the workspace has them on. The last one
 * allowed stays on. Single sign-on and the directory, set further down, come and go as they do.
 */
function MethodsAllowed({
  allowed,
  disabled,
  onChange,
}: {
  allowed: SignInMethod[];
  disabled: boolean;
  onChange: (methods: SignInMethod[]) => void;
}) {
  const { data: sso } = useQuery(ssoQuery);
  const { data: directory } = useQuery(directoryQuery);
  const offered = signInMethods.filter(
    (m) => (m !== "sso" || sso?.sso.enabled) && (m !== "directory" || directory?.directory.enabled),
  );
  return (
    <fieldset className="m-0 flex flex-wrap gap-1.5 border-0 p-0">
      <legend className="sr-only">Methods allowed</legend>
      {offered.map((m) => {
        const on = allowed.includes(m);
        const last = on && allowed.filter((a) => offered.includes(a)).length === 1;
        return (
          <ToggleChip
            key={m}
            pressed={on}
            disabled={disabled || last}
            title={last ? "One way in stays allowed" : undefined}
            onClick={() =>
              onChange(signInMethods.filter((x) => (x === m ? !on : allowed.includes(x))))
            }
          >
            {signInMethodLabels[m]}
          </ToggleChip>
        );
      })}
    </fieldset>
  );
}

/**
 * How members sign in: the ways allowed, who must add a second factor (asking it of others
 * starts with having one), and how long a session lasts here, within the instance's own length.
 */
function Security() {
  const { settings, change, pending, error } = useSettings();
  const { data: limits } = useQuery(workspaceSettingsWithLimitsQuery);
  if (!settings) return null;
  const instanceDays = limits?.instance.sessionDays ?? 14;
  return (
    <Section title="Sign-in policy">
      <Row
        name="Methods allowed"
        hint="Members pick from these; guests always use their link. An owner keeps a password or passkey when only single sign-on or a directory is allowed."
      >
        <MethodsAllowed
          allowed={settings.signInMethods}
          disabled={pending}
          onChange={(signInMethods) => change({ signInMethods })}
        />
      </Row>
      <Row
        name="Second factor required of"
        hint="A code app, with recovery codes. People without one are asked at their next sign-in and cannot carry on until they add one. Guests use their link."
      >
        <Select
          aria-label="Second factor required of"
          className="w-48"
          disabled={pending}
          value={settings.secondFactor}
          onChange={(e) => change({ secondFactor: e.target.value as SecondFactorPolicy })}
        >
          {secondFactorPolicies.map((p) => (
            <option key={p} value={p}>
              {policyLabel[p]}
            </option>
          ))}
        </Select>
      </Row>
      <SwitchRow
        name="Passkey or hardware security key required for owners and admins"
        hint="They sign in with a passkey or hardware security key; a code app is not enough."
        checked={settings.securityKeyForAdmins}
        onChange={(securityKeyForAdmins) => change({ securityKeyForAdmins })}
      />
      <Row
        name="Sessions end after"
        hint={`Counted from signing in, however much it is used. The instance ends any session unused for ${daysWords(instanceDays)}.`}
      >
        <Select
          aria-label="Sessions end after"
          className="w-48"
          disabled={pending}
          value={settings.sessionDays === null ? "" : String(settings.sessionDays)}
          onChange={(e) =>
            change({
              sessionDays: e.target.value
                ? (Number(e.target.value) as (typeof sessionDayChoices)[number])
                : null,
            })
          }
        >
          <option value="">As the instance has it</option>
          {sessionDayChoices
            .filter((d) => d < instanceDays)
            .map((d) => (
              <option key={d} value={d}>
                {daysWords(d)}
              </option>
            ))}
        </Select>
      </Row>
      {error}
    </Section>
  );
}

/**
 * The comment categories every new project starts with (decision 247): copied when a project is
 * made, so a change here reaches only projects made after it. Each project adds its own.
 */
function WorkspaceCategories() {
  const { data: categories } = useQuery(workspaceCategoriesQuery);
  const mutations = useWorkspaceCategoryMutations();
  const { remove } = mutations;
  const [editing, setEditing] = useState<CommentCategory | "new" | null>(null);
  const [deleting, setDeleting] = useState<CommentCategory | null>(null);
  return (
    <>
      <Section
        title="Comment categories"
        intro="The set every new project starts with. A project may add its own."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Category
          </Button>
        }
      >
        {!categories && <Row name="Loading" />}
        {categories?.length === 0 && (
          <Row
            name="No categories"
            hint="New projects start without any; triage works without one, and each project can add its own."
          />
        )}
        {categories?.map((c) => (
          <Row
            key={c.id}
            name={c.name}
            inline
            hint={
              c.handling === "deferred"
                ? `Deferred to a stage named ${c.stage}`
                : handlingWords[c.handling]
            }
          >
            <ActionMenu
              always
              label={c.name}
              actions={[
                { label: "Rename or change handling…", onSelect: () => setEditing(c) },
                "divider",
                { label: "Delete…", danger: true, onSelect: () => setDeleting(c) },
              ]}
            />
          </Row>
        ))}
      </Section>
      {editing && (
        <CategoryDialog
          mutations={mutations}
          category={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${deleting.name}?`}
          description="New projects start without it. Projects that have it keep theirs."
          onClose={() => setDeleting(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Delete
              </Button>
            </>
          }
        >
          {remove.error && <p className="text-[13px] text-signal">{remove.error.message}</p>}
        </Dialog>
      )}
    </>
  );
}

const scopeLabel: Record<CommentScope, string> = {
  all: "Everyone's",
  own_and_replies: "Their own and replies to them",
  own: "Only their own",
};

/** What a review grants unless its request says otherwise. */
/** The built-in profiles and the workspace's own (#144), and which one projects start from. */
function DeliveryProfiles() {
  const { settings, change, pending, error } = useSettings();
  const { data: customs = [] } = useQuery(customProfilesQuery);
  const { remove } = useCustomProfileMutations();
  const [editing, setEditing] = useState<CustomProfile | "new" | null>(null);
  const [deleting, setDeleting] = useState<CustomProfile | null>(null);
  if (!settings) return null;
  return (
    <>
      <Section title="Workspace default">
        <Row
          name="Measured against"
          hint="For projects, tracks and files that choose nothing nearer."
        >
          <Select
            aria-label="Measured against"
            className="w-full @3xl/app:w-60"
            disabled={pending}
            value={settings.deliveryProfile ?? ""}
            onChange={(e) =>
              change({ deliveryProfile: (e.target.value || null) as ProfileRef | null })
            }
          >
            <option value="">Suggested from each file</option>
            <ProfileOptions customs={customs} />
          </Select>
        </Row>
      </Section>
      {error}
      {remove.error && <p className="-mt-6 text-[13px] text-signal">{remove.error.message}</p>}
      <Section
        title="Profiles"
        intro="The built-in ones cannot be changed; add your own."
        action={
          <Button variant="secondary" size="md" onClick={() => setEditing("new")}>
            <Icon name="plus" size={14} />
            Profile
          </Button>
        }
      >
        {customs.map((p) => (
          <Row key={p.id} name={p.label} hint={deliveryHint(p)} inline>
            <ActionMenu
              always
              label={p.label}
              actions={[
                { label: "Edit…", onSelect: () => setEditing(p) },
                "divider",
                { label: "Delete…", danger: true, onSelect: () => setDeleting(p) },
              ]}
            />
          </Row>
        ))}
        {deliveryProfileIds.map((id) => (
          <Row
            key={id}
            name={deliveryProfiles[id].label}
            hint={deliveryHint(deliveryProfiles[id])}
            inline
          >
            <span className="text-[12px] text-ink-3">Built in</span>
          </Row>
        ))}
      </Section>
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <Dialog
          title={`Delete ${deleting.label}?`}
          description="Projects, tracks and files that chose it measure against the next choice up instead."
          onClose={() => setDeleting(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" size="md" onClick={() => setDeleting(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="md"
                disabled={remove.isPending}
                onClick={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
              >
                Delete
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      )}
    </>
  );
}

function Defaults() {
  const { settings, change, pending, error } = useSettings();
  if (!settings) return null;
  const { reviewer } = settings;
  return (
    <>
      <Section
        title="Reviewer permissions"
        intro="A member's project role is always the ceiling. Changes apply to reviews requested from now on."
      >
        <SwitchRow
          name="May comment"
          checked={reviewer.comment}
          onChange={(comment) => change({ reviewer: { comment } })}
        />
        <SwitchRow
          name="May decide, in an approval"
          hint="Off, an approval must say who may decide; reviewers who may not only follow it."
          checked={reviewer.decide}
          onChange={(decide) => change({ reviewer: { decide } })}
        />
        <Row name="Comments they see">
          <Select
            aria-label="Comments they see"
            className="w-56"
            disabled={pending}
            value={reviewer.comments}
            onChange={(e) => change({ reviewer: { comments: e.target.value as CommentScope } })}
          >
            {(Object.keys(scopeLabel) as CommentScope[]).map((scope) => (
              <option key={scope} value={scope}>
                {scopeLabel[scope]}
              </option>
            ))}
          </Select>
        </Row>
        <SwitchRow
          name="May see earlier versions"
          hint="A track's versions before the one under review."
          checked={reviewer.history}
          onChange={(history) => change({ reviewer: { history } })}
        />
        <Row name="Download" hint="Marked where the file allows, and logged.">
          <Select
            aria-label="Download"
            className="w-56"
            disabled={pending}
            value={reviewer.download}
            onChange={(e) => change({ reviewer: { download: e.target.value as DownloadLevel } })}
          >
            <option value="none">Nothing</option>
            <option value="proxy">The proxy</option>
            <option value="original">The original</option>
          </Select>
        </Row>
        <Row name="Access window" hint="Counted from when their access opens.">
          <Select
            aria-label="Access window"
            className="w-56"
            disabled={pending}
            value={reviewer.windowDays ?? ""}
            onChange={(e) =>
              change({
                reviewer: {
                  windowDays: e.target.value
                    ? (Number(e.target.value) as (typeof accessWindowDays)[number])
                    : null,
                },
              })
            }
          >
            <option value="">While the review is open</option>
            {accessWindowDays.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </Select>
        </Row>
        {error}
      </Section>
      <Section title="Versions" intro="What new projects start with; each project can change it.">
        <SwitchRow
          name="Carried comments shown on the new version"
          hint="Open comments travel to the next version; off keeps them hidden until triage shows them."
          checked={settings.carriedCommentsShown}
          onChange={(carriedCommentsShown) => change({ carriedCommentsShown })}
        />
      </Section>
      <ToolAccess />
    </>
  );
}

/** The player tools the five default roles start with in a new project (#55). */
function ToolAccess() {
  const { settings, change, pending, error } = useSettings();
  // On a phone one role is shown at a time, chosen above the table.
  const [shown, setShown] = useState<DefaultRoleName>(defaultRoleNames[0]);
  if (!settings) return null;
  const roles = defaultRoleNames.map((name) => ({
    id: name,
    name,
    tools: settings.roleTools[name],
  }));
  return (
    <section aria-label="Tool access" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] font-medium text-ink">Tool access</h2>
          <p className="mt-0.5 max-w-[620px] text-[13px] text-ink-3">
            What the five default roles get in a new project. Each project can change its own.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[13px] text-ink-3 @3xl/app:hidden">
          <label htmlFor="default-role-shown">Role</label>
          <Select
            id="default-role-shown"
            size="sm"
            value={shown}
            onChange={(event) => setShown(event.target.value as DefaultRoleName)}
            className="w-auto"
          >
            {defaultRoleNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <PlayerToolsTable
        roles={roles}
        // Each change is built from the settings shown, so one waits for the last to land.
        manage={!pending}
        column={(role) => (role === shown ? "" : "hidden @3xl/app:table-cell")}
        onToggle={(role, tool, on) => {
          const name = role as DefaultRoleName;
          const tools = settings.roleTools[name];
          change({
            roleTools: {
              [name]: on
                ? playerTools.filter((t) => t === tool || tools.includes(t))
                : tools.filter((t) => t !== tool),
            },
          });
        }}
      />
      {error}
    </section>
  );
}

function InviteDialog({ myRole, onClose }: { myRole: Role; onClose: () => void }) {
  const { invite } = useOrganisationMutations();
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email"));
    invite.mutate(
      { email, role },
      {
        onSuccess: (res) => {
          setLink(res.link);
          setCopied(false);
          form.reset();
        },
      },
    );
  };
  const allowed = roles.filter((r) => r !== "owner" || myRole === "owner");
  return (
    <Dialog
      title="Invite to the workspace"
      description="They get an email with a link that works once, for 7 days."
      onClose={onClose}
      width="sm"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Email
          <Input name="email" type="email" required placeholder="name@example.com" />
        </label>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Role
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {allowed.map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </Select>
        </label>
        {invite.error && <p className="text-[13px] text-signal">{invite.error.message}</p>}
        {link && (
          <div className="flex items-center gap-2 rounded-control border border-line bg-ground/60 p-2 pl-3">
            <span className="tabular min-w-0 flex-1 truncate text-[12px] text-ink-2">{link}</span>
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {link ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" type="submit" disabled={invite.isPending}>
            {link ? "Invite another" : "Send invitation"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Members({ role: myRole }: { role: Role }) {
  const { data: me } = useQuery(meQuery);
  const { data: members } = useQuery(membersQuery);
  const elevated = myRole === "owner" || myRole === "admin";
  const { data: invitations } = useQuery({ ...invitationsQuery, enabled: elevated });
  const { setRole, remove, revoke } = useOrganisationMutations();
  const [inviting, setInviting] = useState(false);
  const error = setRole.error ?? remove.error ?? revoke.error;
  const owners = members?.filter((m) => m.role === "owner").length ?? 0;
  // Nobody else yet, and nobody invited: say what to do next, as the prototype does.
  const alone =
    members?.length === 1 &&
    members[0]?.userId === me?.user.id &&
    (!elevated || invitations?.length === 0);
  return (
    <>
      {inviting && <InviteDialog myRole={myRole} onClose={() => setInviting(false)} />}
      {alone ? (
        <Empty
          title="Just you so far"
          text="Invite the people you work with. They get an email with a link that works once."
          action={
            elevated && (
              <Button variant="primary" onClick={() => setInviting(true)}>
                Invite
              </Button>
            )
          }
        />
      ) : (
        <Section
          title={`Members${members ? ` · ${members.length}` : ""}`}
          action={
            elevated && (
              <Button variant="primary" onClick={() => setInviting(true)}>
                <Icon name="plus" size={14} />
                Invite
              </Button>
            )
          }
        >
          {error && <p className="px-4 py-2 text-[13px] text-signal">{error.message}</p>}
          {members?.map((m) => {
            const isSelf = m.userId === me?.user.id;
            // Owners manage everyone; admins everyone but owners; the last owner stays an owner.
            const canEdit =
              elevated &&
              (myRole === "owner" || m.role !== "owner") &&
              !(m.role === "owner" && owners === 1);
            return (
              <div
                key={m.id}
                className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-raised/30"
              >
                <Avatar id={m.userId} name={m.name} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">
                    {m.name}
                    {isSelf && <span className="text-ink-3"> · you</span>}
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">{m.email}</span>
                </span>
                {canEdit ? (
                  <Select
                    aria-label={`Role of ${m.name}`}
                    value={m.role}
                    onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value as Role })}
                    className="h-8 w-32 text-[13px]"
                  >
                    {roles
                      .filter((r) => r !== "owner" || myRole === "owner")
                      .map((r) => (
                        <option key={r} value={r}>
                          {roleLabel[r]}
                        </option>
                      ))}
                  </Select>
                ) : (
                  <span
                    className="w-32 text-right text-[13px] text-ink-2"
                    title={
                      m.role === "owner" && owners === 1
                        ? "The last owner cannot change role"
                        : undefined
                    }
                  >
                    {roleLabel[m.role]}
                  </span>
                )}
                {canEdit || isSelf ? (
                  <ActionMenu
                    label={m.name}
                    actions={[
                      {
                        label: isSelf ? "Leave the workspace" : "Remove from the workspace",
                        danger: true,
                        onSelect: () => remove.mutate(m.id),
                      },
                    ]}
                  />
                ) : (
                  <span className="size-7 shrink-0" />
                )}
              </div>
            );
          })}
        </Section>
      )}
      {elevated && invitations && invitations.length > 0 && (
        <Section title={`Invited · ${invitations.length}`}>
          {invitations.map((i) => (
            <div key={i.id} className="group flex items-center gap-3 px-4 py-2.5">
              <Icon name="mail" className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{i.email}</span>
              <span className="text-[13px] text-ink-3">
                {roleLabel[i.role]} · until {dateFormat.format(new Date(i.expiresAt))}
              </span>
              <ActionMenu
                label={i.email}
                actions={[{ label: "Revoke", danger: true, onSelect: () => revoke.mutate(i.id) }]}
              />
            </div>
          ))}
        </Section>
      )}
      {elevated && <Guests />}
    </>
  );
}

/** People outside the workspace who review through links, and the way to cut them off. */
function Guests() {
  const { data: guests } = useQuery(workspaceGuestsQuery);
  const revoke = useRevokeGuest();
  if (!guests || guests.length === 0) return null;
  return (
    <Section
      title={`Guests · ${guests.length}`}
      intro="Guests are asked from a review and sign in with a link sent to them."
    >
      {revoke.error && <p className="px-4 py-2 text-[13px] text-signal">{revoke.error.message}</p>}
      {guests.map((g) => (
        <div key={g.id} className="group flex items-center gap-3 px-4 py-2.5">
          <Avatar id={g.id} name={g.name} size={28} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-ink">
              {g.name}
              {g.label && <span className="text-ink-3"> · {g.label}</span>}
            </span>
            <span className="block truncate text-[13px] text-ink-3">{g.email}</span>
          </span>
          <span className="hidden text-[13px] text-ink-3 @3xl/app:inline">
            {g.live
              ? g.lastLinkAt
                ? `link sent ${dateFormat.format(new Date(g.lastLinkAt))}`
                : "signed in"
              : "no working link"}
          </span>
          {g.live ? (
            <ActionMenu
              label={g.name}
              actions={[
                { label: "Revoke access", danger: true, onSelect: () => revoke.mutate(g.id) },
              ]}
            />
          ) : (
            <span className="size-7 shrink-0" />
          )}
        </div>
      ))}
    </Section>
  );
}

/**
 * Operations (#165), for the owners: only what they act on (decision 288). How the files are
 * encrypted, the storage against the plan, the export and deletion, and who runs the instance
 * with where to ask them. The release, the worker, the queues and the metrics are the
 * operators', under Instance, Operations.
 */
function Operations({ role }: { role: Role }) {
  const { data, error } = useQuery(workspaceOperationsQuery);
  const { data: usage } = useQuery(storageUsageQuery);
  const { data: me } = useQuery(meQuery);
  const workspace = me?.organisations.find((o) => o.id === me.activeOrganisationId);
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data || !me || !workspace) return null;
  return (
    <>
      <Section title="This workspace">
        <Row
          name="Encryption"
          hint="Every file has its own key, wrapped by the workspace's key; storage only ever holds ciphertext."
        >
          <span className="text-[13px] text-ink-2">
            {encryptionWords(data.encryption, (iso) => dateFormat.format(new Date(iso)))}
          </span>
        </Row>
        {usage && <StorageUsageRow usage={usage.usage} />}
        <OperatorsRow support={me.support} />
      </Section>
      {mayExportWorkspace(role) && (
        <>
          <Section
            title="Export"
            intro="Everything the workspace holds, to keep, to move elsewhere, or for an audit. Owners only, and logged."
          >
            <WorkspaceExports scope={{ kind: "workspace" }} name={workspace.name} />
          </Section>
          <Danger>
            <DeleteWorkspace name={workspace.name} />
          </Danger>
        </>
      )}
    </>
  );
}

/** Who runs the instance, and where to ask them, as the instance answers support (#181). */
function OperatorsRow({ support }: { support: Me["support"] }) {
  const mode = support?.mode ?? "off";
  const keep = "They keep its backups, upgrades and workers.";
  return (
    <Row
      name="Run by this instance's operators"
      hint={
        mode === "app"
          ? `${keep} Ask them through Support.`
          : mode === "link"
            ? `${keep} Ask them at their own help desk.`
            : mode === "mail" && support?.address
              ? `${keep} Ask them by email, at ${support.address}.`
              : `${keep} Support is not turned on here: ask whoever runs it.`
      }
    >
      {mode === "app" ? (
        <Button variant="secondary" size="md" asChild>
          <Link to="/settings/$section" params={{ section: "support" }}>
            Support
          </Link>
        </Button>
      ) : mode === "link" && support?.address ? (
        <Button variant="secondary" size="md" asChild>
          <a href={support.address} target="_blank" rel="noopener noreferrer">
            Open their desk
          </a>
        </Button>
      ) : mode === "mail" && support?.address ? (
        <Button variant="secondary" size="md" asChild>
          <a href={`mailto:${support.address}`}>Write to them</a>
        </Button>
      ) : null}
    </Row>
  );
}

function Storage({ role }: { role: Role }) {
  const { data } = useQuery(workspaceStorageQuery);
  const { data: usage } = useQuery(storageUsageQuery);
  const choose = useWorkspaceStorage();
  if (!data) return null;
  const receiving = data.backend ?? data.defaultBackend;
  const usedIn = (name: string) => usage?.backends.find((b) => b.name === name);
  const limited =
    usage && (usage.usage.limits.storageQuota !== null || usage.usage.limits.memberLimit !== null);
  return (
    <>
      {usage && (
        <Section
          title="Usage"
          intro={
            limited
              ? "Uploads are refused at the storage quota and invitations at the member limit, which the instance’s operators set; this page warns from 90%."
              : "The instance sets no limits for this workspace. What it uses is counted each hour."
          }
        >
          <UsageRows usage={usage.usage} />
        </Section>
      )}
      <Section
        title="Backends"
        intro="Existing files stay where they are; the choice applies to new ones."
      >
        <Row
          name="New files go to"
          hint={
            role === "owner"
              ? "The instance default unless you choose another backend."
              : "Only an owner can change it."
          }
        >
          {role === "owner" ? (
            <Select
              aria-label="Backend for new files"
              value={data.backend ?? ""}
              onChange={(e) => choose.mutate(e.target.value || null)}
              className="w-56"
            >
              <option value="">The default ({data.defaultBackend})</option>
              {data.available.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-[14px] text-ink-2">{receiving}</span>
          )}
        </Row>
        {data.available.map((b) => {
          const used = usedIn(b);
          return (
            <Row
              key={b}
              name={b}
              hint={
                [
                  b === receiving ? "Receives new files" : null,
                  b === data.defaultBackend && b !== receiving ? "The instance default" : null,
                  used ? `${used.objects} ${used.objects === 1 ? "object" : "objects"}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            >
              <span className="tabular text-[13px] text-ink-2">
                {formatBytes(used?.bytes ?? 0)}
              </span>
            </Row>
          );
        })}
        {choose.error && (
          <p className="px-4 py-2 text-[13px] text-signal">{choose.error.message}</p>
        )}
      </Section>
      {usage && <StorageUsageSections usage={usage} />}
    </>
  );
}

/** Each project's share of the storage, and what the reconciliation found in the workspace. */
function StorageUsageSections({ usage }: { usage: StorageUsage }) {
  const reconcile = useReconcile();
  const r = usage.reconciliation;
  return (
    <>
      <Section
        title="Usage by project"
        intro={`${formatBytes(usage.bytes)} in all: originals, and the renditions, pages and waveforms made from them.`}
      >
        {usage.projects.length === 0 && (
          <Row name="No projects yet" hint="Files a project holds are counted here." />
        )}
        {usage.projects.map((p) => (
          <Row key={p.id} name={p.name}>
            <span className="tabular text-[14px] text-ink">{formatBytes(p.bytes)}</span>
          </Row>
        ))}
      </Section>
      <Section
        title="Reconciliation"
        intro={
          r.removing
            ? "Every night the storage is compared with the database. Bytes nothing uses are removed once a second run, a day later, still finds them; missing files wait for a person."
            : "Every night the storage is compared with the database. This instance only reports: nothing is removed without a person."
        }
      >
        <Row name="Last run">
          <span className="text-[13px] text-ink-2">
            {r.lastRun ? timeFormat.format(new Date(r.lastRun.startedAt)) : "Not yet"}
          </span>
        </Row>
        <Row name="Unused bytes" hint="In storage, but no file uses them">
          <span className="tabular text-[13px] text-ink-2">
            {r.orphans + r.unused === 0 ? "None" : r.orphans + r.unused}
          </span>
        </Row>
        <Row
          name="Missing files"
          hint={
            r.missing > 0
              ? "Files the database expects that their backend no longer holds. Restore them from a backup."
              : "Every file is where the database expects it."
          }
        >
          {r.missing > 0 ? (
            <span className="flex items-center gap-1.5 text-[13px] text-signal">
              <Icon name="warning" size={13} />
              {r.missing}
            </span>
          ) : (
            <span className="text-[13px] text-ink-2">None</span>
          )}
        </Row>
        <Row name="Removed in the last 30 days">
          <span className="tabular text-[13px] text-ink-2">{r.removed}</span>
        </Row>
        <Row name="Run now" hint={reconcile.error?.message ?? "Checks this workspace only."}>
          <Button
            variant="secondary"
            disabled={reconcile.isPending}
            onClick={() => reconcile.mutate()}
          >
            {reconcile.isPending ? "Reconciling" : "Reconcile"}
          </Button>
        </Row>
      </Section>
    </>
  );
}

/** What an entry touched, by name: a file, a review, or a deleted one of either. */
function targetOf(e: AccessEvent): string | null {
  const file = e.fileId ? (e.fileName ?? "a deleted file") : null;
  const review = e.reviewId ? (e.reviewTitle ?? "a deleted review") : null;
  const named = [file, review].filter(Boolean).join(" · ");
  if (named) return named;
  if (e.action === "organisation.rename" && typeof e.details?.to === "string")
    return `to ${e.details.to}`;
  return null;
}

/** A person filter's value in its menu: a member's account or a guest. */
const personValue = (f: LogFilters) =>
  f.userId ? `user:${f.userId}` : f.guestId ? `guest:${f.guestId}` : "";

/**
 * The log's filters (decision 263), behind one Filter control as on the files page: an action,
 * a project, a person (a member or a guest) and how far back. A file or a review is chosen
 * from an entry's menu, since there are too many to list.
 */
function AccessLogFilterMenu({
  filters,
  onChange,
}: {
  filters: LogFilters;
  onChange: (next: LogFilters) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: members = [] } = useQuery(membersQuery);
  const { data: guests = [] } = useQuery(workspaceGuestsQuery);
  const active = logFilterKeys.filter((key) => filters[key]).length;
  const set = (key: LogFilterKey, value: string) =>
    onChange(value ? { ...filters, [key]: value } : without(filters, key));
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className={cn(active ? "text-ink" : "text-ink-3")}
      >
        <Icon name="filter" size={14} />
        Filter
        {active > 0 && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] text-ink-2">
            {active}
          </span>
        )}
      </Button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Filter entries"
          data-e2e-overlap
          className="rise-in flex w-72 flex-col gap-3 rounded-panel-lg bg-overlay p-3 shadow-4"
        >
          <Field label="Action">
            <Select value={filters.action ?? ""} onChange={(e) => set("action", e.target.value)}>
              <option value="">Every action</option>
              {Object.entries(actionCopy).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project">
            <Select
              value={filters.projectId ?? ""}
              onChange={(e) => set("projectId", e.target.value)}
            >
              <option value="">Any project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Person">
            <Select
              value={personValue(filters)}
              onChange={(e) => {
                const [kind, id = ""] = e.target.value.split(":");
                const rest = without(without(filters, "userId"), "guestId");
                onChange(
                  kind === "user"
                    ? { ...rest, userId: id }
                    : kind === "guest"
                      ? { ...rest, guestId: id }
                      : rest,
                );
              }}
            >
              <option value="">Anyone</option>
              <optgroup label="Members">
                {members.map((m) => (
                  <option key={m.userId} value={`user:${m.userId}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
              {guests.length > 0 && (
                <optgroup label="Guests">
                  {guests.map((g) => (
                    <option key={g.id} value={`guest:${g.id}`}>
                      {g.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="When">
            <Select value={filters.since ?? ""} onChange={(e) => set("since", e.target.value)}>
              <option value="">Any time</option>
              {logSince.map((since) => (
                <option key={since} value={since}>
                  {logSinceLabels[since]}
                </option>
              ))}
            </Select>
          </Field>
          <p className="m-0 text-[12px] text-ink-3">
            For one file or review, choose it from an entry's menu.
          </p>
          {active > 0 && (
            <div className="border-t border-line pt-2">
              <Button variant="ghost" size="sm" onClick={() => onChange({})}>
                Clear filters
              </Button>
            </div>
          )}
        </Floating>
      )}
    </div>
  );
}

function AccessLog() {
  const [filters, setFilters] = useState<LogFilters>({});
  // What a filter chosen from an entry is called, as that entry named it.
  const [named, setNamed] = useState<Partial<Record<LogFilterKey, string>>>({});
  const log = useInfiniteQuery(accessLogQuery(filters));
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: members = [] } = useQuery(membersQuery);
  const { data: guests = [] } = useQuery(workspaceGuestsQuery);
  const events = log.data?.pages.flatMap((p) => p.events) ?? [];
  const only = (key: LogFilterKey, value: string, name: string) => {
    setNamed((n) => ({ ...n, [key]: name }));
    // One person at a time: a member or a guest.
    const rest =
      key === "userId"
        ? without(filters, "guestId")
        : key === "guestId"
          ? without(filters, "userId")
          : filters;
    setFilters({ ...rest, [key]: value });
  };
  const chipLabel = (key: LogFilterKey): string => {
    const value = filters[key] ?? "";
    switch (key) {
      case "action":
        return actionCopy[value] ?? value;
      case "projectId":
        return projects.find((p) => p.id === value)?.name ?? named.projectId ?? "A project";
      case "fileId":
        return named.fileId ?? "A file";
      case "reviewId":
        return named.reviewId ?? "A review";
      case "userId":
        return members.find((m) => m.userId === value)?.name ?? named.userId ?? "A member";
      case "guestId":
        return guests.find((g) => g.id === value)?.name ?? named.guestId ?? "A guest";
      case "since":
        return logSinceLabels[value as LogSince] ?? value;
    }
  };
  const chipIcon: Record<LogFilterKey, IconName> = {
    action: "list",
    projectId: "folder",
    fileId: "file",
    reviewId: "review",
    userId: "user",
    guestId: "user",
    since: "clock",
  };
  const entryActions = (e: AccessEvent): MenuAction[] => [
    ...(e.userId
      ? [
          {
            label: "Only this person",
            onSelect: () => only("userId", e.userId ?? "", e.actorLabel),
          },
        ]
      : e.guestId
        ? [
            {
              label: "Only this guest",
              onSelect: () => only("guestId", e.guestId ?? "", e.actorLabel),
            },
          ]
        : []),
    ...(e.fileId
      ? [
          {
            label: "Only this file",
            onSelect: () => only("fileId", e.fileId ?? "", e.fileName ?? "A deleted file"),
          },
        ]
      : []),
    ...(e.reviewId
      ? [
          {
            label: "Only this review",
            onSelect: () => only("reviewId", e.reviewId ?? "", e.reviewTitle ?? "A deleted review"),
          },
        ]
      : []),
    ...(e.projectId
      ? [
          {
            label: "Only this project",
            onSelect: () => only("projectId", e.projectId ?? "", "A project"),
          },
        ]
      : []),
    {
      label: "Only this action",
      onSelect: () => only("action", e.action, actionCopy[e.action] ?? e.action),
    },
  ];
  return (
    <Section
      title="Entries"
      action={
        <span className="flex items-center gap-1.5">
          <AccessLogFilterMenu filters={filters} onChange={setFilters} />
          <Button variant="secondary" asChild>
            <a href={exportUrl(filters)} download>
              <Icon name="download" size={14} />
              Export CSV
            </a>
          </Button>
        </span>
      }
    >
      {filtered(filters) && (
        <ul
          aria-label="Filters"
          className="m-0 flex list-none flex-wrap items-center gap-1.5 border-b border-line px-4 py-2"
        >
          {logFilterKeys
            .filter((key) => filters[key])
            .map((key) => (
              <li
                key={key}
                className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-raised/40 pr-1 pl-2.5 text-[12px] text-ink-2"
              >
                <Icon name={chipIcon[key]} size={12} className="text-ink-3" />
                <span className="max-w-56 truncate">{chipLabel(key)}</span>
                <button
                  type="button"
                  aria-label={`Remove the filter ${chipLabel(key)}`}
                  onClick={() => setFilters(without(filters, key))}
                  className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-raised hover:text-ink"
                >
                  <Icon name="close" size={11} />
                </button>
              </li>
            ))}
          <li>
            <Button variant="ghost" size="sm" onClick={() => setFilters({})}>
              Clear
            </Button>
          </li>
        </ul>
      )}
      {log.isPending ? (
        <p className="px-4 py-3 text-[13px] text-ink-3">Loading</p>
      ) : events.length === 0 ? (
        <div className="p-4">
          {filtered(filters) ? (
            <Empty
              title="No entries match"
              text="Nothing logged matches these filters. Remove one to see more."
              action={
                <Button variant="secondary" onClick={() => setFilters({})}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Empty
              title="Nothing logged yet"
              text="Entries appear as people play, render, download and decide."
            />
          )}
        </div>
      ) : (
        <>
          {events.map((e) => (
            <div
              key={e.id}
              data-log-entry
              className="group grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-[13px] @3xl/app:grid-cols-[130px_170px_minmax(0,1fr)_130px_auto] @6xl/app:grid-cols-[130px_170px_minmax(0,1fr)_130px_140px_auto]"
            >
              <span className="tabular text-ink-3">
                {timeFormat.format(new Date(e.occurredAt))}
              </span>
              <span className="justify-self-end @3xl/app:justify-self-start">
                <span className="rounded-chip bg-raised px-1.5 py-0.5 text-[12px] text-ink-2">
                  {actionCopy[e.action] ?? e.action}
                </span>
              </span>
              <span className="row-span-2 self-center @3xl/app:order-last @3xl/app:row-span-1">
                <ActionMenu
                  label={`the entry at ${timeFormat.format(new Date(e.occurredAt))}`}
                  actions={entryActions(e)}
                />
              </span>
              <span className="col-span-2 flex min-w-0 flex-col @3xl/app:col-span-1">
                <span className="truncate text-ink-2">{e.actorLabel}</span>
                {targetOf(e) && (
                  <span className="truncate text-[12px] text-ink-3">{targetOf(e)}</span>
                )}
              </span>
              <span className="tabular hidden truncate text-ink-3 @3xl/app:block">
                {e.ipAddress ?? ""}
              </span>
              <span
                className="hidden truncate text-ink-3 @6xl/app:block"
                title={e.userAgent ?? undefined}
              >
                {shortAgent(e.userAgent) ?? ""}
              </span>
            </div>
          ))}
          {log.hasNextPage && (
            <div className="px-4 py-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={log.isFetchingNextPage}
                onClick={() => void log.fetchNextPage()}
              >
                Show older
              </Button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

/** `/settings/$section`: the workspace's settings, reached from the account menu (decision 038). */
export function WorkspaceSettingsPage({
  section,
  search = {},
}: {
  section: string;
  /** Support's ticket open, a new one being written, and where it was asked from (#181). */
  search?: { ticket?: string; new?: "1"; from?: string };
}) {
  const { data: me } = useQuery(meQuery);
  if (!me) return null;
  const role = me.organisations.find((o) => o.id === me.activeOrganisationId)?.role ?? "member";
  const sections = sectionsFor(role, me.billing, me.support?.mode);
  const current =
    sections.find((s) => s.id === section) ?? sections.find((s) => s.id === "members");
  if (!current) return null;
  return (
    <>
      <PageHeader title="Workspace settings" />
      <SettingsLayout
        title={current.label}
        intro={current.intro}
        docs={current.docs}
        sections={sections}
        current={current.id}
        base="/settings/$section"
        param="section"
      >
        {current.id === "general" && <General role={role} />}
        {current.id === "defaults" && <Defaults />}
        {current.id === "categories" && <WorkspaceCategories />}
        {current.id === "delivery" && <DeliveryProfiles />}
        {current.id === "branding" && <BrandingSection />}
        {current.id === "email" && <EmailTemplatesSection />}
        {current.id === "members" && <Members role={role} />}
        {current.id === "security" && (
          <>
            <Security />
            <SsoSection />
            <DirectorySection />
          </>
        )}
        {current.id === "notifications" && (
          <>
            <ChannelsSection />
            <ApiAndMcpSection />
          </>
        )}
        {current.id === "api" && (
          <>
            <OAuthClientsSection />
            <TokensSection kind="service" />
            <ScopesSection />
            <WorkspaceApiLogSection />
          </>
        )}
        {current.id === "storage" && <Storage role={role} />}
        {current.id === "transfers" && <TransfersSection />}
        {current.id === "billing" && <BillingSection owner={role === "owner"} />}
        {current.id === "support" && (
          <SupportSection
            ticketId={search.ticket}
            writing={search.new === "1"}
            from={askedFrom(search.from)}
          />
        )}
        {current.id === "leaks" && <LeakTracingSection />}
        {current.id === "log" && <AccessLog />}
        {current.id === "operations" && <Operations role={role} />}
      </SettingsLayout>
    </>
  );
}
