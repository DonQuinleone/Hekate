ALTER TABLE "files" ADD COLUMN "filmstrip_blob_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "filmstrip_frames" integer;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_filmstrip_blob_id_blobs_id_fk" FOREIGN KEY ("filmstrip_blob_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;