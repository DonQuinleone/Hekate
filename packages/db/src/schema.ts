import type { Anchor, ProjectProfile } from "@hekate/shared";
import {
  type AnyPgColumn,
  boolean,
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

export const profileEnum = pgEnum("project_profile", ["music", "video", "general"]);
export const roleEnum = pgEnum("member_role", ["owner", "admin", "member", "reviewer"]);
export const assetKindEnum = pgEnum("asset_kind", ["audio", "video", "document", "image", "other"]);
export const reviewStateEnum = pgEnum("review_state", [
  "in_review",
  "changes_requested",
  "approved",
]);

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

export const members = pgTable(
  "members",
  {
    id: id(),
    organisationId: organisationId(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("member"),
    ...timestamps,
  },
  (t) => [uniqueIndex("members_org_user_idx").on(t.organisationId, t.userId)],
);

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

/** A piece of media in a project: a recording, a video, a score, a document. */
export const assets = pgTable(
  "assets",
  {
    id: id(),
    organisationId: organisationId(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: assetKindEnum("kind").notNull(),
    /** Optional link from a recording to the score it follows. */
    scoreAssetId: uuid("score_asset_id").references((): AnyPgColumn => assets.id, {
      onDelete: "set null",
    }),
    position: integer("position").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("assets_org_idx").on(t.organisationId),
    index("assets_project_idx").on(t.projectId),
  ],
);

/** Takes, mixes and cuts. One version per asset can be approved. */
export const assetVersions = pgTable(
  "asset_versions",
  {
    id: id(),
    organisationId: organisationId(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    label: text("label"),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    mediaInfo: jsonb("media_info").$type<{
      duration?: number;
      fps?: number;
      width?: number;
      height?: number;
    }>(),
    reviewState: reviewStateEnum("review_state").notNull().default("in_review"),
    uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("asset_versions_org_idx").on(t.organisationId),
    uniqueIndex("asset_versions_asset_number_idx").on(t.assetId, t.number),
  ],
);

/** Every comment has an anchor, validated by the shared schema before it is written. */
export const comments = pgTable(
  "comments",
  {
    id: id(),
    organisationId: organisationId(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => assetVersions.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): AnyPgColumn => comments.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    anchor: jsonb("anchor").$type<Anchor>(),
    body: text("body").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("comments_org_idx").on(t.organisationId),
    index("comments_version_idx").on(t.versionId),
  ],
);
