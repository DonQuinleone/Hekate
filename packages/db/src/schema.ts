import {
  type AlignmentPoints,
  type Anchor,
  type ApiScope,
  type ApiTokenKind,
  approvalRules,
  auditActions,
  auditActorTypes,
  authMethods,
  authResults,
  type BoardDisplay,
  type CaptionCue,
  type CaptionFormat,
  type CaptionKind,
  type ChannelKind,
  type CommentMention,
  type CommentReferences,
  type CustomProfileInput,
  carryStatuses,
  categoryHandlings,
  type DeliveryStatus,
  type DigestFrequency,
  type DirectoryRoleRule,
  type DownloadKind,
  defaultReviewerPermissions,
  type EventKind,
  type FileColumnLayout,
  type IncidentImpact,
  type IncidentState,
  type InstanceSettings,
  type InvoiceSource,
  type InvoiceStatus,
  type LoudnessSummary,
  type MailMode,
  type MailProvider,
  type MediaInfo,
  mailResults,
  type NormalisationMode,
  type NotificationChannels,
  type NotificationKind,
  type NotificationMail,
  notificationKinds,
  type OAuthClientKind,
  type OverviewSection,
  type PlanFeature,
  type PlayerTool,
  type PrintedBar,
  type ProfileRef,
  type ProjectPermission,
  type ProjectProfile,
  type QaCheck,
  type QaFinding,
  type QaSettings,
  type QaSeverity,
  type Release,
  type ReviewerPermissions,
  type ReviewOutcome,
  reviewDecisions,
  reviewKinds,
  reviewOrders,
  reviewStatuses,
  type SearchRequest,
  type SessionFactor,
  type SignInMethod,
  type SsoProtocol,
  type StandingGrant,
  type StatusService,
  type SupportSeverity,
  scheduleRowKinds,
  type TaskEventDetail,
  type TaskEventKind,
  type TemplateContent,
  type TicketAuthor,
  type TicketKind,
  type TicketState,
  taskPriorities,
  taskStatuses,
  transferStatuses,
  type WatermarkSettings,
  type WorkflowDefinition,
  type WorkflowEffect,
  type WorkflowRun,
  type WorkflowStatus,
  type WorkspaceExportStatus,
  type WorkspacePlanStatus,
} from "@hekate/shared";
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./id.ts";

// Vocabulary: docs/domain.md. Use those terms exactly.

/**
 * What search reads: words in the `simple` configuration (no stemming, so names in any
 * language match as typed). Indexed as an expression, and queried with the same one.
 */
export const searchVector = (text: SQL) => sql`to_tsvector('simple', ${text})`;

const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
/** Every tenant-owned table starts with this column. */
const organisationId = () =>
  uuid("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" });
const projectId = () =>
  uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" });

export const profileEnum = pgEnum("project_profile", ["music", "video", "general"]);
/** Organisation-level role. Per-project roles and permissions are a separate model (issue 23). */
export const organisationRoleEnum = pgEnum("organisation_role", ["owner", "admin", "member"]);
export const fileKindEnum = pgEnum("file_kind", ["audio", "video", "document", "image", "other"]);
export const auditActionEnum = pgEnum("audit_action", auditActions);
export const reviewKindEnum = pgEnum("review_kind", reviewKinds);
export const reviewOrderEnum = pgEnum("review_order", reviewOrders);
export const approvalRuleEnum = pgEnum("approval_rule", approvalRules);
export const scheduleRowKindEnum = pgEnum("schedule_row_kind", scheduleRowKinds);
export const reviewStatusEnum = pgEnum("review_status", reviewStatuses);
export const reviewDecisionEnum = pgEnum("review_decision", reviewDecisions);
export const carryStatusEnum = pgEnum("carry_status", carryStatuses);
export const categoryHandlingEnum = pgEnum("category_handling", categoryHandlings);
export const uploadStatusEnum = pgEnum("upload_status", [
  "open",
  "completing",
  "completed",
  "aborted",
]);
export const auditActorEnum = pgEnum("audit_actor", auditActorTypes);
/** Whether a file can be played: proxies are made by the media worker after upload. */
export const streamStatusEnum = pgEnum("stream_status", ["none", "pending", "ready", "failed"]);

// Organisations and people

export const organisations = pgTable("organisations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Storage backend for new objects; null uses the instance default (STORAGE_DEFAULT). */
  storageBackend: text("storage_backend"),
  /** Workspace settings, read through workspaceSettingsOf (packages/shared). */
  settings: jsonb("settings").notNull().default({}),
  /**
   * Its logo and accent (#185), read through storedBrandingOf (packages/shared); null is none.
   * A column of its own rather than a setting, so a release that rewrites the settings whole,
   * as the one before this does, cannot drop it.
   */
  branding: jsonb("branding"),
  /**
   * Suspended by an operator (#174): everything is kept and nobody gets in, members and guests
   * alike, until it is reinstated. The reason is shown to its members.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  /**
   * When a suspended workspace is to be purged, with everything in it: set by an operator, or
   * by its owners (#186), a grace period ahead, and cleared if it is kept first.
   */
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
  /**
   * An owner asked to delete the workspace (#186), for a second owner to confirm. Confirmed, it
   * is suspended for its deletion and `deleteAfter` is set, as an operator's deletion sets it.
   * A plain account id, as the access log keeps them: a foreign key added to this long-standing
   * table would be a constraint the release before could not run against (decision 198).
   */
  deletionRequestedBy: text("deletion_requested_by"),
  deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
  /**
   * Limits an operator sets (#175), seeded from the instance's defaults: bytes stored, and
   * members. Null is no limit. Uploads and new members are refused at the limit.
   */
  storageQuota: bigint("storage_quota", { mode: "number" }),
  memberLimit: integer("member_limit"),
  /** Projects (#177), the same way: from its plan, or an operator. */
  projectLimit: integer("project_limit"),
  /**
   * Its default comment categories (`workspace_categories`) have been made: from then on an
   * empty set is the workspace's choice, not a set never made (decision 247).
   */
  categoriesSeeded: boolean("categories_seeded").notNull().default(false),
  ...timestamps,
});

/** Global identity. Shape is compatible with Better Auth's user table (text ids). */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  /** How dates and numbers read for them, for example "en-GB"; null follows the browser. */
  locale: text("locale"),
  /** Their IANA time zone, for example "Europe/London"; null follows the browser. */
  timeZone: text("time_zone"),
  /** What they want to see and how the player behaves for them; read with preferencesOf. */
  preferences: jsonb("preferences"),
  /** Whether a second factor guards their sign-in (Better Auth's two-factor plugin). */
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  /**
   * When they deleted their account. The row stays, so their comments and decisions keep an
   * author, but holds no name, address or preference of theirs any more.
   */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  ...timestamps,
});

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /** The organisation the session is working in; chosen at sign-in or by switching. */
    activeOrganisationId: uuid("active_organisation_id").references(() => organisations.id, {
      onDelete: "set null",
    }),
    /**
     * How the session was signed in: a password alone, a password and a second factor, or a
     * passkey (decision 048). A workspace that asks for a second factor, or a security key,
     * reads this.
     */
    factor: text("factor").$type<SessionFactor>().notNull().default("password"),
    /** The single sign-on provider that signed the session in, if one did (#37). */
    ssoProviderId: text("sso_provider_id"),
    /**
     * The way in it was signed in with: a password, a passkey, single sign-on or a workspace's
     * directory (decision 248), which a workspace's allowed methods are checked against. Null
     * for a session from before it was kept, read from `factor` and `ssoProviderId` instead.
     */
    method: text("method").$type<SignInMethod>(),
    ...timestamps,
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

/**
 * A passkey or hardware security key (WebAuthn), for Better Auth's passkey plugin: signs in on
 * its own, or confirms a password sign-in. Named by its owner; up to an operator's limit each.
 */
export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    /** "singleDevice" for a hardware key, "multiDevice" for a passkey that syncs. */
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);

/** Better Auth account: one row per sign-in method (credential password, later SSO, LDAP). */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    /** Password hash for the credential provider (scrypt, by Better Auth). */
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId)],
);

/** Better Auth verification values: email verification, password reset, later magic links. */
export const authVerifications = pgTable("auth_verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

/**
 * A code app (TOTP) for an account's second factor, with its recovery codes. The secret is
 * encrypted with the auth secret; the recovery codes are kept only as keyed hashes (auth.ts).
 */
export const twoFactors = pgTable(
  "two_factors",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("two_factors_user_idx").on(t.userId)],
);

/**
 * A workspace's directory (LDAP or Active Directory) for signing in (#38). The bind password
 * is sealed with the workspace's key (secrets.ts); it is never sent back.
 */
export const directories = pgTable(
  "directories",
  {
    id: id(),
    organisationId: organisationId(),
    enabled: boolean("enabled").notNull().default(false),
    url: text("url").notNull(),
    verifyCertificate: boolean("verify_certificate").notNull().default(true),
    bindDn: text("bind_dn").notNull().default(""),
    bindPasswordSealed: text("bind_password_sealed"),
    /** The version of the workspace key that sealed it. */
    bindPasswordKeyVersion: integer("bind_password_key_version"),
    userBase: text("user_base").notNull(),
    userFilter: text("user_filter").notNull(),
    emailAttribute: text("email_attribute").notNull().default("mail"),
    nameAttribute: text("name_attribute").notNull().default("cn"),
    groupBase: text("group_base").notNull().default(""),
    groupFilter: text("group_filter").notNull().default("(member={dn})"),
    roles: jsonb("roles").$type<DirectoryRoleRule[]>().notNull().default([]),
    ...timestamps,
  },
  (t) => [uniqueIndex("directories_organisation_idx").on(t.organisationId)],
);

/**
 * A workspace's single sign-on (#37): one OpenID Connect or SAML identity provider. Better
 * Auth's SSO plugin reads the provider columns (`providerId`, `issuer`, `domain`, and the
 * configuration as JSON text); the rest are Hekate's. One per workspace.
 */
export const ssoProviders = pgTable(
  "sso_providers",
  {
    id: id(),
    organisationId: organisationId(),
    /** The provider's name in sign-in and callback addresses: `workspace-` and the id. */
    providerId: text("provider_id").notNull().unique(),
    /** The OIDC issuer, or the SAML identity provider's entity ID. */
    issuer: text("issuer").notNull(),
    /** Unused: providers are found by workspace, never by an address's domain. */
    domain: text("domain").notNull().default(""),
    /** Better Auth's OIDC configuration, JSON; holds the client secret, as Better Auth needs it. */
    oidcConfig: text("oidc_config"),
    /** Better Auth's SAML configuration, JSON. */
    samlConfig: text("saml_config"),
    /** Who set it up. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(false),
    protocol: text("protocol").$type<SsoProtocol>().notNull().default("oidc"),
    clientId: text("client_id").notNull().default(""),
    entryPoint: text("entry_point").notNull().default(""),
    certificate: text("certificate").notNull().default(""),
    groupsClaim: text("groups_claim").notNull().default("groups"),
    roles: jsonb("roles").$type<DirectoryRoleRule[]>().notNull().default([]),
    /** Members (not owners) sign in to the workspace only through it. */
    enforce: boolean("enforce").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("sso_providers_organisation_idx").on(t.organisationId)],
);

/**
 * Failed sign-ins per account, for slowing and then locking repeated guesses (apps/server
 * lockout.ts). Keyed by a hash of the address, so the table names no one; an account belongs
 * to no single workspace, so neither does this.
 */
export const signInAttempts = pgTable("sign_in_attempts", {
  /** SHA-256 of the email address, lower-cased. */
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  ...timestamps,
});

/**
 * Requests counted per key in a fixed window, for rate limits every replica shares (#172):
 * guest links and codes, uploads, key issues. Keyed by what is limited and who asks (an
 * address or a session), never an account's details; rows older than a day are purged.
 */
export const requestLimits = pgTable("request_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
});

/** Better Auth's own rate limits (sign-in, codes), kept here so every replica shares them. */
export const authRateLimits = pgTable("auth_rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const members = pgTable(
  "members",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organisationRoleEnum("role").notNull().default("member"),
    /** The file browser's columns as this member arranged them; null for the default. */
    fileColumns: jsonb("file_columns").$type<FileColumnLayout>(),
    ...timestamps,
  },
  (t) => [uniqueIndex("members_org_user_idx").on(t.organisationId, t.userId)],
);

/**
 * An invitation to join an organisation. Only a SHA-256 hash of the token is stored; the token
 * itself exists in the invitation link alone.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    organisationId: organisationId(),
    email: text("email").notNull(),
    role: organisationRoleEnum("role").notNull().default("member"),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("invitations_org_idx").on(t.organisationId)],
);

// Content

export const projects = pgTable(
  "projects",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    profile: profileEnum("profile").$type<ProjectProfile>().notNull(),
    /** A line saying what it is, for the project list. */
    description: text("description"),
    /** Whether threads carried to a new version show there until someone hides them. */
    carriedCommentsShown: boolean("carried_comments_shown").notNull().default(true),
    /**
     * What deliveries are checked against (#41): a built-in profile or `custom:` one of the
     * workspace's; null leaves it to the workspace, or to each file's channels.
     */
    deliveryProfile: text("delivery_profile").$type<ProfileRef>(),
    /** Refuse a new version whose audio peaks over the delivery profile's ceiling (#131). */
    checkTruePeak: boolean("check_true_peak").notNull().default(false),
    /** Refuse a new version without an edit decision list. */
    requireEdl: boolean("require_edl").notNull().default(false),
    /** Its QA rules (#144): which checks run, how hard, and its own; null keeps the defaults. */
    qaSettings: jsonb("qa_settings").$type<QaSettings>(),
    /** What reviewers may type beside a comment (#240); null takes its profile's. */
    commentReferences: jsonb("comment_references").$type<CommentReferences>(),
    /** Whether recordings play at their delivery target's loudness (#240); off until chosen. */
    normalisation: text("normalisation").$type<NormalisationMode>().notNull().default("off"),
    /** A deletion asked for, waiting for a workspace owner's confirmation (#240): who, and when. */
    deletionRequestedBy: text("deletion_requested_by").references(() => users.id, {
      onDelete: "set null",
    }),
    deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
    /** Once a second owner confirms, when it goes for good; kept until then, read-only (#240). */
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    /** The storage backend for this project's new files (#240); null follows the workspace's. */
    storageBackend: text("storage_backend"),
    /** The visible watermark (#31): whom it marks, where and how strongly; null is the default. */
    watermark: jsonb("watermark").$type<WatermarkSettings>(),
    /**
     * Whether its comment categories have been made: a new project gets the defaults at once,
     * one made before categories existed the first time its categories are read.
     */
    categoriesSeeded: boolean("categories_seeded").notNull().default(false),
    /** Whether the project has had its default score mark categories (#52). */
    scoreCategoriesSeeded: boolean("score_categories_seeded").notNull().default(false),
    /** How many tasks it has numbered (#140): the next is one more, so a key is never reused. */
    tasksNumbered: integer("tasks_numbered").notNull().default(0),
    /** Its status set (#26): what its workflows set, in order, each read as to do, under way or done. */
    workflowStatuses: jsonb("workflow_statuses")
      .$type<WorkflowStatus[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * How its board is arranged for those who have not chosen their own (decision 256); null
     * leaves them the built-in arrangement.
     */
    boardDisplay: jsonb("board_display").$type<BoardDisplay>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("projects_org_idx").on(t.organisationId),
    index("projects_search_idx").using("gin", searchVector(sql`coalesce(${t.name}, '')`)),
  ],
);

/**
 * A project's roles: named sets of permissions from the fixed list in
 * `packages/shared/src/roles.ts`. Every project starts with the defaults, which can be edited.
 */
export const projectRoles = pgTable(
  "project_roles",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    name: text("name").notNull(),
    permissions: text("permissions").array().notNull().$type<ProjectPermission[]>(),
    /** Its player tools (#240); a role made before them keeps every one. */
    tools: text("tools")
      .array()
      .notNull()
      .default(sql`'{qa,meters,spectrogram,score,compare,loops,normalise}'::text[]`)
      .$type<PlayerTool[]>(),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("project_roles_name_idx").on(t.organisationId, t.projectId, t.name)],
);

/**
 * A project's set-up saved to start others from (#240): its roles, categories, delivery
 * profile, QA rules and version checks, as one validated value (`templateContent`). It is a
 * copy, so changing the project afterwards leaves the template as it was.
 */
export const projectTemplates = pgTable(
  "project_templates",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    content: jsonb("content").notNull().$type<TemplateContent>(),
    /** The project it was saved from, while it exists. */
    fromProjectId: uuid("from_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("project_templates_name_idx").on(t.organisationId, sql`lower(${t.name})`)],
);

/**
 * Who works on a project, each with one role. Organisation owners and admins need no row:
 * they may do everything in every project. A role in use cannot be deleted.
 */
export const projectMembers = pgTable(
  "project_members",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      // Checked at the end of the statement, so deleting a project still cascades to both.
      .references(() => projectRoles.id, { onDelete: "no action" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_members_user_idx").on(t.organisationId, t.projectId, t.userId),
    index("project_members_user_lookup_idx").on(t.userId),
  ],
);

/** Folders nest; a null parent is the project root. */
export const folders = pgTable(
  "folders",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("folders_org_idx").on(t.organisationId),
    index("folders_project_idx").on(t.projectId, t.parentId),
    // One name per place: two folders called "Mixes" at the top would be indistinguishable.
    unique("folders_sibling_name")
      .on(t.organisationId, t.projectId, t.parentId, t.name)
      .nullsNotDistinct(),
  ],
);

/**
 * A recording session (#21, #45): a day or a sitting, with where it was, the tracks it recorded
 * (many to many) and the takes recorded in it. Takes belong to their tracks; a session only says
 * when and where they were made.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    name: text("name").notNull(),
    recordedOn: date("recorded_on"),
    /** Where it was recorded, for example "Endless Hall, studio 2". */
    venue: text("venue"),
    position: integer("position").notNull().default(0),
    /** How the take log numbers its takes (#51): continuous, per-track or recorder. */
    numbering: text("numbering").notNull().default("per-track"),
    /** The booked slot the take log counts down to. */
    slotStart: timestamp("slot_start", { withTimezone: true }),
    slotEnd: timestamp("slot_end", { withTimezone: true }),
    /** The room's notes on the day, shared in the take log (#51). */
    notes: text("notes"),
    /** The producer's quick reference: where the repeats are, which take to keep. */
    reference: text("reference"),
    /**
     * The browser driving the take log's takes from a recorder (#51, decision 240): the
     * adapter it connected, whose browser it is, and when it last said it still drives. Held
     * only while that is recent; nothing of the recorder itself is kept.
     */
    recorderKind: text("recorder_kind"),
    recorderBy: text("recorder_by").references(() => users.id, { onDelete: "set null" }),
    recorderSeenAt: timestamp("recorder_seen_at", { withTimezone: true }),
    /** The connection that claimed it: each browser tab's own, so two of one person's differ. */
    recorderClaim: text("recorder_claim"),
    ...timestamps,
  },
  (t) => [
    index("sessions_org_idx").on(t.organisationId),
    index("sessions_project_idx").on(t.projectId),
    check("sessions_numbering", sql`${t.numbering} in ('continuous', 'per-track', 'recorder')`),
  ],
);

/** Which tracks a session recorded: a track may be recorded in several, a session may hold several. */
export const sessionTracks = pgTable(
  "session_tracks",
  {
    id: id(),
    organisationId: organisationId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references((): AnyPgColumn => tracks.id, { onDelete: "cascade" }),
  },
  (t) => [
    uniqueIndex("session_tracks_pair_idx").on(t.sessionId, t.trackId),
    index("session_tracks_track_idx").on(t.organisationId, t.trackId),
  ],
);

/**
 * A workflow (#25, decision 040): a graph of nodes and connectors (`workflowDefinition` in
 * `packages/shared`), the project's own or a track's in place of the project's. It runs only
 * while active, and only while it breaks no rule; every change raises its version, and a run
 * keeps the definition it started with.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    trackId: uuid("track_id").references((): AnyPgColumn => tracks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(false),
    definition: jsonb("definition").$type<WorkflowDefinition>().notNull(),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("workflows_org_idx").on(t.organisationId),
    index("workflows_project_idx").on(t.projectId),
    index("workflows_track_idx").on(t.trackId),
  ],
);

/**
 * A workflow running for a track (#25): the definition it started with, kept whatever later
 * changes are made to the workflow, and where the engine (`WorkflowRun`) stands. One runs per
 * workflow and track at a time.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    workflowName: text("workflow_name").notNull(),
    workflowVersion: integer("workflow_version").notNull(),
    definition: jsonb("definition").$type<WorkflowDefinition>().notNull(),
    trackId: uuid("track_id")
      .notNull()
      .references((): AnyPgColumn => tracks.id, { onDelete: "cascade" }),
    /** The version whose arrival started it, where one did. */
    versionId: uuid("version_id").references((): AnyPgColumn => versions.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<WorkflowRun["state"] | "cancelled">().notNull(),
    engine: jsonb("engine").$type<WorkflowRun>().notNull(),
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workflow_runs_org_idx").on(t.organisationId),
    index("workflow_runs_track_idx").on(t.trackId, t.state),
    index("workflow_runs_workflow_idx").on(t.workflowId),
    // One run of a workflow at a time for a track.
    uniqueIndex("workflow_runs_running_idx")
      .on(t.workflowId, t.trackId)
      .where(sql`state = 'running'`),
  ],
);

/** Every move a run made (#25): the node and outcome it moved on from, and what it did. */
export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: id(),
    organisationId: organisationId(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    /** The node that ended and how; null for the trigger that started the run. */
    nodeId: text("node_id"),
    outcome: text("outcome"),
    effects: jsonb("effects").$type<WorkflowEffect[]>().notNull(),
    /** Who ended the node by hand, where someone did. */
    byUserId: text("by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workflow_steps_org_idx").on(t.organisationId),
    index("workflow_steps_run_idx").on(t.runId, t.createdAt),
  ],
);

/** The take log's to-do list for a session (#51), an item a row so two people never overwrite each other. */
export const sessionTodos = pgTable(
  "session_todos",
  {
    id: id(),
    organisationId: organisationId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    done: boolean("done").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("session_todos_session_idx").on(t.organisationId, t.sessionId, t.createdAt)],
);

/**
 * A take (#21): a snippet recorded for a track, never a version of it. For now one scratch mix
 * (`files.takeId`); stems with a mixer come later. Its bars and in and out points are optional:
 * bars matter for a classical piece and not for a pop song.
 */
export const takes = pgTable(
  "takes",
  {
    id: id(),
    organisationId: organisationId(),
    trackId: uuid("track_id")
      .notNull()
      .references((): AnyPgColumn => tracks.id, { onDelete: "cascade" }),
    /** The session it was recorded in, where that is known; it still belongs to its track. */
    sessionId: uuid("session_id").references((): AnyPgColumn => sessions.id, {
      onDelete: "set null",
    }),
    number: integer("number").notNull(),
    label: text("label"),
    notes: text("notes"),
    /** 0 to 5; 0 is not rated. */
    rating: integer("rating").notNull().default(0),
    /** The producer's circled takes. */
    starred: boolean("starred").notNull().default(false),
    /** Where it sits in the score: a page, and the bars it covers. */
    page: integer("page"),
    barFrom: integer("bar_from"),
    barTo: integer("bar_to"),
    /** The part of the recording that counts, in seconds; null is from the start, to the end. */
    inPoint: doublePrecision("in_point"),
    outPoint: doublePrecision("out_point"),
    /**
     * Where it is in the control room (#51): idle, armed, recording, recorded or aborted. A
     * take made from a file is recorded.
     */
    lifecycle: text("lifecycle").notNull().default("recorded"),
    falseStarts: integer("false_starts").notNull().default(0),
    /** The recorder's timecode where it started and stopped, as written: 10:00:00:00. */
    timecodeIn: text("timecode_in"),
    timecodeOut: text("timecode_out"),
    /** When it started and stopped rolling, by the wall clock. */
    wallIn: timestamp("wall_in", { withTimezone: true }),
    wallOut: timestamp("wall_out", { withTimezone: true }),
    /** The page it ends on, where it turns one. */
    pageTo: integer("page_to"),
    ...timestamps,
  },
  (t) => [
    index("takes_org_idx").on(t.organisationId),
    index("takes_session_idx").on(t.organisationId, t.sessionId),
    uniqueIndex("takes_track_number_idx").on(t.trackId, t.number),
    // "Which takes cover bar 72?" is a range query per track.
    index("takes_coverage_idx").on(t.organisationId, t.trackId, t.barFrom, t.barTo),
    check("takes_rating_range", sql`${t.rating} between 0 and 5`),
    check(
      "takes_lifecycle",
      sql`${t.lifecycle} in ('idle', 'armed', 'recording', 'recorded', 'aborted')`,
    ),
    check("takes_false_starts", sql`${t.falseStarts} >= 0`),
    check(
      "takes_bars_order",
      sql`${t.barFrom} is null or ${t.barTo} is null or ${t.barFrom} <= ${t.barTo}`,
    ),
  ],
);

/** A project's categories of score issue (#52): a name, a colour and the key that picks it. */
export const scoreMarkCategories = pgTable(
  "score_mark_categories",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    colour: text("colour").notNull(),
    key: text("key"),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("score_mark_categories_project_idx").on(t.organisationId, t.projectId)],
);

/**
 * A score mark (#52, docs/domain.md): the producer's pencil on a track's score. It belongs to
 * the track, placed by page, point and bar, so a score swapped mid-project keeps it.
 */
export const scoreMarks = pgTable(
  "score_marks",
  {
    id: id(),
    organisationId: organisationId(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    page: integer("page").notNull(),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    width: doublePrecision("width"),
    height: doublePrecision("height"),
    points: jsonb("points").$type<[number, number][]>(),
    barFrom: integer("bar_from"),
    barTo: integer("bar_to"),
    text: text("text"),
    categoryId: uuid("category_id").references(() => scoreMarkCategories.id, {
      onDelete: "set null",
    }),
    /** The takes an issue occurred in, by number; and the take that fixed it. */
    takes: jsonb("takes").$type<number[]>().notNull().default([]),
    fixedBy: integer("fixed_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** An edit point's hand-over, or the take a start, end or punch-in names. */
    fromTake: integer("from_take"),
    toTake: integer("to_take"),
    overdub: boolean("overdub").notNull().default(false),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("score_marks_track_idx").on(t.organisationId, t.trackId, t.page)],
);

/**
 * A stage box (#54, docs/domain.md): a box on the stage with numbered inputs and outputs, in
 * the project's patch list, in the order the engineer put them.
 */
export const stageBoxes = pgTable(
  "stage_boxes",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("stage_boxes_project_idx").on(t.organisationId, t.projectId),
    uniqueIndex("stage_boxes_name_idx").on(t.projectId, t.name),
  ],
);

/** One channel of a stage box, in or out: what is plugged in, through what, on which cable. */
export const patchRows = pgTable(
  "patch_rows",
  {
    id: id(),
    organisationId: organisationId(),
    stageBoxId: uuid("stage_box_id")
      .notNull()
      .references(() => stageBoxes.id, { onDelete: "cascade" }),
    direction: text("direction").$type<"input" | "output">().notNull(),
    channel: integer("channel").notNull(),
    source: text("source").notNull().default(""),
    device: text("device").notNull().default(""),
    cable: text("cable").notNull().default(""),
    notes: text("notes").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("patch_rows_channel_idx").on(t.stageBoxId, t.direction, t.channel),
    index("patch_rows_box_idx").on(t.organisationId, t.stageBoxId),
    check("patch_rows_direction", sql`${t.direction} in ('input', 'output')`),
    check("patch_rows_channel", sql`${t.channel} >= 1`),
  ],
);

/**
 * A stage plan (#53, docs/domain.md): a venue's stage drawn to scale, in metres, on a snapping
 * grid. A project may hold several, one a venue or layout.
 */
export const stagePlans = pgTable(
  "stage_plans",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    /** The venue, or the layout at it. */
    name: text("name").notNull(),
    width: doublePrecision("width").notNull(),
    depth: doublePrecision("depth").notNull(),
    grid: doublePrecision("grid").notNull().default(0.5),
    /** A floor plan drawn under the stage: a page of a document or picture in the project. */
    underlayFileId: uuid("underlay_file_id").references(() => files.id, { onDelete: "set null" }),
    underlayPage: integer("underlay_page").notNull().default(1),
    /** Where the page's top-left corner falls, in metres from the stage's back-left corner. */
    underlayX: doublePrecision("underlay_x").notNull().default(0),
    underlayY: doublePrecision("underlay_y").notNull().default(0),
    /** How many metres the page spans across. */
    underlayWidth: doublePrecision("underlay_width"),
    underlayOpacity: doublePrecision("underlay_opacity").notNull().default(0.5),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("stage_plans_project_idx").on(t.organisationId, t.projectId),
    uniqueIndex("stage_plans_name_idx").on(t.projectId, t.name),
    check("stage_plans_size", sql`${t.width} > 0 and ${t.depth} > 0 and ${t.grid} > 0`),
    check(
      "stage_plans_underlay",
      sql`${t.underlayOpacity} between 0 and 1 and ${t.underlayPage} >= 1 and (${t.underlayWidth} is null or ${t.underlayWidth} > 0)`,
    ),
  ],
);

/**
 * Something on a stage plan, in metres from the stage's back-left corner. The kind is an open
 * set (`stageKinds` in packages/shared lists the ones offered). A microphone, stage box or cable
 * may be linked to a patch list channel, whose source it is then labelled with.
 */
export const stageItems = pgTable(
  "stage_items",
  {
    id: id(),
    organisationId: organisationId(),
    stagePlanId: uuid("stage_plan_id")
      .notNull()
      .references(() => stagePlans.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull().default(""),
    x: doublePrecision("x").notNull(),
    y: doublePrecision("y").notNull(),
    w: doublePrecision("w").notNull(),
    h: doublePrecision("h").notNull(),
    rotation: doublePrecision("rotation").notNull().default(0),
    patchRowId: uuid("patch_row_id").references(() => patchRows.id, { onDelete: "set null" }),
    /** Who stands there: a performer or an ensemble on the production's personnel (#49). */
    personnelId: uuid("personnel_id").references(() => personnel.id, { onDelete: "set null" }),
    /** A label group: the labels of a group are shown or hidden together. */
    group: text("label_group").notNull().default(""),
    ...timestamps,
  },
  (t) => [
    index("stage_items_plan_idx").on(t.organisationId, t.stagePlanId),
    index("stage_items_patch_idx").on(t.patchRowId),
    index("stage_items_personnel_idx").on(t.personnelId),
    // A cable runs either way from its point; everything else has a size.
    check("stage_items_size", sql`${t.kind} = 'cable' or (${t.w} > 0 and ${t.h} > 0)`),
  ],
);

/**
 * Someone on a production (#49, docs/domain.md): an artist, an ensemble, staff or another, with
 * whether the session agreement is signed and whether they need headphones. It may be linked to
 * a member of the workspace or a guest, so the conductor on the stage plan is the one who reviews.
 */
export const personnel = pgTable(
  "personnel",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    name: text("name").notNull(),
    kind: text("kind").$type<"artist" | "ensemble" | "staff" | "other">().notNull(),
    role: text("role").notNull().default(""),
    agreement: boolean("agreement").notNull().default(false),
    headphones: boolean("headphones").notNull().default(false),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "set null" }),
    /** An ensemble's seating and forces. */
    seating: text("seating").notNull().default(""),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("personnel_project_idx").on(t.organisationId, t.projectId),
    check("personnel_kind", sql`${t.kind} in ('artist', 'ensemble', 'staff', 'other')`),
    check("personnel_link", sql`${t.userId} is null or ${t.guestId} is null`),
  ],
);

/** A section of an ensemble: a head-count, how it divides, and its players as they are named. */
export const personnelSections = pgTable(
  "personnel_sections",
  {
    id: id(),
    organisationId: organisationId(),
    personnelId: uuid("personnel_id")
      .notNull()
      .references(() => personnel.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    count: integer("count").notNull(),
    divisi: text("divisi").notNull().default(""),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("personnel_sections_idx").on(t.organisationId, t.personnelId),
    check("personnel_sections_count", sql`${t.count} >= 0`),
  ],
);

/** A named player in an ensemble's section, with their own agreement and headphones. */
export const sectionMembers = pgTable(
  "section_members",
  {
    id: id(),
    organisationId: organisationId(),
    sectionId: uuid("section_id")
      .notNull()
      .references(() => personnelSections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    agreement: boolean("agreement").notNull().default(false),
    headphones: boolean("headphones").notNull().default(false),
    position: integer("position").notNull().default(0),
  },
  (t) => [index("section_members_idx").on(t.organisationId, t.sectionId)],
);

/**
 * A work in a project's repertoire (#48, docs/domain.md): its title, composer, forces and the
 * abbreviation a schedule uses, with its tracks in order.
 */
export const works = pgTable(
  "works",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    title: text("title").notNull(),
    composer: text("composer").notNull().default(""),
    forces: text("forces").notNull().default(""),
    abbreviation: text("abbreviation").notNull().default(""),
    notes: text("notes").notNull().default(""),
    /** The score its tracks follow: one PDF for the whole work. */
    scoreFileId: uuid("score_file_id").references(() => files.id, { onDelete: "set null" }),
    /** Added to a printed page number for the PDF's page (a cover and contents make it 2). */
    pageOffset: integer("page_offset").notNull().default(0),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("works_project_idx").on(t.organisationId, t.projectId)],
);

/** A work's tracks in order, each numbered as the score prints it. A track is in one work. */
export const workTracks = pgTable(
  "work_tracks",
  {
    id: id(),
    organisationId: organisationId(),
    workId: uuid("work_id")
      .notNull()
      .references(() => works.id, { onDelete: "cascade" }),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    number: text("number").notNull().default(""),
    /** The printed pages it runs over in the work's score. */
    pageFrom: integer("page_from"),
    pageTo: integer("page_to"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    check(
      "work_tracks_pages",
      sql`${t.pageTo} is null or (${t.pageFrom} is not null and ${t.pageTo} >= ${t.pageFrom})`,
    ),
    index("work_tracks_work_idx").on(t.organisationId, t.workId),
    uniqueIndex("work_tracks_track_idx").on(t.trackId),
  ],
);

/** A place a project records in (#48), with its address and notes for the get-in. */
export const venues = pgTable(
  "venues",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    name: text("name").notNull(),
    address: text("address").notNull().default(""),
    notes: text("notes").notNull().default(""),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("venues_project_idx").on(t.organisationId, t.projectId),
    uniqueIndex("venues_name_idx").on(t.projectId, t.name),
  ],
);

/**
 * A day of a project's schedule (#50): its label, date, venue and when its first row starts.
 * Its rows run in order beneath it.
 */
export const scheduleDays = pgTable(
  "schedule_days",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    label: text("label").notNull(),
    date: date("date"),
    venueId: uuid("venue_id").references(() => venues.id, { onDelete: "set null" }),
    /** "HH:MM", 24-hour. */
    start: text("start").notNull().default("10:00"),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("schedule_days_project_idx").on(t.organisationId, t.projectId)],
);

/**
 * A row of a schedule day: a slot of repertoire, a break, a get-in, a move between venues or
 * anything else. Its start chains from the row before unless set; it is ticked off when done.
 */
export const scheduleRows = pgTable(
  "schedule_rows",
  {
    id: id(),
    organisationId: organisationId(),
    dayId: uuid("day_id")
      .notNull()
      .references(() => scheduleDays.id, { onDelete: "cascade" }),
    kind: scheduleRowKindEnum("kind").notNull(),
    start: text("start"),
    minutes: integer("minutes").notNull(),
    label: text("label").notNull().default(""),
    allRepertoire: boolean("all_repertoire").notNull().default(false),
    personnel: text("personnel").notNull().default(""),
    notes: text("notes").notNull().default(""),
    done: boolean("done").notNull().default(false),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    check("schedule_rows_minutes", sql`${t.minutes} between 0 and 1440`),
    index("schedule_rows_day_idx").on(t.organisationId, t.dayId),
  ],
);

/** What a slot covers: works and tracks, any mix. One of the two is set. */
export const scheduleSlotItems = pgTable(
  "schedule_slot_items",
  {
    id: id(),
    organisationId: organisationId(),
    rowId: uuid("row_id")
      .notNull()
      .references(() => scheduleRows.id, { onDelete: "cascade" }),
    workId: uuid("work_id").references(() => works.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    check("schedule_slot_items_one", sql`(${t.workId} is null) <> (${t.trackId} is null)`),
    index("schedule_slot_items_row_idx").on(t.organisationId, t.rowId),
  ],
);

/**
 * What changed on a take, a field at a time (#51), so the take log can be written offline and
 * synced later: two people changing different fields both stand; the same field, the later write
 * stands and the value it replaced stays here, flagged when it was someone else's.
 */
export const takeChanges = pgTable(
  "take_changes",
  {
    id: id(),
    organisationId: organisationId(),
    takeId: uuid("take_id")
      .notNull()
      .references(() => takes.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    changedById: text("changed_by_id").references(() => users.id, { onDelete: "set null" }),
    /** When it was written, by the writer's clock: earlier than now for a change made offline. */
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull(),
    /** The writer had not seen the value it replaced: someone else's change, overwritten. */
    overwrote: boolean("overwrote").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("take_changes_take_idx").on(t.organisationId, t.takeId, t.createdAt)],
);

/**
 * One uploaded, immutable object. A file may be a variation of a version, part of a take,
 * or neither (cover artwork, a score PDF, a loose document).
 */
/**
 * An organisation's key, wrapped by the instance master key. Blob data keys are
 * wrapped by it. Versions allow rotating an organisation's key later; rotating
 * the master key only re-wraps these rows, never the stored objects.
 */
export const organisationKeys = pgTable(
  "organisation_keys",
  {
    id: id(),
    organisationId: organisationId(),
    version: integer("version").notNull(),
    /** Identifies the master key that wraps this row (a one-way fingerprint, not the key). */
    masterKeyId: text("master_key_id").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("organisation_keys_org_version_unique").on(t.organisationId, t.version)],
);

/**
 * An object in storage: an uploaded original or a derivative (proxy, peaks, tiles).
 * Its bytes live in exactly one configured backend, so backends can be added or
 * changed without breaking existing objects.
 */
export const blobs = pgTable(
  "blobs",
  {
    id: id(),
    organisationId: organisationId(),
    /** Name of the storage backend that holds the bytes (STORAGE_BACKENDS). */
    backend: text("backend").notNull(),
    key: text("key").notNull(),
    /** Size of the content before encryption. The stored ciphertext is slightly larger. */
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /**
     * SHA-256 of the content before encryption, hex encoded. Null until known: uploads
     * arrive in chunks, in any order, so the checksum job computes it afterwards.
     */
    sha256: text("sha256"),
    /** The blob's own data key, wrapped by the organisation key (docs/security.md). */
    wrappedKey: text("wrapped_key").notNull(),
    /** Which organisation key version wrapped it. */
    keyVersion: integer("key_version").notNull(),
    contentType: text("content_type"),
    ...timestamps,
  },
  (t) => [
    index("blobs_org_idx").on(t.organisationId),
    uniqueIndex("blobs_backend_key_unique").on(t.backend, t.key),
  ],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: fileKindEnum("kind").notNull(),
    /** The stored bytes. Deleting a blob that a file still uses is refused (checked at the end of the statement, so organisation deletes still cascade). */
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    /**
     * Playable proxies, or for a document or picture its drawn pages (#29): "none" for
     * files with neither.
     */
    streamStatus: streamStatusEnum("stream_status").notNull().default("none"),
    /** How many pages the document has, drawn or not; null for anything without pages. */
    pageCount: integer("page_count"),
    /** The bar numbers a score prints in its text, for going to a bar (#52); null if not read. */
    printedBars: jsonb("printed_bars").$type<PrintedBar[]>(),
    /** Audio analysis (waveform peaks and loudness): "none" for files without audio. */
    analysisStatus: streamStatusEnum("analysis_status").notNull().default("none"),
    /** Measured by the media worker; null until the file has been probed. */
    mediaInfo: jsonb("media_info").$type<MediaInfo>(),
    /**
     * A video's filmstrip (#16): its frames at even steps along it, side by side in one
     * encrypted picture; null for anything else, or a video packaged before there was one.
     */
    filmstripBlobId: uuid("filmstrip_blob_id").references(() => blobs.id, {
      onDelete: "no action",
    }),
    /** How many frames the filmstrip holds. */
    filmstripFrames: integer("filmstrip_frames"),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "set null" }),
    /** Within a take: the microphone or channel name, for example "Main pair L". */
    takeChannel: text("take_channel"),
    /** Within a take: true for the summed mix. */
    isTakeMix: boolean("is_take_mix").notNull().default(false),
    /** What this file alone is measured against, over its track's and project's (#144). */
    deliveryProfile: text("delivery_profile").$type<ProfileRef>(),
    /**
     * The file this one replaces, in a simple version chain of loose files (#149): each has
     * at most one later version, and the chain is the files linked this way, oldest first.
     * The routes keep it free of loops under the project's lock; the database holds the rest
     * (#427): the file it names exists (a deleted one leaves null), and no two files name the
     * same one.
     */
    previousFileId: uuid("previous_file_id").references((): AnyPgColumn => files.id, {
      onDelete: "set null",
    }),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("files_search_idx").using("gin", searchVector(sql`coalesce(${t.name}, '')`)),
    uniqueIndex("files_previous_unique").on(t.previousFileId),
    index("files_org_idx").on(t.organisationId),
    index("files_project_folder_idx").on(t.projectId, t.folderId),
    index("files_take_idx").on(t.takeId),
    index("files_blob_idx").on(t.blobId),
  ],
);

/** A piece of music in review, for example "Maple Tree Rag". */
export const tracks = pgTable(
  "tracks",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** The score this track follows, for bar anchors and the score view. */
    scoreFileId: uuid("score_file_id").references(() => files.id, { onDelete: "set null" }),
    /**
     * A score swapped for one not yet drawn (#52): the edition its marks still sit on, and who
     * swapped it, until the new one's bars are read and the marks follow them.
     */
    rehomeFrom: uuid("rehome_from").references(() => files.id, { onDelete: "set null" }),
    rehomeById: text("rehome_by_id").references(() => users.id, { onDelete: "set null" }),
    /** What its versions are measured against, over the project's (#144). */
    deliveryProfile: text("delivery_profile").$type<ProfileRef>(),
    /** The references its comments may name, over the project's; null keeps the project's (#240). */
    commentReferences: jsonb("comment_references").$type<CommentReferences>(),
    /** How its recordings play normalised, over the project's; null keeps the project's (#98). */
    normalisation: text("normalisation").$type<NormalisationMode>(),
    /** Where it stands in its workflow ("Editing"), as the last action to set one left it (#25). */
    workflowStatus: text("workflow_status"),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("tracks_search_idx").using("gin", searchVector(sql`coalesce(${t.name}, '')`)),
    index("tracks_org_idx").on(t.organisationId),
    index("tracks_project_idx").on(t.projectId),
  ],
);

/** One edit of a track. Numbered from 1; a new edit is a new version. */
export const versions = pgTable(
  "versions",
  {
    id: id(),
    organisationId: organisationId(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    notes: text("notes"),
    /** How it was cut from the takes: an edit decision list in the same project. */
    edlFileId: uuid("edl_file_id").references((): AnyPgColumn => files.id, {
      onDelete: "set null",
    }),
    /** Who let it in past the project's version checks, when someone had to. */
    letThroughBy: text("let_through_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("versions_org_idx").on(t.organisationId),
    uniqueIndex("versions_track_number_idx").on(t.trackId, t.number),
    check("versions_number_positive", sql`${t.number} > 0`),
  ],
);

/** A file within a version that differs in treatment, for example the dry or the wet mix. */
export const variations = pgTable(
  "variations",
  {
    id: id(),
    organisationId: organisationId(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    position: integer("position").notNull().default(0),
    /** A rendition's treatment (#16): subtitled or clean, graded or ungraded; null until said. */
    subtitled: boolean("subtitled"),
    graded: boolean("graded"),
    ...timestamps,
  },
  (t) => [
    index("variations_org_idx").on(t.organisationId),
    uniqueIndex("variations_file_idx").on(t.fileId),
    uniqueIndex("variations_one_primary_idx").on(t.versionId).where(sql`${t.isPrimary}`),
  ],
);

/**
 * A kind of comment in a project, such as Noise (#36), and how its comments are handled by
 * default: on this version, deferred to a named stage, or information only.
 */
export const commentCategories = pgTable(
  "comment_categories",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    name: text("name").notNull(),
    handling: categoryHandlingEnum("handling").notNull().default("normal"),
    /** Deferred categories only: the stage their comments wait for. */
    stage: text("stage"),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("comment_categories_project_idx").on(t.organisationId, t.projectId),
    uniqueIndex("comment_categories_name_idx").on(t.projectId, sql`lower(${t.name})`),
  ],
);

/**
 * The comment categories every new project in a workspace starts with (decision 247): copied
 * into the project's own `comment_categories` when it is made, never linked, so changing the
 * set changes no project that already exists.
 */
export const workspaceCategories = pgTable(
  "workspace_categories",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    handling: categoryHandlingEnum("handling").notNull().default("normal"),
    /** Deferred categories only: the stage their comments wait for. */
    stage: text("stage"),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("workspace_categories_name_idx").on(t.organisationId, sql`lower(${t.name})`)],
);

/**
 * A workspace's own delivery profile (#144), beside the built-in ones: what its projects,
 * tracks and files can be measured against. Referred to as `custom:` and its id.
 */
export const deliveryProfiles = pgTable(
  "delivery_profiles",
  {
    id: id(),
    organisationId: organisationId(),
    label: text("label").notNull(),
    /** The numbers, as the shared schema checks them (the label aside). */
    spec: jsonb("spec").$type<Omit<CustomProfileInput, "label">>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("delivery_profiles_label_idx").on(t.organisationId, sql`lower(${t.label})`)],
);

/** A note on a file. The anchor is validated by the shared schema; null means the whole file. */
export const comments = pgTable(
  "comments",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Set instead of `authorId` when a guest wrote it. */
    guestAuthorId: uuid("guest_author_id").references((): AnyPgColumn => guests.id, {
      onDelete: "set null",
    }),
    anchor: jsonb("anchor").$type<Anchor>(),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the author changes the text after posting. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    /** What kind of comment it is (docs/domain.md, Categories and deferral). */
    categoryId: uuid("category_id").references((): AnyPgColumn => commentCategories.id, {
      onDelete: "set null",
    }),
    /** The stage it waits for, set aside from this round's to-do list; null is not deferred. */
    deferredTo: text("deferred_to"),
    /** Who is to act on it. */
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** The members it mentions, as the picker chose them, named as they were (#133). */
    mentions: jsonb("mentions").$type<CommentMention[]>().notNull().default([]),
    /** The channel it is about (#74), by its place in the file's order; null is all of them. */
    channel: integer("channel"),
    /** The marker list it was imported from (#134), by the list's name, and who imported it. */
    importedFrom: text("imported_from"),
    importedById: text("imported_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("comments_org_idx").on(t.organisationId),
    index("comments_file_idx").on(t.fileId),
    index("comments_search_idx").using("gin", searchVector(sql`coalesce(${t.body}, '')`)),
  ],
);

/**
 * A caption track on a video or a recording, from a sidecar file (#146, #201): its bytes an
 * encrypted blob like any other, kept as it came, and its cues read once when it was added,
 * which the player shows and the transcript lists. It goes with its file.
 */
export const captionTracks = pgTable(
  "caption_tracks",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    /** How the player's menu names it: "English", "English (SDH)". */
    label: text("label").notNull(),
    /** Its language tag (BCP 47), where it is known: "en", "fr-CA". */
    language: text("language"),
    /** Subtitles (the words) or captions for the deaf and hard of hearing (#201). */
    kind: text("kind").$type<CaptionKind>().notNull().default("subtitles"),
    /** The sidecar's own file name. */
    name: text("name").notNull(),
    format: text("format").$type<CaptionFormat>().notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    cues: jsonb("cues").$type<CaptionCue[]>().notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("caption_tracks_file_idx").on(t.organisationId, t.fileId)],
);

/**
 * A file attached to a comment (#133): its bytes an encrypted blob like any other, reached only
 * through a one-time download made for the person asking. It goes with its comment.
 */
export const commentAttachments = pgTable(
  "comment_attachments",
  {
    id: id(),
    organisationId: organisationId(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comment_attachments_comment_idx").on(t.organisationId, t.commentId)],
);

/**
 * Takes shared on a thread (#133): "other options for bar 72", chosen by whoever triages and
 * heard by everyone who sees the thread, a guest reviewer included, and nothing more.
 */
export const commentTakes = pgTable(
  "comment_takes",
  {
    id: id(),
    organisationId: organisationId(),
    /** The thread: its first comment. */
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    takeId: uuid("take_id")
      .notNull()
      .references(() => takes.id, { onDelete: "cascade" }),
    sharedById: text("shared_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("comment_takes_pair_idx").on(t.commentId, t.takeId),
    index("comment_takes_take_idx").on(t.organisationId, t.takeId),
  ],
);

/**
 * A comment thread carried to a later version (docs/domain.md, Comments across versions):
 * where it points on that version's file, whether it shows there, and its status there.
 * The thread itself stays on the file it was raised on; replies join it from any version.
 */
export const commentCarries = pgTable(
  "comment_carries",
  {
    id: id(),
    organisationId: organisationId(),
    /** The thread: its first comment. */
    commentId: uuid("comment_id")
      .notNull()
      .references(() => comments.id, { onDelete: "cascade" }),
    /** The later version's file it is carried to. */
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** The anchor mapped onto this file; null is the whole file. */
    anchor: jsonb("anchor").$type<Anchor>(),
    /** Set once someone has placed the anchor by hand: alignment no longer moves it. */
    anchorPlaced: boolean("anchor_placed").notNull().default(false),
    visible: boolean("visible").notNull().default(true),
    status: carryStatusEnum("status").notNull().default("open"),
    statusById: text("status_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("comment_carries_org_idx").on(t.organisationId),
    index("comment_carries_file_idx").on(t.fileId),
    uniqueIndex("comment_carries_thread_file_idx").on(t.commentId, t.fileId),
  ],
);

/**
 * Where the same music sits in two files, usually a variation and its counterpart in the
 * next version (#33): pairs of times, one in each, computed from the audio. One row per
 * ordered pair; read the other way round by swapping each pair.
 */
export const alignments = pgTable(
  "alignments",
  {
    id: id(),
    organisationId: organisationId(),
    fromFileId: uuid("from_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    toFileId: uuid("to_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    status: streamStatusEnum("status").notNull().default("pending"),
    points: jsonb("points").$type<AlignmentPoints>(),
    /** How alike the matched music is, from 0 to 1: a poor match is not used. */
    quality: doublePrecision("quality"),
    ...timestamps,
  },
  (t) => [
    index("alignments_org_idx").on(t.organisationId),
    uniqueIndex("alignments_pair_idx").on(t.fromFileId, t.toFileId),
    index("alignments_to_idx").on(t.toFileId),
  ],
);

/**
 * What the audio QA's signal checks found in a file (#41): clipping, dropouts, clicks, DC
 * offset, phase, with passes recorded too. Measured once, when the file is analysed; the
 * delivery checks are read from the measurements against the project's profile instead.
 */
export const qaFindings = pgTable(
  "qa_findings",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    check: text("check").$type<QaCheck>().notNull(),
    severity: text("severity").$type<QaSeverity>().notNull(),
    summary: text("summary").notNull(),
    channel: integer("channel"),
    start: doublePrecision("start"),
    end: doublePrecision("end"),
    details: jsonb("details").$type<QaFinding["details"]>().notNull(),
    ...timestamps,
  },
  (t) => [
    index("qa_findings_org_idx").on(t.organisationId),
    index("qa_findings_file_idx").on(t.fileId),
  ],
);

// Access log

/**
 * The append-only access log (docs/security.md). Rows are never updated, and only
 * deleted by an explicit purge; triggers in migration 0006 enforce both. References
 * are plain ids, not foreign keys, so the record outlives the files, people and
 * reviews it mentions. The actor's name and email are copied at the time.
 */
export const accessEvents = pgTable(
  "access_events",
  {
    id: id(),
    organisationId: organisationId(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    action: auditActionEnum("action").notNull(),
    actorType: auditActorEnum("actor_type").notNull(),
    /** The member's user id, or null for guests and the system. */
    userId: text("user_id"),
    /** Guest access record, once guests exist (issue 24). */
    guestId: uuid("guest_id"),
    /** Who it was, as shown at the time: a name and email address. */
    actorLabel: text("actor_label").notNull(),
    projectId: uuid("project_id"),
    fileId: uuid("file_id"),
    reviewId: uuid("review_id"),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    /** Action-specific facts, for example the byte range or rendition. Never secrets. */
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("access_events_org_time_idx").on(t.organisationId, t.id),
    index("access_events_file_idx").on(t.organisationId, t.fileId, t.id),
    index("access_events_user_idx").on(t.organisationId, t.userId, t.id),
    index("access_events_review_idx").on(t.organisationId, t.reviewId, t.id),
    index("access_events_project_idx").on(t.organisationId, t.projectId, t.id),
  ],
);

// Uploads

/**
 * A resumable upload in progress. Chunks are encrypted as they arrive and stored as
 * parts of a multipart upload in the chosen backend, so plaintext never waits on
 * the server. Completing it creates the blob and the file.
 */
export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    /** Plaintext size the client declared; every chunk is checked against it. */
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    status: uploadStatusEnum("status").notNull().default("open"),
    /** The blob this upload becomes. Its id is fixed now: it is bound into the encryption. */
    blobId: uuid("blob_id").notNull(),
    backend: text("backend").notNull(),
    key: text("key").notNull(),
    /** The backend's own multipart upload id. */
    backendUploadId: text("backend_upload_id").notNull(),
    wrappedKey: text("wrapped_key").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** The object's nonce prefix, base64. Not secret, but fixed for every chunk. */
    noncePrefix: text("nonce_prefix").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("uploads_org_idx").on(t.organisationId),
    index("uploads_open_expiry_idx").on(t.status, t.expiresAt),
  ],
);

/** One received chunk of an upload, stored as part number chunk + 1 in the backend. */
export const uploadParts = pgTable(
  "upload_parts",
  {
    organisationId: organisationId(),
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => uploads.id, { onDelete: "cascade" }),
    chunk: integer("chunk").notNull(),
    /** The backend's tag for the stored part, needed to complete the upload. */
    tag: text("tag").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.uploadId, t.chunk] })],
);

// Protected streaming

// Upload requests

/**
 * A link for someone outside a project to upload files into one of its folders (#139). The
 * link is the credential: only a hash of its token is kept, it reads nothing, and it accepts
 * files only until it expires, reaches its limit or is closed.
 */
export const uploadRequests = pgTable(
  "upload_requests",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    /** Where files arrive; null for the project's top level. */
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    /**
     * A track whose next version each file becomes once measured (#425); null for a request
     * into a folder. Its foreign key follows in a later release, as adding one to a table the
     * release before knows contracts the schema (decision 198).
     */
    trackId: uuid("track_id"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    /** What is wanted, shown to the visitor. */
    wanted: text("wanted").notNull().default(""),
    fileLimit: integer("file_limit").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    tokenHash: text("token_hash").notNull(),
    /** scrypt of the password, with its salt; null when none is asked. */
    passwordHash: text("password_hash"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("upload_requests_token_idx").on(t.tokenHash),
    index("upload_requests_project_idx").on(t.organisationId, t.projectId),
  ],
);

/** An upload sent through a request, and who said they sent it. */
export const uploadRequestUploads = pgTable(
  "upload_request_uploads",
  {
    uploadId: uuid("upload_id")
      .primaryKey()
      .references(() => uploads.id, { onDelete: "cascade" }),
    organisationId: organisationId(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => uploadRequests.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
  },
  (t) => [index("upload_request_uploads_request_idx").on(t.organisationId, t.requestId)],
);

/** A file that arrived through a request: what arrived, and from whom. */
export const uploadRequestFiles = pgTable(
  "upload_request_files",
  {
    fileId: uuid("file_id")
      .primaryKey()
      .references(() => files.id, { onDelete: "cascade" }),
    organisationId: organisationId(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => uploadRequests.id, { onDelete: "cascade" }),
    sender: text("sender").notNull(),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("upload_request_files_request_idx").on(t.organisationId, t.requestId)],
);

/**
 * A playable proxy of a file: HLS with fragmented MP4 segments, each encrypted with
 * AES-128 under this rendition's content key (docs/security.md). Segments and the
 * initialisation section are blobs, so they are also encrypted at rest.
 */
export const renditions = pgTable(
  "renditions",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** For example "aac-256" or "720p". */
    name: text("name").notNull(),
    /** RFC 6381 codecs for the playlist, for example "mp4a.40.2" or "avc1.64001f,mp4a.40.2". */
    codecs: text("codecs").notNull(),
    /** Peak bits per second, for the playlist. */
    bandwidth: integer("bandwidth").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** Longest segment, in whole seconds, for EXT-X-TARGETDURATION. */
    targetDuration: integer("target_duration").notNull(),
    initBlobId: uuid("init_blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    /** The initialisation section's AES-128 IV, hex. */
    initIv: text("init_iv").notNull(),
    /** The AES-128 content key, wrapped by the organisation key and bound to this rendition. */
    wrappedKey: text("wrapped_key").notNull(),
    keyVersion: integer("key_version").notNull(),
    ...timestamps,
  },
  (t) => [index("renditions_file_idx").on(t.organisationId, t.fileId)],
);

export const renditionSegments = pgTable(
  "rendition_segments",
  {
    organisationId: organisationId(),
    renditionId: uuid("rendition_id")
      .notNull()
      .references(() => renditions.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    /** Seconds. */
    duration: doublePrecision("duration").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    /** AES-128 IV, hex; random per segment. */
    iv: text("iv").notNull(),
  },
  (t) => [primaryKey({ columns: [t.renditionId, t.index] })],
);

/**
 * Waveform peaks for a file's audio, one row per zoom level (docs/security.md). Each level
 * is an encrypted blob in the format of `packages/shared/src/peaks.ts`.
 */
export const peakLevels = pgTable(
  "peak_levels",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** Source samples per channel that each peak covers. */
    samplesPerPeak: integer("samples_per_peak").notNull(),
    peakCount: integer("peak_count").notNull(),
    channels: integer("channels").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("peak_levels_file_level_idx").on(t.organisationId, t.fileId, t.samplesPerPeak),
  ],
);

/**
 * One page of a document or picture as the server drew it (#29, docs/security.md): at
 * review size and as a thumbnail, both WebP, both encrypted blobs. The file itself never
 * reaches a browser; these do, through session-bound links, every view logged.
 */
export const filePages = pgTable(
  "file_pages",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** 1-based. */
    page: integer("page").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    thumbBlobId: uuid("thumb_blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("file_pages_file_page_idx").on(t.organisationId, t.fileId, t.page)],
);

/**
 * A file's loudness and levels (docs/security.md): the summary a reviewer reads first, and
 * the series over time (100 ms frames) as an encrypted blob in the format of
 * `packages/shared/src/loudness.ts`.
 */
export const loudness = pgTable(
  "loudness",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    summary: jsonb("summary").$type<LoudnessSummary>().notNull(),
    channels: integer("channels").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    samplesPerFrame: integer("samples_per_frame").notNull(),
    frameCount: integer("frame_count").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("loudness_file_idx").on(t.organisationId, t.fileId)],
);

/**
 * A file's spectrograms (docs/security.md): one per channel, plus the mid and side of the
 * front pair, each an encrypted blob in the format of `packages/shared/src/spectrogram.ts`.
 */
export const spectrograms = pgTable(
  "spectrograms",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** A channel index ("0", "1", …), or "mid" or "side". */
    channel: text("channel").notNull(),
    fftSize: integer("fft_size").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    samplesPerColumn: integer("samples_per_column").notNull(),
    columnCount: integer("column_count").notNull(),
    bandCount: integer("band_count").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("spectrograms_file_channel_idx").on(t.organisationId, t.fileId, t.channel)],
);

/**
 * Spectrograms drawn with a viewer's own analysis settings (#34): like `spectrograms`, one per
 * channel, under the key of the settings (`hann/4096/87.5`, from `analysisKey`). Drawn when
 * first asked for; removed 30 days after they were last used.
 */
export const spectrogramVariants = pgTable(
  "spectrogram_variants",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    analysis: text("analysis").notNull(),
    /** A channel index ("0", "1", …), or "mid" or "side". */
    channel: text("channel").notNull(),
    fftSize: integer("fft_size").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    samplesPerColumn: integer("samples_per_column").notNull(),
    columnCount: integer("column_count").notNull(),
    bandCount: integer("band_count").notNull(),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    /** When someone last asked for it; a month without and it goes. */
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("spectrogram_variants_file_idx").on(
      t.organisationId,
      t.fileId,
      t.analysis,
      t.channel,
    ),
    index("spectrogram_variants_used_idx").on(t.usedAt),
  ],
);

/**
 * A set of a viewer's own analysis settings that could not be drawn for a file (#34), after
 * every retry: asked for again, it answers failed rather than drawing again, until someone
 * asks for it to be tried again.
 */
export const spectrogramVariantFailures = pgTable(
  "spectrogram_variant_failures",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    analysis: text("analysis").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("spectrogram_variant_failures_file_idx").on(t.organisationId, t.fileId, t.analysis),
  ],
);

// Guests (docs/security.md, Authentication)

/**
 * Reviewers from outside the organisation, without an account: a conductor, a soloist, a
 * composer. Stored per organisation by email and reused across reviews.
 */
export const guests = pgTable(
  "guests",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    /** Lower-cased. */
    email: text("email").notNull(),
    /** How they appear beside their name, for example "Conductor". */
    label: text("label"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("guests_email_idx").on(t.organisationId, t.email)],
);

/**
 * A named set of reviewers in a project, for example "Soloists": members and guests. A
 * review asks a group's members as they are when it is sent, all at the same step.
 */
export const groups = pgTable(
  "groups",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("groups_name_idx").on(t.organisationId, t.projectId, t.name)],
);

/** A group's members: each a member of the organisation or a guest. */
export const groupMembers = pgTable(
  "group_members",
  {
    id: id(),
    organisationId: organisationId(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("group_members_user_idx").on(t.organisationId, t.groupId, t.userId),
    uniqueIndex("group_members_guest_idx").on(t.organisationId, t.groupId, t.guestId),
    check("group_members_one_person", sql`(${t.userId} is null) <> (${t.guestId} is null)`),
  ],
);

/** Magic links: single-use and short-lived. Only a hash of the token is stored. */
export const guestLinks = pgTable(
  "guest_links",
  {
    id: id(),
    organisationId: organisationId(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Where the workspace asks for one, the code sent to the guest on opening the link: only
     * its hash, when it was sent and stops working, how often it has been tried, and how many
     * have been sent for this link.
     */
    codeHash: text("code_hash"),
    codeSentAt: timestamp("code_sent_at", { withTimezone: true }),
    codeExpiresAt: timestamp("code_expires_at", { withTimezone: true }),
    codeAttempts: integer("code_attempts").notNull().default(0),
    codesSent: integer("codes_sent").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("guest_links_token_idx").on(t.tokenHash)],
);

/** A guest's signed-in browser, from a used magic link. Only a hash of the cookie is stored. */
export const guestSessions = pgTable(
  "guest_sessions",
  {
    id: id(),
    organisationId: organisationId(),
    guestId: uuid("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("guest_sessions_token_idx").on(t.tokenHash)],
);

/**
 * A download made for one person (decision 056): a link that works once, for a few minutes,
 * in the session that asked for it. Only a hash of the link is stored.
 */
export const downloadTickets = pgTable(
  "download_tickets",
  {
    id: id(),
    organisationId: organisationId(),
    /** The file it downloads; null for every score of a project at once (`projectId`). */
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    /** Every track's score in this project, with its marks, as one PDF (#52). */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** "proxy" or "original" (packages/shared, downloads.ts), or a comment's "attachment". */
    kind: text("kind").$type<DownloadKind | "attachment">().notNull(),
    /** For an attachment: which one; `fileId` is then the file whose thread holds it. */
    attachmentId: uuid("attachment_id").references(() => commentAttachments.id, {
      onDelete: "cascade",
    }),
    /** For a score: the track whose score marks are drawn over it (#52). */
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** The member's sign-in or the guest's session that asked; no other may use it. */
    sessionId: text("session_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("download_tickets_token_idx").on(t.tokenHash),
    // A file, or every score of a project; never both, never neither.
    check("download_tickets_target", sql`(${t.fileId} is null) <> (${t.projectId} is null)`),
  ],
);

/**
 * An invisible mark made for one download (#32, decision 239): its id decides the code hidden
 * in the sound, with the workspace's key at `keyVersion`, so a leaked copy can be traced back
 * to this row. Kept as long as the workspace, without references that a deleted file, person
 * or review would take with them: who it was for and what it was are written down as they
 * were, as the access log writes them.
 */
export const forensicMarks = pgTable(
  "forensic_marks",
  {
    id: id(),
    organisationId: organisationId(),
    /** The download's entry in the access log. */
    accessEventId: uuid("access_event_id"),
    fileId: uuid("file_id").notNull(),
    fileName: text("file_name").notNull(),
    projectId: uuid("project_id").notNull(),
    /** "proxy" or "original". */
    kind: text("kind").$type<DownloadKind>().notNull(),
    userId: text("user_id"),
    guestId: uuid("guest_id"),
    /** Who it was made for, as shown at the time: a name and address. */
    recipientLabel: text("recipient_label").notNull(),
    /** For a guest, the review whose grant allowed the download. */
    reviewId: uuid("review_id"),
    /** The version of the workspace's key the mark's code was made with. */
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("forensic_marks_org_idx").on(t.organisationId, t.keyVersion)],
);

/**
 * An export of everything a workspace holds (#186): its records as JSON and its files'
 * originals, decrypted into a tar archive that is encrypted with age to `recipient`, whose
 * secret key was shown once to whoever asked and is never kept. The archive is stored as
 * ordinary encrypted blobs, in parts no larger than a backend takes as one object, and goes
 * after a week. It leaves only through a one-time link for the session that asked (`ticket*`).
 */
export const workspaceExports = pgTable(
  "workspace_exports",
  {
    id: id(),
    organisationId: organisationId(),
    /** Who asked; null once their account is gone. */
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** Asked by one of the instance's operators rather than an owner of the workspace. */
    byOperator: boolean("by_operator").notNull().default(false),
    /** The age public key (`age1…`) the archive is encrypted to. Public; never a secret. */
    recipient: text("recipient").notNull(),
    /** Queued, building, ready, failed or expired (packages/shared, workspace-export.ts). */
    status: text("status").$type<WorkspaceExportStatus>().notNull().default("queued"),
    /** The archive's parts, in order: none until it is ready, and none again once it expires. */
    blobIds: uuid("blob_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** The archive's size as it downloads, and how many stored files it holds. */
    byteSize: bigint("byte_size", { mode: "number" }),
    fileCount: integer("file_count"),
    /** Why it failed, in words for whoever asked. */
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** When a ready archive is removed. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** The one-time download link waiting, as a hash, for the session that asked for it. */
    ticketHash: text("ticket_hash"),
    ticketSessionId: text("ticket_session_id"),
    ticketExpiresAt: timestamp("ticket_expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("workspace_exports_org_idx").on(t.organisationId, t.id),
    uniqueIndex("workspace_exports_ticket_idx").on(t.ticketHash),
  ],
);

// Reviews (docs/domain.md)

/** A request to reviewers about one or more items, for approval or for feedback. */
export const reviews = pgTable(
  "reviews",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    kind: reviewKindEnum("kind").notNull(),
    title: text("title").notNull(),
    message: text("message"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    order: reviewOrderEnum("order").notNull().default("parallel"),
    /** Approvals only. */
    rule: approvalRuleEnum("rule"),
    /** With the share rule: the percentage of deciding reviewers whose approval is enough. */
    share: integer("share"),
    /** Whether the day-before reminder goes out. */
    remind: boolean("remind").notNull().default(true),
    status: reviewStatusEnum("status").notNull().default("open"),
    /** Set when the review completes: approved, changes requested, or (feedback) submitted. */
    outcome: text("outcome").$type<Exclude<ReviewOutcome, null>>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /**
     * What its reviewers may do, as requested: the workspace's defaults with the request's
     * changes. Reviewers added later get the same; one reviewer's override stays theirs.
     */
    grant: jsonb("grant").$type<ReviewerPermissions>(),
    /** Who cancelled it, and the reason its reviewers were given. */
    cancelledBy: text("cancelled_by").references(() => users.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    /** The workflow run and stage that asked for it (#25), whose run its outcome moves on. */
    workflowRunId: uuid("workflow_run_id").references((): AnyPgColumn => workflowRuns.id, {
      onDelete: "set null",
    }),
    workflowNodeId: text("workflow_node_id"),
    ...timestamps,
  },
  (t) => [
    index("reviews_workflow_idx").on(t.workflowRunId),
    index("reviews_project_idx").on(t.organisationId, t.projectId, t.createdAt),
    check("reviews_share_range", sql`${t.share} is null or ${t.share} between 1 and 100`),
    index("reviews_search_idx").using(
      "gin",
      searchVector(sql`coalesce(${t.title}, '') || ' ' || coalesce(${t.message}, '')`),
    ),
  ],
);

/** What a review covers: a track (a specific version, or its latest) or a file. */
export const reviewItems = pgTable(
  "review_items",
  {
    id: id(),
    organisationId: organisationId(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    /** With a track: a specific version. Null follows the track's latest. */
    versionId: uuid("version_id").references(() => versions.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("review_items_review_idx").on(t.organisationId, t.reviewId),
    check(
      "review_items_one_kind",
      sql`(${t.trackId} is not null and ${t.fileId} is null) or (${t.trackId} is null and ${t.fileId} is not null and ${t.versionId} is null)`,
    ),
  ],
);

/**
 * Who is asked, in order. Position is the step: the members of a group share one, so in a
 * sequence they act together and the next step starts once all of them have responded.
 */
export const reviewReviewers = pgTable(
  "review_reviewers",
  {
    id: id(),
    organisationId: organisationId(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    /** A member, or a guest: exactly one. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    /** The group they were asked through, if any; kept for display. */
    groupId: uuid("group_id").references(() => groups.id, { onDelete: "set null" }),
    /** What this reviewer may do in this review (docs/domain.md, Reviewer permissions). */
    permissions: jsonb("permissions")
      .$type<ReviewerPermissions>()
      .notNull()
      .default(defaultReviewerPermissions),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** When they were reminded that the review is due tomorrow; once only. */
    remindedAt: timestamp("reminded_at", { withTimezone: true }),
    /** With submitted feedback: a word about the review as a whole. */
    feedbackNote: text("feedback_note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("review_reviewers_user_idx").on(t.organisationId, t.reviewId, t.userId),
    uniqueIndex("review_reviewers_guest_idx").on(t.organisationId, t.reviewId, t.guestId),
    index("review_reviewers_guest_lookup_idx").on(t.guestId),
    check("review_reviewers_one_person", sql`(${t.userId} is null) <> (${t.guestId} is null)`),
  ],
);

/**
 * What one person may do in every review of a project they are asked into (#55), set on the
 * project's People page: a change over the workspace's defaults, under each review's own.
 */
export const projectReviewerGrants = pgTable(
  "project_reviewer_grants",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** A member, or a guest: exactly one. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    grant: jsonb("grant").$type<StandingGrant>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_reviewer_grants_user_idx").on(t.organisationId, t.projectId, t.userId),
    uniqueIndex("project_reviewer_grants_guest_idx").on(t.organisationId, t.projectId, t.guestId),
    check(
      "project_reviewer_grants_one_person",
      sql`(${t.userId} is null) <> (${t.guestId} is null)`,
    ),
  ],
);

/** Which items of a review each reviewer has opened, and when they first did. */
export const reviewItemOpens = pgTable(
  "review_item_opens",
  {
    id: id(),
    organisationId: organisationId(),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => reviewReviewers.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => reviewItems.id, { onDelete: "cascade" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("review_item_opens_idx").on(t.organisationId, t.reviewerId, t.itemId)],
);

/**
 * Approval decisions, append-only: a later decision supersedes an earlier one but never
 * erases it. The database refuses updates (migration 0016); rows go only with their review.
 */
export const reviewDecisionLog = pgTable(
  "review_decisions",
  {
    id: id(),
    organisationId: organisationId(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    reviewerId: uuid("reviewer_id")
      .notNull()
      .references(() => reviewReviewers.id, { onDelete: "cascade" }),
    decision: reviewDecisionEnum("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("review_decisions_review_idx").on(t.organisationId, t.reviewId, t.createdAt)],
);

// Storage reconciliation

export const storageFindingKindEnum = pgEnum("storage_finding_kind", [
  /** Bytes in a backend that no blob row accounts for. */
  "orphan_object",
  /** A blob row that no file, rendition or peak level uses. */
  "unreferenced_blob",
  /** A blob row whose bytes are gone: data loss, for a person to look at. */
  "missing_object",
]);

/**
 * What the reconciliation job found in storage (docs/security.md). Instance-wide, not
 * owned by one organisation: an orphan can outlive the organisation it belonged to, so
 * the organisation is a plain id here. A finding is acted on only once a later run has
 * seen it again, a grace period after the first.
 */
export const storageFindings = pgTable(
  "storage_findings",
  {
    id: id(),
    kind: storageFindingKindEnum("kind").notNull(),
    backend: text("backend").notNull(),
    key: text("key").notNull(),
    /** Plain ids, not references: the record outlives what it describes. */
    ownerOrganisationId: uuid("owner_organisation_id"),
    blobId: uuid("blob_id"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** When a missing object was written to the access log; retried until it is. */
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    /** When it was removed, or found to have gone away. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
  },
  (t) => [
    uniqueIndex("storage_findings_open_idx")
      .on(t.kind, t.backend, t.key)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

/**
 * Each run of the storage reconciliation, for the Storage settings' "last run": the nightly
 * instance-wide run, or one an admin asked for over their own workspace. Instance-wide like
 * the findings; a workspace's run names it in `scopeOrganisationId`, a plain id.
 */
export const storageReconciliations = pgTable(
  "storage_reconciliations",
  {
    id: id(),
    /** Null for the instance-wide run; otherwise the one workspace it covered. */
    scopeOrganisationId: uuid("scope_organisation_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    removing: boolean("removing").notNull(),
  },
  (t) => [index("storage_reconciliations_started_idx").on(t.startedAt)],
);

/**
 * What a workspace may be on (#177): its price, its limits, the features it includes and the
 * support severities it unlocks. The instance's, not any workspace's.
 */
export const plans = pgTable("plans", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  /** In the currency's minor unit; null for a plan by agreement. */
  priceAmount: integer("price_amount"),
  currency: text("currency").notNull().default("GBP"),
  interval: text("interval").$type<"month" | "year">(),
  storageQuota: bigint("storage_quota", { mode: "number" }),
  memberLimit: integer("member_limit"),
  projectLimit: integer("project_limit"),
  features: jsonb("features").$type<PlanFeature[]>().notNull().default([]),
  severities: jsonb("severities").$type<SupportSeverity[]>().notNull().default([]),
  /** Kept from new workspaces' choices; those already on it stay. */
  hidden: boolean("hidden").notNull().default(false),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  position: integer("position").notNull().default(0),
  ...timestamps,
});

/**
 * The plan a workspace is on (#177), and where it stands. None is the internal plan, which
 * limits nothing and includes everything; without the billing module every workspace is on it.
 */
export const workspacePlans = pgTable(
  "workspace_plans",
  {
    id: id(),
    organisationId: organisationId(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "restrict" }),
    status: text("status").$type<WorkspacePlanStatus>().notNull().default("active"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    renewsAt: timestamp("renews_at", { withTimezone: true }),
    /** When a subscription cancelled at the end of its period ends (#179). */
    cancelsAt: timestamp("cancels_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("workspace_plans_organisation_idx").on(t.organisationId)],
);

/**
 * A workspace's account with the billing gateway (#178): its customer there, the subscription
 * paying for its plan, and where it stands in dunning. `pastDueSince` is when a payment first
 * failed and is cleared once one succeeds; `dunningStage` counts the steps dunning has taken
 * since (warned at 7 days, at 14, suspended at 21).
 */
export const billingAccounts = pgTable(
  "billing_accounts",
  {
    id: id(),
    organisationId: organisationId(),
    gateway: text("gateway").$type<"stripe">().notNull(),
    customerId: text("customer_id").notNull(),
    subscriptionId: text("subscription_id"),
    /**
     * The checkout an owner was last sent to, until it is finished or expires: asked again for
     * the same plan, the same one is given, and another plan expires it first, so a workspace
     * never pays for two subscriptions.
     */
    checkoutId: text("checkout_id"),
    checkoutPlanId: uuid("checkout_plan_id"),
    checkoutUrl: text("checkout_url"),
    checkoutExpiresAt: timestamp("checkout_expires_at", { withTimezone: true }),
    /** The promo code that checkout was made with, whose use it holds until paid or closed. */
    checkoutPromoId: uuid("checkout_promo_id"),
    pastDueSince: timestamp("past_due_since", { withTimezone: true }),
    dunningStage: integer("dunning_stage").notNull().default(0),
    /** The dunning step its owners have been told of; behind `dunningStage` until mail goes. */
    noticedStage: integer("noticed_stage").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("billing_accounts_organisation_idx").on(t.organisationId),
    uniqueIndex("billing_accounts_customer_idx").on(t.gateway, t.customerId),
  ],
);

/**
 * Promo codes (#178): the instance's, a percentage or an amount off for some months (null for
 * as long as the subscription lasts), for the first `maxUses`, until a date, on some plans or
 * any. `uses` counts the checkouts holding it and the subscriptions that have it, kept under a
 * lock on the row so the limit is never passed.
 */
export const promoCodes = pgTable("promo_codes", {
  id: id(),
  code: text("code").notNull().unique(),
  percentOff: integer("percent_off"),
  amountOff: integer("amount_off"),
  currency: text("currency"),
  months: integer("months"),
  maxUses: integer("max_uses"),
  uses: integer("uses").notNull().default(0),
  until: timestamp("until", { withTimezone: true }),
  planIds: jsonb("plan_ids").$type<string[]>().notNull().default([]),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  ...timestamps,
});

/**
 * Each use of a promo code (#178): held while its checkout is open, taken once paid, given back
 * when the checkout is closed or lapses. Who used a code is read across workspaces, by the
 * operators who made it.
 */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    id: id(),
    promoCodeId: uuid("promo_code_id")
      .notNull()
      .references(() => promoCodes.id, { onDelete: "cascade" }),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "set null" }),
    /** The checkout holding it; none for one applied to a subscription at once. */
    checkoutId: text("checkout_id"),
    status: text("status").$type<"held" | "taken" | "released">().notNull(),
    ...timestamps,
  },
  (t) => [
    index("promo_redemptions_code_idx").on(t.promoCodeId),
    uniqueIndex("promo_redemptions_checkout_idx").on(t.checkoutId),
  ],
);

/**
 * Which workspace each of the gateway's customers is (#178): the one lookup a webhook makes
 * before it knows the workspace, by the gateway and customer it names. Everything after it is
 * asked of the workspace it gives.
 */
export const gatewayCustomers = pgTable(
  "gateway_customers",
  {
    id: id(),
    gateway: text("gateway").$type<"stripe">().notNull(),
    customerId: text("customer_id").notNull(),
    organisationId: uuid("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gateway_customers_customer_idx").on(t.gateway, t.customerId)],
);

/**
 * A workspace's invoices (#178): copied from the gateway as it reports them, or made by an
 * operator for a plan by agreement and marked paid by hand. Amounts in the minor unit.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: id(),
    organisationId: organisationId(),
    source: text("source").$type<InvoiceSource>().notNull(),
    /** The gateway's id for it; null for one by hand. */
    gatewayId: text("gateway_id"),
    number: text("number"),
    /** What one by hand is for, in the operator's words. */
    description: text("description"),
    status: text("status").$type<InvoiceStatus>().notNull(),
    currency: text("currency").notNull(),
    amountDue: integer("amount_due").notNull(),
    amountPaid: integer("amount_paid").notNull().default(0),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** The gateway's page for paying or reading it. */
    url: text("url"),
    /** The gateway's PDF of it. */
    pdfUrl: text("pdf_url"),
    /**
     * What credits took off one made by hand (#445), shown as a line of its own; `amountDue` is
     * what is left. Null when none did.
     */
    credit: integer("credit"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoices_gateway_idx").on(t.source, t.gatewayId),
    index("invoices_organisation_idx").on(t.organisationId, t.issuedAt),
  ],
);

/**
 * Credits an operator gave a workspace toward what it next owes (#445). Through the gateway, a
 * credit is its customer's balance, which the gateway takes off the next invoice itself; for a
 * workspace invoiced by hand, it is held here until the next invoice made by hand, which takes
 * it off as a line of its own. Amounts in the minor unit.
 */
export const billingCredits = pgTable(
  "billing_credits",
  {
    id: id(),
    organisationId: organisationId(),
    source: text("source").$type<InvoiceSource>().notNull(),
    /** The gateway's id for it (Stripe's customer balance transaction); null for one by hand. */
    gatewayId: text("gateway_id"),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    /** Why, in the operator's words. */
    reason: text("reason").notNull(),
    /** The invoice by hand it was taken off; null while it is held (and always, the gateway's). */
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("billing_credits_organisation_idx").on(t.organisationId, t.invoiceId)],
);

/**
 * Every event the billing gateway sent (#178), kept as it came: what makes a webhook idempotent
 * (one row per gateway event, taken once), replayable, and the instance's Gateway log. A payout
 * belongs to no workspace; an event outlives the workspace it was about.
 */
export const gatewayEvents = pgTable(
  "gateway_events",
  {
    id: id(),
    gateway: text("gateway").$type<"stripe">().notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "set null",
    }),
    /** What it was about, in words: `INV-0412`, a plan's name. */
    summary: text("summary"),
    amount: integer("amount"),
    currency: text("currency"),
    /** `taken`, `ignored`, or why it failed. */
    result: text("result"),
    payload: jsonb("payload").notNull(),
    /** When the gateway made it. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    takenAt: timestamp("taken_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("gateway_events_event_idx").on(t.gateway, t.eventId),
    index("gateway_events_received_idx").on(t.receivedAt),
  ],
);

/**
 * What a workspace used in a month (#175), refreshed hourly: the bytes it stores (now, and the
 * month's peak), its members, guests and projects, and the plays and downloads its access log
 * holds for the month. Plays and downloads are counted on from `countedThrough`, the last
 * access event already counted, so each refresh reads only what is new.
 */
export const workspaceUsage = pgTable(
  "workspace_usage",
  {
    id: id(),
    organisationId: organisationId(),
    /** The month's first day. */
    month: date("month").notNull(),
    storageBytes: bigint("storage_bytes", { mode: "number" }).notNull().default(0),
    storagePeak: bigint("storage_peak", { mode: "number" }).notNull().default(0),
    members: integer("members").notNull().default(0),
    guests: integer("guests").notNull().default(0),
    projects: integer("projects").notNull().default(0),
    plays: integer("plays").notNull().default(0),
    downloads: integer("downloads").notNull().default(0),
    countedThrough: uuid("counted_through"),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_usage_month_idx").on(t.organisationId, t.month)],
);

// Support (docs/domain.md)

/**
 * A ticket (#181): a question from a workspace to the people who run the instance, with a
 * reference made on sending (unique across the instance, so an operator can find it), a type,
 * and a severity the workspace's plan allowed when it was sent.
 */
export const tickets = pgTable(
  "tickets",
  {
    id: id(),
    organisationId: organisationId(),
    reference: text("reference").notNull(),
    subject: text("subject").notNull(),
    kind: text("kind").$type<TicketKind>().notNull(),
    severity: text("severity").$type<SupportSeverity>().notNull(),
    state: text("state").$type<TicketState>().notNull().default("waiting"),
    requesterId: text("requester_id").references(() => users.id, { onDelete: "set null" }),
    /** Their name when they asked, for when the account has gone. */
    requesterName: text("requester_name").notNull(),
    /** The failure they saw (#159), which the operators look up. */
    errorReference: text("error_reference"),
    /** The file or review they asked from, and whether the operators may open it. */
    itemKind: text("item_kind").$type<"file" | "review">(),
    itemId: uuid("item_id"),
    operatorAccess: boolean("operator_access").notNull().default(false),
    /** When an operator first answered, for the desk's first-reply time. */
    firstReplyAt: timestamp("first_reply_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tickets_reference_idx").on(t.reference),
    index("tickets_organisation_idx").on(t.organisationId, t.updatedAt),
    index("tickets_state_idx").on(t.state, t.updatedAt),
  ],
);

/** One message in a ticket's thread: from the workspace, an operator, or Hekate itself. */
export const ticketMessages = pgTable(
  "ticket_messages",
  {
    id: id(),
    organisationId: organisationId(),
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    author: text("author").$type<TicketAuthor>().notNull(),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    /** Their name as it was, kept when the account goes. */
    authorName: text("author_name").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_messages_ticket_idx").on(t.organisationId, t.ticketId, t.createdAt)],
);

/**
 * A file attached to a ticket's message (#181): a screenshot or a log, its bytes an encrypted
 * blob like any other, reached only by those who may read the ticket, each download logged.
 */
export const ticketAttachments = pgTable(
  "ticket_attachments",
  {
    id: id(),
    organisationId: organisationId(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => ticketMessages.id, { onDelete: "cascade" }),
    blobId: uuid("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "no action" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ticket_attachments_message_idx").on(t.organisationId, t.messageId)],
);

/**
 * The desk's canned replies (#182): answers it gives often, to start a reply from. Global: the
 * desk is the instance's, and a reply names no workspace.
 */
export const cannedReplies = pgTable("canned_replies", {
  id: id(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

// The status page (#183)

/**
 * Something down for everyone, posted by an operator from the support desk (#183): what it
 * touches, how badly, and where it stands. Instance-wide, as the services are: it names no
 * workspace, and its readers are anyone who opens the status page.
 */
export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    title: text("title").notNull(),
    impact: text("impact").$type<IncidentImpact>().notNull(),
    services: text("services").array().$type<StatusService[]>().notNull(),
    state: text("state").$type<IncidentState>().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("incidents_started").on(t.startedAt)],
);

/** An incident's updates, from the first through to its resolution. */
export const incidentUpdates = pgTable(
  "incident_updates",
  {
    id: id(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    state: text("state").$type<IncidentState>().notNull(),
    body: text("body").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("incident_updates_incident").on(t.incidentId, t.createdAt)],
);

/**
 * Each service's day as the instance measured it (#183), for the status page's 90 days: the
 * minutes checked and those it was not answering. Every replica checks each minute; the first
 * to record a minute counts it, so a minute counts once however many replicas run.
 */
export const serviceDays = pgTable(
  "service_days",
  {
    id: id(),
    /** In UTC. */
    day: date("day", { mode: "string" }).notNull(),
    service: text("service").$type<StatusService>().notNull(),
    minutes: integer("minutes").notNull().default(0),
    down: integer("down").notNull().default(0),
    /** The last minute counted, so another replica's check of it is not counted again. */
    lastMinute: timestamp("last_minute", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("service_days_day_service").on(t.day, t.service)],
);

// Notifications (docs/domain.md)

export const notificationKindEnum = pgEnum("notification_kind", notificationKinds);

/**
 * Something that happened, told to one member. Written in the same transaction as what it
 * tells of; mail goes out afterwards from here (at once, or gathered into a digest), so a
 * notification is never lost to a mail server being down.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    /** Who did it: a member or a guest, or neither when Hekate itself did. */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorGuestId: uuid("actor_guest_id").references(() => guests.id, { onDelete: "set null" }),
    /** Their name when it happened, so the line still reads after they leave. */
    actorName: text("actor_name"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    /** What happened, after the actor's name: "approved Album masters". */
    text: text("text").notNull(),
    /** More to read in a mail, such as the message with a review. */
    detail: text("detail"),
    /** Where it leads in the app, as a path. */
    link: text("link").notNull(),
    /** The workspace template its mail's subject comes from, with the values for it. */
    mail: jsonb("mail").$type<NotificationMail>(),
    /** Shown in the app; a kind someone takes by mail only is kept for the mail alone. */
    inApp: boolean("in_app").notNull().default(true),
    /** How it goes by mail, chosen when it was made; null when it does not. */
    mailMode: text("mail_mode").$type<MailMode>(),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("notifications_user_idx").on(t.organisationId, t.userId, t.id),
    index("notifications_mail_idx")
      .on(t.mailMode, t.createdAt)
      .where(sql`${t.mailMode} is not null and ${t.emailedAt} is null`),
    // A file's failure is told to each person once, whichever job failed first.
    uniqueIndex("notifications_failure_once_idx")
      .on(t.organisationId, t.fileId, t.userId)
      .where(sql`${t.kind} = 'processing_failed'`),
  ],
);

/** How notifications reach one member in one workspace. Missing means the defaults. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mailMode: text("mail_mode").$type<MailMode>().notNull().default("instant"),
    digest: text("digest").$type<DigestFrequency>().notNull().default("daily"),
    /** Choices per kind; a kind not here takes its default. */
    kinds: jsonb("kinds")
      .$type<Partial<Record<NotificationKind, NotificationChannels>>>()
      .notNull()
      .default({}),
    /** When the last digest went, so the next one gathers only what came after. */
    lastDigestAt: timestamp("last_digest_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("notification_preferences_user_idx").on(t.organisationId, t.userId)],
);

/** A track or review someone is told about beyond their own part in it. */
export const follows = pgTable(
  "follows",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id").references(() => reviews.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("follows_track_idx").on(t.organisationId, t.userId, t.trackId),
    uniqueIndex("follows_review_idx").on(t.organisationId, t.userId, t.reviewId),
    index("follows_track_lookup_idx").on(t.organisationId, t.trackId),
    check("follows_one_thing", sql`(${t.trackId} is null) <> (${t.reviewId} is null)`),
  ],
);

/** How someone arranges a project's overview: which sections, in what order. */
export const overviewLayouts = pgTable(
  "overview_layouts",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sections: jsonb("sections").$type<OverviewSection[]>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("overview_layouts_user_project_idx").on(t.organisationId, t.userId, t.projectId),
  ],
);

/** A search someone kept, to run again from the search page. Theirs alone, per workspace. */
export const savedSearches = pgTable(
  "saved_searches",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    search: jsonb("search").$type<SearchRequest>().notNull(),
    ...timestamps,
  },
  (t) => [index("saved_searches_user_idx").on(t.organisationId, t.userId)],
);

/** A label for files, shared by every project in the workspace, for example "Masters". */
export const tags = pgTable(
  "tags",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    ...timestamps,
  },
  // One "Masters" per workspace, however it is capitalised.
  (t) => [uniqueIndex("tags_name_idx").on(t.organisationId, sql`lower(${t.name})`)],
);

export const fileTags = pgTable(
  "file_tags",
  {
    id: id(),
    organisationId: organisationId(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("file_tags_file_tag_idx").on(t.organisationId, t.fileId, t.tagId),
    index("file_tags_tag_idx").on(t.organisationId, t.tagId),
  ],
);

/**
 * Someone's own marks on a folder, track or file: pinned to the top of its folder, kept as a
 * favourite, or (files only) seen. Nobody else sees them.
 */
export const marks = pgTable(
  "marks",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: projectId(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "cascade" }),
    trackId: uuid("track_id").references(() => tracks.id, { onDelete: "cascade" }),
    fileId: uuid("file_id").references(() => files.id, { onDelete: "cascade" }),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    favouriteAt: timestamp("favourite_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("marks_user_project_idx").on(t.organisationId, t.userId, t.projectId),
    uniqueIndex("marks_folder_idx").on(t.organisationId, t.userId, t.folderId),
    uniqueIndex("marks_track_idx").on(t.organisationId, t.userId, t.trackId),
    uniqueIndex("marks_file_idx").on(t.organisationId, t.userId, t.fileId),
    check("marks_one_thing", sql`num_nonnulls(${t.folderId}, ${t.trackId}, ${t.fileId}) = 1`),
  ],
);

/**
 * The accounts that may manage the instance (#155, decision 062). Global, not owned by any
 * workspace: an operator acts across every one. The first is the installer's owner.
 */
export const instanceOperators = pgTable("instance_operators", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Who made them an operator; null for the installer's owner. */
  addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

/**
 * What operators did on the instance side, and when (#155): global, like the operators, since
 * an operator's action is not any one workspace's. The audit tables (#157) will read it.
 */
export const instanceEvents = pgTable(
  "instance_events",
  {
    id: id(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    /** What it was done to, in words: an account's address, a workspace's name. */
    target: text("target"),
    details: jsonb("details"),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("instance_events_created_idx").on(t.createdAt)],
);

/**
 * What failed, behind each error reference a person sees (#159). Global: a failure may belong to
 * no workspace, and only operators read it. Who it happened to is the account, nothing more
 * about them; a workspace's reports go with it, and every report goes after ERROR_REPORT_DAYS.
 */
export const errorReports = pgTable(
  "error_reports",
  {
    id: id(),
    reference: text("reference").notNull().unique(),
    /** `api` or `worker`. */
    source: text("source").notNull(),
    /** The route (`GET /api/files/:id`) or the job's name. */
    location: text("location").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    status: integer("status"),
    requestId: text("request_id"),
    jobId: text("job_id"),
    /** The OpenTelemetry trace it happened in (#162), where traces are sent. */
    traceId: text("trace_id"),
    /** The job's data: identifiers only. */
    context: jsonb("context"),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** An operator marked it known (decision 252): seen, understood, nothing more to look into. */
    knownAt: timestamp("known_at", { withTimezone: true }),
    knownBy: text("known_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [index("error_reports_occurred_idx").on(t.occurredAt)],
);

/**
 * Instance flags (#159): switches an operator turns in Debug tools, by key (`instanceFlags` in
 * packages/shared). Global: a flag is the instance's, not a workspace's.
 */
export const instanceFlags = pgTable("instance_flags", {
  key: text("key").primaryKey(),
  on: boolean("on").notNull().default(false),
  /** When it goes off by itself; null lasts until turned off. */
  until: timestamp("until", { withTimezone: true }),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Instance settings (#160): one row, the instance's own (`instanceSettingsInput` in
 * packages/shared). Global: a setting is the instance's, not a workspace's.
 */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    /** Always "instance": there is one row. */
    id: text("id").primaryKey().default("instance"),
    settings: jsonb("settings").$type<InstanceSettings>().notNull(),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_settings_one", sql`${t.id} = 'instance'`)],
);

/**
 * The last release check (#158): one row, what the releases feed said and when. Global: the
 * releases are the project's, not a workspace's.
 */
export const releaseChecks = pgTable(
  "release_checks",
  {
    id: text("id").primaryKey().default("instance"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    releases: jsonb("releases").$type<Release[]>().notNull(),
    /** Why the last attempt failed; the releases kept are from the last that worked. */
    failed: text("failed"),
  },
  (t) => [check("release_checks_one", sql`${t.id} = 'instance'`)],
);

/** Every release this instance has started (#158), with when it first did. Global. */
export const versionsRun = pgTable("versions_run", {
  version: text("version").primaryKey(),
  firstStartedAt: timestamp("first_started_at", { withTimezone: true }).notNull().defaultNow(),
});

export const authMethodEnum = pgEnum("auth_method", authMethods);
export const authResultEnum = pgEnum("auth_result", authResults);

/**
 * Every sign-in, refusal and lockout (#157), by password, passkey, second factor, directory,
 * single sign-on or guest link, with the address and the browser. Global: a member's sign-in
 * belongs to their account, not a workspace; where one is known (a directory, a single sign-on,
 * a guest's link) it is kept, and goes with the workspace.
 */
export const authEvents = pgTable(
  "auth_events",
  {
    id: id(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    method: authMethodEnum("method").notNull(),
    result: authResultEnum("result").notNull(),
    /** Why it was refused, in words: "wrong password", "too many attempts". */
    reason: text("reason"),
    /** The address tried, or the guest's; kept as typed, so a refusal for no account shows too. */
    account: text("account").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("auth_events_occurred_idx").on(t.occurredAt),
    index("auth_events_org_idx").on(t.organisationId, t.id),
  ],
);

export const mailResultEnum = pgEnum("mail_result", mailResults);

/**
 * Every message Hekate handed to instance mail (#157), and what came of it: sent over SMTP,
 * refused (with the server's words), or written to the log where there is no SMTP. Global: a
 * message may concern no workspace, and only operators read it.
 */
export const mailEvents = pgTable(
  "mail_events",
  {
    id: id(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    result: mailResultEnum("result").notNull(),
    /** What the mail server said when it would not take the message. */
    error: text("error"),
  },
  (t) => [index("mail_events_occurred_idx").on(t.occurredAt)],
);

// Events and channels (#161)

/**
 * Where a workspace's events go: a Slack, Discord or Microsoft Teams channel, or a webhook.
 * The address (and a webhook's signing secret) is sealed with the workspace's key, as JSON;
 * `target` is what settings show of it. Failing too often in a row pauses it for a while.
 */
export const channels = pgTable(
  "channels",
  {
    id: id(),
    organisationId: organisationId(),
    kind: text("kind").$type<ChannelKind>().notNull(),
    name: text("name").notNull(),
    target: text("target").notNull(),
    configSealed: text("config_sealed").notNull(),
    /** The version of the workspace key that sealed it. */
    keyVersion: integer("key_version").notNull(),
    events: text("events").array().$type<EventKind[]>().notNull().default(sql`'{}'`),
    /** Failures in a row since the last delivery that worked. */
    failures: integer("failures").notNull().default(0),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("channels_organisation_idx").on(t.organisationId)],
);

/**
 * A workspace's own mail (#161): the provider its mail leaves through instead of the
 * instance's, with the installer's choices. Its details (password, token or client secret
 * among them) are sealed with the workspace's key, as JSON; `target` is what settings show.
 * Failing too often in a row pauses it, and the instance's mail stands in meanwhile.
 */
export const workspaceMail = pgTable(
  "workspace_mail",
  {
    id: id(),
    organisationId: organisationId(),
    provider: text("provider").$type<MailProvider>().notNull(),
    from: text("from").notNull(),
    target: text("target").notNull(),
    configSealed: text("config_sealed").notNull(),
    /** The version of the workspace key that sealed it. */
    keyVersion: integer("key_version").notNull(),
    failures: integer("failures").notNull().default(0),
    pausedUntil: timestamp("paused_until", { withTimezone: true }),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** What the provider last said when it would not take a message. */
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("workspace_mail_organisation_idx").on(t.organisationId)],
);

/**
 * Addresses mail is no longer sent to (#161), because the instance's provider reported a hard
 * bounce or a complaint: global, as the instance's mail sends for everyone. A workspace's own
 * provider's reports are kept apart, in `workspace_mail_suppressions`.
 */
export const mailSuppressions = pgTable(
  "mail_suppressions",
  {
    id: id(),
    /** Lower-cased. */
    address: text("address").notNull(),
    kind: text("kind").$type<"bounce" | "complaint">().notNull(),
    /** The provider that reported it, and what it said. */
    provider: text("provider").notNull(),
    detail: text("detail"),
    ...timestamps,
  },
  (t) => [uniqueIndex("mail_suppressions_address_idx").on(t.address)],
);

/** A workspace's own provider's bounces and complaints (#161): what its mail no longer sends to. */
export const workspaceMailSuppressions = pgTable(
  "workspace_mail_suppressions",
  {
    id: id(),
    organisationId: organisationId(),
    /** Lower-cased. */
    address: text("address").notNull(),
    kind: text("kind").$type<"bounce" | "complaint">().notNull(),
    provider: text("provider").notNull(),
    detail: text("detail"),
    ...timestamps,
  },
  (t) => [uniqueIndex("workspace_mail_suppressions_address_idx").on(t.organisationId, t.address)],
);

/**
 * The outbox: an event, written in the transaction that made it happen, waiting to be handed
 * to the channels that carry its kind. Written only while some channel of the workspace does.
 */
export const events = pgTable(
  "events",
  {
    id: id(),
    organisationId: organisationId(),
    kind: text("kind").$type<EventKind>().notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** When its deliveries were made; null while it waits. */
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => [
    index("events_waiting_idx").on(t.createdAt).where(sql`${t.dispatchedAt} is null`),
    index("events_organisation_idx").on(t.organisationId, t.createdAt),
  ],
);

/**
 * One event sent to one channel, and its attempts: the webhook log. One per event and channel,
 * so dispatching twice delivers once; a replay is a row of its own, pointing at the original.
 */
export const eventDeliveries = pgTable(
  "event_deliveries",
  {
    id: id(),
    organisationId: organisationId(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    status: text("status").$type<DeliveryStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** While one worker sends it, no other may. */
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    /** The receiver's last answer: an HTTP status, or what went wrong before one. */
    lastResult: text("last_result"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    replayOf: uuid("replay_of"),
    replayedBy: text("replayed_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("event_deliveries_once_idx")
      .on(t.channelId, t.eventId)
      .where(sql`${t.replayOf} is null`),
    index("event_deliveries_due_idx")
      .on(t.nextAttemptAt)
      .where(sql`${t.status} in ('pending', 'sending')`),
    index("event_deliveries_channel_idx").on(t.organisationId, t.channelId, t.createdAt),
    index("event_deliveries_created_idx").on(t.createdAt),
  ],
);

/**
 * The machine measured (#156): one row a minute from each running process, kept for a day, for
 * the System health page. A replica is named by an id it picks when it starts, never by its
 * host. Counts are for that minute; gauges are as they stood when it was taken. Global.
 */
export const healthSamples = pgTable(
  "health_samples",
  {
    id: id(),
    replica: uuid("replica").notNull(),
    /** The start of the minute measured. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    requests: integer("requests").notNull(),
    errors: integer("errors").notNull(),
    /** The minute's 95th percentile answer time; null when nothing was asked. */
    p95Seconds: doublePrecision("p95_seconds"),
    jobsWaiting: integer("jobs_waiting").notNull(),
    lanes: integer("lanes").notNull(),
    lanesBusy: integer("lanes_busy").notNull(),
    uploadBytes: bigint("upload_bytes", { mode: "number" }).notNull(),
    /** The machine's processors, busy for this share of the minute. */
    cpu: doublePrecision("cpu").notNull(),
    cores: integer("cores").notNull(),
    memoryUsed: bigint("memory_used", { mode: "number" }).notNull(),
    memoryTotal: bigint("memory_total", { mode: "number" }).notNull(),
    /** When this replica's metrics were last read, by then; null when never (#188). */
    metricsReadAt: timestamp("metrics_read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("health_samples_minute").on(t.replica, t.at),
    index("health_samples_at").on(t.at),
  ],
);

export const taskStatusEnum = pgEnum("task_status", taskStatuses);
export const taskPriorityEnum = pgEnum("task_priority", taskPriorities);

/**
 * A task (#140): something to do in a project, with an owner, a priority, a status and a
 * date. It may be about a track or a file, have come from a comment's thread (one task to a
 * thread, decision 124), or have been made by a workflow's task stage (#25). Numbered per
 * project, as its key shows ("JR-3").
 */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    notes: text("notes"),
    status: taskStatusEnum("status").notNull().default("pending"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    assigneeId: text("assignee_id").references(() => users.id, { onDelete: "set null" }),
    dueOn: date("due_on"),
    trackId: uuid("track_id").references((): AnyPgColumn => tracks.id, { onDelete: "set null" }),
    fileId: uuid("file_id").references((): AnyPgColumn => files.id, { onDelete: "set null" }),
    /** The thread it was made from; the task goes with it. */
    commentId: uuid("comment_id").references((): AnyPgColumn => comments.id, {
      onDelete: "cascade",
    }),
    /** The workflow run and task stage that made it (#25). */
    runId: uuid("run_id").references((): AnyPgColumn => workflowRuns.id, { onDelete: "set null" }),
    nodeId: text("node_id"),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    doneAt: timestamp("done_at", { withTimezone: true }),
    doneById: text("done_by_id").references(() => users.id, { onDelete: "set null" }),
    /** The due dates its owner was last reminded of, on the day and once late (#110). */
    dueRemindedOn: date("due_reminded_on"),
    lateRemindedOn: date("late_reminded_on"),
    ...timestamps,
  },
  (t) => [
    index("tasks_org_idx").on(t.organisationId),
    uniqueIndex("tasks_number_idx").on(t.projectId, t.number),
    index("tasks_assignee_idx").on(t.organisationId, t.assigneeId, t.status),
    uniqueIndex("tasks_comment_idx").on(t.commentId),
    index("tasks_run_idx").on(t.runId),
  ],
);

/**
 * Someone's calendar feed of a project (#141): its dates and titles as ICS, at a link that is
 * theirs alone. Only a hash of the link's token is kept, so a stolen database opens no feed;
 * resetting the link replaces the row. Whoever holds the link sees what its owner may still see.
 */
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: projectId(),
    /** SHA-256 of the token in the link, hex. */
    tokenHash: text("token_hash").notNull(),
    /** When a calendar last read it. */
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_feeds_org_idx").on(t.organisationId),
    uniqueIndex("calendar_feeds_token_idx").on(t.tokenHash),
    uniqueIndex("calendar_feeds_owner_idx").on(t.organisationId, t.userId, t.projectId),
  ],
);

/** What happened to a task, for its activity: made, given, moved along, changed, noted. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: id(),
    organisationId: organisationId(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** Their name when it happened, so the line still reads after they leave. */
    actorName: text("actor_name"),
    kind: text("kind").$type<TaskEventKind>().notNull(),
    detail: jsonb("detail").$type<TaskEventDetail>(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_events_org_idx").on(t.organisationId),
    index("task_events_task_idx").on(t.taskId, t.createdAt),
  ],
);

export const transferStatusEnum = pgEnum("transfer_status", transferStatuses);

/**
 * A project moving between workspaces (#240, decision 136). It belongs to two workspaces at
 * once, so it has no single `organisation_id`: every query names one of them, as the losing
 * (`from_organisation_id`) or the gaining (`to_organisation_id`) side, and each side sees only
 * the transfers that name it. It goes with either workspace, and with the project.
 */
export const projectTransfers = pgTable(
  "project_transfers",
  {
    id: id(),
    fromOrganisationId: uuid("from_organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    toOrganisationId: uuid("to_organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The project's name when asked, for the gaining workspace, which cannot see the project. */
    projectName: text("project_name").notNull(),
    status: transferStatusEnum("status").notNull().default("pending"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /** Who refused or withdrew it, and when it stopped waiting, however it did. */
    resolvedBy: text("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // One transfer waits on a project at a time.
    uniqueIndex("project_transfers_waiting_idx")
      .on(t.projectId)
      .where(sql`${t.status} in ('pending', 'moving')`),
    index("project_transfers_from_idx").on(t.fromOrganisationId, t.status),
    index("project_transfers_to_idx").on(t.toOrganisationId, t.status),
  ],
);

// API tokens (#198)

/**
 * An API token: a member's own (`personal`), or one of the workspace's service tokens, which act
 * as the workspace through an account of their own (`user_id`, which no one signs in as). Either
 * reaches its workspace alone, within its scopes. Only a SHA-256 hash of the token is stored; the
 * token is shown once, when it is made. Revoked tokens stay, so the API log can name them.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    organisationId: organisationId(),
    kind: text("kind").$type<ApiTokenKind>().notNull(),
    /** Who it acts as: the member, or the service token's own account. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Its first characters (`hk_pat_7f3a`), to tell it apart in settings and the log. */
    hint: text("hint").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    /** Null: until it is revoked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** When it was last used, to the minute. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    revokedBy: text("revoked_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * An application's access token (#447): the connection it was issued under
     * (`oauth_grants`), whose ending revokes it. No foreign key yet: adding one to a table the
     * release before knows contracts the schema (decision 198).
     */
    grantId: uuid("grant_id"),
    ...timestamps,
  },
  (t) => [
    index("api_tokens_organisation_idx").on(t.organisationId, t.kind),
    index("api_tokens_user_idx").on(t.userId),
    index("api_tokens_grant_idx").on(t.grantId),
  ],
);

/**
 * The API log (#157, #198): each call made with a token, its answer and how long it took. The
 * path is kept without its query; nothing of the request's body or headers is.
 */
export const apiRequests = pgTable(
  "api_requests",
  {
    id: id(),
    organisationId: organisationId(),
    tokenId: uuid("token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    /** The token's name and kind when the call was made. */
    tokenName: text("token_name").notNull(),
    tokenKind: text("token_kind").$type<ApiTokenKind>().notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("api_requests_org_idx").on(t.organisationId, t.id),
    index("api_requests_token_idx").on(t.tokenId),
  ],
);

// OAuth clients and connected apps (#447)

/**
 * An application a workspace registered to ask its members for access with OAuth 2.1 (decision
 * 225). A confidential client keeps a secret, of which only a SHA-256 hash is stored, shown once
 * when it is made or rotated; a public one has none and proves each exchange with PKCE alone.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: id(),
    organisationId: organisationId(),
    name: text("name").notNull(),
    kind: text("kind").$type<OAuthClientKind>().notNull(),
    /** What the application sends to name itself (`hk_cli_…`): public, unique on the instance. */
    clientId: text("client_id").notNull().unique(),
    secretHash: text("secret_hash"),
    /** The secret's first characters (`hk_cls_7f3a`), to tell it apart in settings. */
    secretHint: text("secret_hint"),
    secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
    /** Where it may be sent back to, matched character for character. */
    redirectUris: text("redirect_uris").array().notNull(),
    /** What it may ask for; each person grants some or all of it. */
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("oauth_clients_organisation_idx").on(t.organisationId)],
);

/**
 * A member's connection of a client: what they granted it, in the client's workspace. Their
 * application's tokens are issued under it, and ending it (disconnecting, leaving the workspace,
 * deleting the client) revokes them.
 */
export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: id(),
    organisationId: organisationId(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("oauth_grants_client_user_idx").on(t.clientId, t.userId),
    index("oauth_grants_organisation_idx").on(t.organisationId, t.userId),
  ],
);

/**
 * An authorisation code: a minute long, used once, bound to its client, its redirect address
 * and its PKCE challenge. Only a hash of the code is stored.
 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: id(),
    organisationId: organisationId(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    redirectUri: text("redirect_uri").notNull(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    /** The SHA-256 of the application's code verifier, in base64url (S256 only). */
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_codes_grant_idx").on(t.grantId)],
);

/**
 * A refresh token, used once: each use answers a new one, and one used again revokes every
 * token of its connection, as it may have been stolen (OAuth 2.1, section 4.3.1). Only a hash is
 * stored.
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: id(),
    organisationId: organisationId(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().$type<ApiScope[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("oauth_refresh_tokens_grant_idx").on(t.grantId)],
);

/**
 * A listening room (#200, decision 234): one member leads, and everyone who joins hears what
 * they play. It holds only where the leader is (the file, playing or paused, the position at a
 * moment, the speed); each listener plays that file through their own protected stream. It is
 * open until its leader ends it or has not been heard from for a while (`roomOpen` in
 * packages/shared); one that has ended is kept only until the project goes.
 */
export const listeningRooms = pgTable(
  "listening_rooms",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    leaderId: text("leader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** What the leader plays; null once that file is deleted. */
    fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
    playing: boolean("playing").notNull().default(false),
    /** Seconds into the file at `state_at`. */
    position: doublePrecision("position").notNull().default(0),
    rate: doublePrecision("rate").notNull().default(1),
    stateAt: timestamp("state_at", { withTimezone: true }).notNull().defaultNow(),
    /** Counts the leader's changes. */
    revision: integer("revision").notNull().default(0),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("listening_rooms_org_idx").on(t.organisationId),
    index("listening_rooms_project_idx").on(t.organisationId, t.projectId),
    index("listening_rooms_leader_idx").on(t.leaderId),
  ],
);

/**
 * Who is in a listening room now, its leader among them: each connected page says so every
 * few seconds, and someone not heard from lately has gone (`stillThere` in packages/shared).
 */
export const listeningRoomPeople = pgTable(
  "listening_room_people",
  {
    id: id(),
    organisationId: organisationId(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => listeningRooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("listening_room_people_org_idx").on(t.organisationId),
    uniqueIndex("listening_room_people_idx").on(t.roomId, t.userId),
  ],
);
