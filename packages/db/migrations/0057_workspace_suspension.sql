ALTER TABLE "organisations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "suspended_reason" text;