ALTER TABLE "error_reports" ADD COLUMN "known_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "error_reports" ADD COLUMN "known_by" text;--> statement-breakpoint
ALTER TABLE "error_reports" ADD CONSTRAINT "error_reports_known_by_users_id_fk" FOREIGN KEY ("known_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;