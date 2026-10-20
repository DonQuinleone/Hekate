ALTER TABLE "work_tracks" ADD COLUMN "page_from" integer;--> statement-breakpoint
ALTER TABLE "work_tracks" ADD COLUMN "page_to" integer;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "score_file_id" uuid;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "page_offset" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_score_file_id_files_id_fk" FOREIGN KEY ("score_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_tracks" ADD CONSTRAINT "work_tracks_pages" CHECK ("work_tracks"."page_to" is null or ("work_tracks"."page_from" is not null and "work_tracks"."page_to" >= "work_tracks"."page_from"));