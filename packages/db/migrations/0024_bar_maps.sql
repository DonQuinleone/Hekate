CREATE TABLE "bar_maps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"beats_per_bar" integer NOT NULL,
	"points" jsonb NOT NULL,
	"source" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bar_maps" ADD CONSTRAINT "bar_maps_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bar_maps" ADD CONSTRAINT "bar_maps_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bar_maps" ADD CONSTRAINT "bar_maps_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bar_maps_org_idx" ON "bar_maps" USING btree ("organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bar_maps_file_idx" ON "bar_maps" USING btree ("file_id");