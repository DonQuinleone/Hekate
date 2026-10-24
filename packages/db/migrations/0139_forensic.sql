ALTER TYPE "public"."audit_action" ADD VALUE 'forensic.trace' BEFORE 'file.upload';--> statement-breakpoint
CREATE TABLE "forensic_marks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"access_event_id" uuid,
	"file_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"guest_id" uuid,
	"recipient_label" text NOT NULL,
	"review_id" uuid,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forensic_marks" ADD CONSTRAINT "forensic_marks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forensic_marks_org_idx" ON "forensic_marks" USING btree ("organisation_id","key_version");