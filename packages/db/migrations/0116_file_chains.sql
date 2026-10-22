ALTER TABLE "files" ADD COLUMN "previous_file_id" uuid;--> statement-breakpoint
CREATE INDEX "files_previous_idx" ON "files" USING btree ("previous_file_id");