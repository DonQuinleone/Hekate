CREATE TYPE "public"."storage_finding_kind" AS ENUM('orphan_object', 'unreferenced_blob', 'missing_object');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'storage.remove';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'storage.missing';--> statement-breakpoint
CREATE TABLE "storage_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "storage_finding_kind" NOT NULL,
	"backend" text NOT NULL,
	"key" text NOT NULL,
	"owner_organisation_id" uuid,
	"blob_id" uuid,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_findings_open_idx" ON "storage_findings" USING btree ("kind","backend","key") WHERE "storage_findings"."resolved_at" is null;