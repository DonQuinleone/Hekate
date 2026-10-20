import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "./id.ts";
import { files, projects } from "./schema.ts";
import { inOrg, tenantTables } from "./tenancy.ts";

describe("uuidv7", () => {
  it("is a valid version 7 UUID that sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it("sorts in creation order within one millisecond, and never repeats", () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7(1_800_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never goes backwards when the clock does", () => {
    const later = uuidv7(1_900_000_000_000);
    expect(uuidv7(1_800_000_000_000) > later).toBe(true);
  });
});

describe("tenancy", () => {
  it("covers every tenant-owned table", () => {
    const names = tenantTables.map((t) => getTableName(t)).sort();
    expect(names).toEqual([
      "access_events",
      "alignments",
      "blobs",
      "calendar_feeds",
      "caption_tracks",
      "comment_attachments",
      "comment_carries",
      "comment_categories",
      "comment_takes",
      "comments",
      "delivery_profiles",
      "directories",
      "download_tickets",
      "file_pages",
      "file_tags",
      "files",
      "folders",
      "follows",
      "group_members",
      "groups",
      "guest_links",
      "guest_sessions",
      "guests",
      "invitations",
      "loudness",
      "marks",
      "members",
      "notification_preferences",
      "notifications",
      "organisation_keys",
      "overview_layouts",
      "patch_rows",
      "peak_levels",
      "personnel",
      "personnel_sections",
      "project_members",
      "project_reviewer_grants",
      "project_roles",
      "project_templates",
      "projects",
      "qa_findings",
      "rendition_segments",
      "renditions",
      "review_decisions",
      "review_item_opens",
      "review_items",
      "review_reviewers",
      "reviews",
      "saved_searches",
      "score_mark_categories",
      "score_marks",
      "section_members",
      "session_todos",
      "session_tracks",
      "sessions",
      "spectrograms",
      "sso_providers",
      "stage_boxes",
      "stage_items",
      "stage_plans",
      "tags",
      "take_changes",
      "takes",
      "task_events",
      "tasks",
      "tracks",
      "upload_parts",
      "uploads",
      "variations",
      "venues",
      "versions",
      "work_tracks",
      "workflow_runs",
      "workflow_steps",
      "workflows",
      "works",
    ]);
    for (const table of tenantTables) {
      expect(getTableColumns(table).organisationId?.notNull).toBe(true);
    }
  });

  it("always includes the organisation condition", () => {
    const query = new PgDialect().sqlToQuery(inOrg(files, "org-1", undefined));
    expect(query.sql).toContain('"organisation_id" = $1');
    expect(query.params).toEqual(["org-1"]);
    const scoped = new PgDialect().sqlToQuery(inOrg(projects, "org-1"));
    expect(scoped.params).toEqual(["org-1"]);
  });
});
