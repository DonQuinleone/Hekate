import {
  type AlignmentPoints,
  type Anchor,
  approvalRules,
  auditActions,
  auditActorTypes,
  type CommentMention,
  type CommentReferences,
  type CustomProfileInput,
  carryStatuses,
  categoryHandlings,
  type DigestFrequency,
  type DirectoryRoleRule,
  type DownloadKind,
  defaultReviewerPermissions,
  type FileColumnLayout,
  type LoudnessSummary,
  type MailMode,
  type MediaInfo,
  type NormalisationMode,
  type NotificationChannels,
  type NotificationKind,
  type NotificationMail,
  notificationKinds,
  type OverviewSection,
  type PlayerTool,
  type ProfileRef,
  type ProjectPermission,
  type ProjectProfile,
  type QaCheck,
  type QaFinding,
  type QaSettings,
  type QaSeverity,
  type ReviewerPermissions,
  type ReviewOutcome,
  reviewDecisions,
  reviewKinds,
  reviewOrders,
  reviewStatuses,
  type SearchRequest,
  type SessionFactor,
  type SsoProtocol,
  type TemplateContent,
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
   * Suspended by an operator (#174): everything is kept and nobody gets in, members and guests
   * alike, until it is reinstated. The reason is shown to its members.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  /**
   * When a suspended workspace is to be purged, with everything in it: set by an operator,
   * a grace period ahead, and cleared if it is reinstated first.
   */
  deleteAfter: timestamp("delete_after", { withTimezone: true }),
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
    /**
     * Whether its comment categories have been made: a new project gets the defaults at once,
     * one made before categories existed the first time its categories are read.
     */
    categoriesSeeded: boolean("categories_seeded").notNull().default(false),
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

/** A recording session: groups takes. */
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
    ...timestamps,
  },
  (t) => [
    index("sessions_org_idx").on(t.organisationId),
    index("sessions_project_idx").on(t.projectId),
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
    ...timestamps,
  },
  (t) => [
    index("takes_org_idx").on(t.organisationId),
    uniqueIndex("takes_track_number_idx").on(t.trackId, t.number),
    // "Which takes cover bar 72?" is a range query per track.
    index("takes_coverage_idx").on(t.organisationId, t.trackId, t.barFrom, t.barTo),
    check("takes_rating_range", sql`${t.rating} between 0 and 5`),
    check(
      "takes_bars_order",
      sql`${t.barFrom} is null or ${t.barTo} is null or ${t.barFrom} <= ${t.barTo}`,
    ),
  ],
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
    /** Audio analysis (waveform peaks and loudness): "none" for files without audio. */
    analysisStatus: streamStatusEnum("analysis_status").notNull().default("none"),
    /** Measured by the media worker; null until the file has been probed. */
    mediaInfo: jsonb("media_info").$type<MediaInfo>(),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "set null" }),
    /** Within a take: the microphone or channel name, for example "Main pair L". */
    takeChannel: text("take_channel"),
    /** Within a take: true for the summed mix. */
    isTakeMix: boolean("is_take_mix").notNull().default(false),
    /** What this file alone is measured against, over its track's and project's (#144). */
    deliveryProfile: text("delivery_profile").$type<ProfileRef>(),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("files_search_idx").using("gin", searchVector(sql`coalesce(${t.name}, '')`)),
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
    /** What its versions are measured against, over the project's (#144). */
    deliveryProfile: text("delivery_profile").$type<ProfileRef>(),
    /** The references its comments may name, over the project's; null keeps the project's (#240). */
    commentReferences: jsonb("comment_references").$type<CommentReferences>(),
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
    /** A thread made a task (#133), and when and by whom it was done. */
    todo: boolean("todo").notNull().default(false),
    todoDoneAt: timestamp("todo_done_at", { withTimezone: true }),
    todoDoneById: text("todo_done_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("comments_org_idx").on(t.organisationId),
    index("comments_file_idx").on(t.fileId),
    index("comments_search_idx").using("gin", searchVector(sql`coalesce(${t.body}, '')`)),
  ],
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
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    /** "proxy" or "original" (packages/shared, downloads.ts), or a comment's "attachment". */
    kind: text("kind").$type<DownloadKind | "attachment">().notNull(),
    /** For an attachment: which one; `fileId` is then the file whose thread holds it. */
    attachmentId: uuid("attachment_id").references(() => commentAttachments.id, {
      onDelete: "cascade",
    }),
    tokenHash: text("token_hash").notNull(),
    /** The member's sign-in or the guest's session that asked; no other may use it. */
    sessionId: text("session_id").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    guestId: uuid("guest_id").references(() => guests.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("download_tickets_token_idx").on(t.tokenHash)],
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
    ...timestamps,
  },
  (t) => [
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
    /** The job's data: identifiers only. */
    context: jsonb("context"),
    organisationId: uuid("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
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
