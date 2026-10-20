ALTER TABLE "tracks" ADD COLUMN "rehome_from" uuid;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "rehome_by_id" text;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_rehome_from_files_id_fk" FOREIGN KEY ("rehome_from") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_rehome_by_id_users_id_fk" FOREIGN KEY ("rehome_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;