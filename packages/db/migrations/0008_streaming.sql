CREATE TYPE "public"."stream_status" AS ENUM('none', 'pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "rendition_segments" (
	"organisation_id" uuid NOT NULL,
	"rendition_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"duration" double precision NOT NULL,
	"blob_id" uuid NOT NULL,
	"iv" text NOT NULL,
	CONSTRAINT "rendition_segments_rendition_id_index_pk" PRIMARY KEY("rendition_id","index")
);
--> statement-breakpoint
CREATE TABLE "renditions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	"codecs" text NOT NULL,
	"bandwidth" integer NOT NULL,
	"width" integer,
	"height" integer,
	"target_duration" integer NOT NULL,
	"init_blob_id" uuid NOT NULL,
	"init_iv" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "stream_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "rendition_segments" ADD CONSTRAINT "rendition_segments_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendition_segments" ADD CONSTRAINT "rendition_segments_rendition_id_renditions_id_fk" FOREIGN KEY ("rendition_id") REFERENCES "public"."renditions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rendition_segments" ADD CONSTRAINT "rendition_segments_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renditions" ADD CONSTRAINT "renditions_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renditions" ADD CONSTRAINT "renditions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renditions" ADD CONSTRAINT "renditions_init_blob_id_blobs_id_fk" FOREIGN KEY ("init_blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "renditions_file_idx" ON "renditions" USING btree ("organisation_id","file_id");