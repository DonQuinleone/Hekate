ALTER TABLE "sessions" ADD COLUMN "recorder_kind" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "recorder_by" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "recorder_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "recorder_claim" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_recorder_by_users_id_fk" FOREIGN KEY ("recorder_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;