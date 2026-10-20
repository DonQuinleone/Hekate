ALTER TABLE "download_tickets" ALTER COLUMN "file_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_tickets" ADD CONSTRAINT "download_tickets_target" CHECK (("download_tickets"."file_id" is null) <> ("download_tickets"."project_id" is null));