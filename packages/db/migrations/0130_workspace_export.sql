ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.export_request' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.export_download' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.deletion_request' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.deletion_confirm' BEFORE 'project.archive';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.deletion_cancel' BEFORE 'project.archive';--> statement-breakpoint
CREATE TABLE "workspace_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"requested_by" text,
	"by_operator" boolean DEFAULT false NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"blob_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"byte_size" bigint,
	"file_count" integer,
	"error" text,
	"finished_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ticket_hash" text,
	"ticket_session_id" text,
	"ticket_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "deletion_requested_by" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD CONSTRAINT "workspace_exports_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_exports" ADD CONSTRAINT "workspace_exports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_exports_org_idx" ON "workspace_exports" USING btree ("organisation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_exports_ticket_idx" ON "workspace_exports" USING btree ("ticket_hash");