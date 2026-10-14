import type { Anchor, ProjectProfile } from "@hekate/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./id.ts";

// Vocabulary: docs/domain.md. Use those terms exactly.

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

// Organisations and people

export const organisations = pgTable("organisations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ...timestamps,
});

/** Global identity. Shape is compatible with Better Auth's user table (text ids). */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
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
    ...timestamps,
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
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

export const members = pgTable(
  "members",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organisationRoleEnum("role").notNull().default("member"),
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
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("projects_org_idx").on(t.organisationId)],
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
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("sessions_org_idx").on(t.organisationId),
    index("sessions_project_idx").on(t.projectId),
  ],
);

/** A snippet captured in a session. Its files are one per microphone plus an optional summed mix. */
export const takes = pgTable(
  "takes",
  {
    id: id(),
    organisationId: organisationId(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    label: text("label"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    index("takes_org_idx").on(t.organisationId),
    uniqueIndex("takes_session_number_idx").on(t.sessionId, t.number),
  ],
);

/**
 * One uploaded, immutable object. A file may be a variation of a version, part of a take,
 * or neither (cover artwork, a score PDF, a loose document).
 */
export const files = pgTable(
  "files",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: projectId(),
    folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: fileKindEnum("kind").notNull(),
    /** Location of the encrypted object in storage. Storage only ever holds ciphertext. */
    storageKey: text("storage_key").notNull(),
    /** The file's data key, wrapped by the organisation key (docs/security.md). */
    wrappedKey: text("wrapped_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    mediaInfo: jsonb("media_info").$type<{
      duration?: number;
      fps?: number;
      width?: number;
      height?: number;
      channels?: number;
      sampleRate?: number;
    }>(),
    takeId: uuid("take_id").references(() => takes.id, { onDelete: "set null" }),
    /** Within a take: the microphone or channel name, for example "Main pair L". */
    takeChannel: text("take_channel"),
    /** Within a take: true for the summed mix. */
    isTakeMix: boolean("is_take_mix").notNull().default(false),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("files_org_idx").on(t.organisationId),
    index("files_project_folder_idx").on(t.projectId, t.folderId),
    index("files_take_idx").on(t.takeId),
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
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
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
    anchor: jsonb("anchor").$type<Anchor>(),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("comments_org_idx").on(t.organisationId), index("comments_file_idx").on(t.fileId)],
);
