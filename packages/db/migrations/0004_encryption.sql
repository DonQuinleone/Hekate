CREATE TABLE "organisation_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"master_key_id" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "wrapped_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "key_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "organisation_keys" ADD CONSTRAINT "organisation_keys_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_keys_org_version_unique" ON "organisation_keys" USING btree ("organisation_id","version");