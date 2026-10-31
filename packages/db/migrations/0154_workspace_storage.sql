ALTER TYPE "public"."audit_action" ADD VALUE 'organisation.storage' BEFORE 'organisation.export_request';--> statement-breakpoint
CREATE TABLE "workspace_buckets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"endpoint" text,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"path_style" boolean DEFAULT false NOT NULL,
	"credentials_sealed" text NOT NULL,
	"key_version" integer NOT NULL,
	"replaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_buckets" ADD CONSTRAINT "workspace_buckets_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_buckets_organisation_idx" ON "workspace_buckets" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_buckets_current_idx" ON "workspace_buckets" USING btree ("organisation_id") WHERE "workspace_buckets"."replaced_at" is null;