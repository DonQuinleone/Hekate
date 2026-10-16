ALTER TYPE "public"."audit_action" ADD VALUE 'account.directory_sign_in' BEFORE 'organisation.rename';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.directory' BEFORE 'project.archive';--> statement-breakpoint
CREATE TABLE "directories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"url" text NOT NULL,
	"verify_certificate" boolean DEFAULT true NOT NULL,
	"bind_dn" text DEFAULT '' NOT NULL,
	"bind_password_sealed" text,
	"bind_password_key_version" integer,
	"user_base" text NOT NULL,
	"user_filter" text NOT NULL,
	"email_attribute" text DEFAULT 'mail' NOT NULL,
	"name_attribute" text DEFAULT 'cn' NOT NULL,
	"group_base" text DEFAULT '' NOT NULL,
	"group_filter" text DEFAULT '(member={dn})' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directories" ADD CONSTRAINT "directories_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "directories_organisation_idx" ON "directories" USING btree ("organisation_id");