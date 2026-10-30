ALTER TABLE "review_items" DROP CONSTRAINT "review_items_one_kind";--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "folder_id" uuid;--> statement-breakpoint
ALTER TABLE "review_items" ADD COLUMN "scope" text;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;