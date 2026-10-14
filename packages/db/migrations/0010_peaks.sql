CREATE TABLE "peak_levels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"samples_per_peak" integer NOT NULL,
	"peak_count" integer NOT NULL,
	"channels" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "peaks_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "peak_levels" ADD CONSTRAINT "peak_levels_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peak_levels" ADD CONSTRAINT "peak_levels_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "peak_levels" ADD CONSTRAINT "peak_levels_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "peak_levels_file_level_idx" ON "peak_levels" USING btree ("organisation_id","file_id","samples_per_peak");