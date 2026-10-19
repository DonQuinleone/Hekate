CREATE TYPE "public"."transfer_status" AS ENUM('pending', 'moving', 'moved', 'cancelled', 'refused', 'expired');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer_request';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer_approve';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer_accept';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer_refuse';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer_cancel';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'project.transfer';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'transfer';--> statement-breakpoint
CREATE TABLE "project_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"from_organisation_id" uuid NOT NULL,
	"to_organisation_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"status" "transfer_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_from_organisation_id_organisations_id_fk" FOREIGN KEY ("from_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_to_organisation_id_organisations_id_fk" FOREIGN KEY ("to_organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_transfers" ADD CONSTRAINT "project_transfers_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_transfers_waiting_idx" ON "project_transfers" USING btree ("project_id") WHERE "project_transfers"."status" in ('pending', 'moving');--> statement-breakpoint
CREATE INDEX "project_transfers_from_idx" ON "project_transfers" USING btree ("from_organisation_id","status");--> statement-breakpoint
CREATE INDEX "project_transfers_to_idx" ON "project_transfers" USING btree ("to_organisation_id","status");