import {
  type Anchor,
  auditActions,
  auditActorTypes,
  type LoudnessSummary,
  type MediaInfo,
  type ProjectProfile,
} from "@hekate/shared";
import { sql } from "drizzle-orm";
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
export const auditActionEnum = pgEnum("audit_action", auditActions);
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
    /** Playable proxies: "none" for files that are not audio or video. */
    streamStatus: streamStatusEnum("stream_status").notNull().default("none"),
    /** Audio analysis (waveform peaks and loudness): "none" for files without audio. */
    analysisStatus: streamStatusEnum("analysis_status").notNull().default("none"),
    /** Measured by the media worker; null until the file has been probed. */
    mediaInfo: jsonb("media_info").$type<MediaInfo>(),
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
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the author changes the text after posting. */
    editedAt: timestamp("edited_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("comments_org_idx").on(t.organisationId), index("comments_file_idx").on(t.fileId)],
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
