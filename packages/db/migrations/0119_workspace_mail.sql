ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.mail' BEFORE 'project.archive';--> statement-breakpoint
CREATE TABLE "workspace_mail" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"from" text NOT NULL,
	"target" text NOT NULL,
	"config_sealed" text NOT NULL,
	"key_version" integer NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_mail" ADD CONSTRAINT "workspace_mail_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mail_organisation_idx" ON "workspace_mail" USING btree ("organisation_id");