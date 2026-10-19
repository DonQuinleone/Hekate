ALTER TYPE "public"."audit_action" ADD VALUE 'file.captions_add' BEFORE 'comment.export';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'file.captions_remove' BEFORE 'comment.export';--> statement-breakpoint
CREATE TABLE "caption_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organisation_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"cues" jsonb NOT NULL,
	"created_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD CONSTRAINT "caption_tracks_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD CONSTRAINT "caption_tracks_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD CONSTRAINT "caption_tracks_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caption_tracks" ADD CONSTRAINT "caption_tracks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caption_tracks_file_idx" ON "caption_tracks" USING btree ("organisation_id","file_id");