ALTER TABLE "files" ADD COLUMN "previous_file_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_previous_file_id_files_id_fk" FOREIGN KEY ("previous_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_previous_idx" ON "files" USING btree ("previous_file_id");