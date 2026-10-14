CREATE TYPE "public"."audit_action" AS ENUM('stream.key', 'stream.session', 'page.render', 'download', 'file.upload', 'file.delete', 'audit.export');--> statement-breakpoint
CREATE TYPE "public"."audit_actor" AS ENUM('member', 'guest', 'system');--> statement-breakpoint
CREATE TABLE "access_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" "audit_action" NOT NULL,
	"actor_type" "audit_actor" NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"actor_label" text NOT NULL,
	"project_id" uuid,
	"file_id" uuid,
	"review_id" uuid,
	"ip_address" "inet",
	"user_agent" text,
	"details" jsonb
);
--> statement-breakpoint
ALTER TABLE "access_events" ADD CONSTRAINT "access_events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_events_org_time_idx" ON "access_events" USING btree ("organisation_id","id");--> statement-breakpoint
CREATE INDEX "access_events_file_idx" ON "access_events" USING btree ("organisation_id","file_id","id");--> statement-breakpoint
CREATE INDEX "access_events_user_idx" ON "access_events" USING btree ("organisation_id","user_id","id");--> statement-breakpoint
CREATE INDEX "access_events_review_idx" ON "access_events" USING btree ("organisation_id","review_id","id");--> statement-breakpoint
CREATE INDEX "access_events_project_idx" ON "access_events" USING btree ("organisation_id","project_id","id");