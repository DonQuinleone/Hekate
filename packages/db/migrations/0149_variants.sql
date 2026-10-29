ALTER TYPE "public"."audit_action" ADD VALUE 'variant.replace' BEFORE 'variation.replace';--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"subtitled" boolean,
	"graded" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "variants_org_idx" ON "variants" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_file_idx" ON "variants" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variants_one_primary_idx" ON "variants" USING btree ("version_id") WHERE "variants"."is_primary";--> statement-breakpoint
-- A variant is what a variation was called before decision 275 (#484). The rows move over under the same ids, so what points at one points at the other; this release writes both tables and reads the new, and release 2 of the rename drops the old.
INSERT INTO "variants" ("id", "organisation_id", "version_id", "file_id", "name", "is_primary", "position", "subtitled", "graded", "created_at", "updated_at")
SELECT "id", "organisation_id", "version_id", "file_id", "name", "is_primary", "position", "subtitled", "graded", "created_at", "updated_at"
FROM "variations"
ON CONFLICT DO NOTHING;
