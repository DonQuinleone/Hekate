ALTER TYPE "public"."mail_result" ADD VALUE 'bounced';--> statement-breakpoint
ALTER TYPE "public"."mail_result" ADD VALUE 'suppressed';--> statement-breakpoint
CREATE TABLE "mail_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_mail_suppressions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"address" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_mail_suppressions" ADD CONSTRAINT "workspace_mail_suppressions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_suppressions_address_idx" ON "mail_suppressions" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mail_suppressions_address_idx" ON "workspace_mail_suppressions" USING btree ("organisation_id","address");