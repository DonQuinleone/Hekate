CREATE TABLE "loudness" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"summary" jsonb NOT NULL,
	"channels" integer NOT NULL,
	"sample_rate" integer NOT NULL,
	"samples_per_frame" integer NOT NULL,
	"frame_count" integer NOT NULL,
	"blob_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" RENAME COLUMN "peaks_status" TO "analysis_status";--> statement-breakpoint
ALTER TABLE "loudness" ADD CONSTRAINT "loudness_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loudness" ADD CONSTRAINT "loudness_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loudness" ADD CONSTRAINT "loudness_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loudness_file_idx" ON "loudness" USING btree ("organisation_id","file_id");