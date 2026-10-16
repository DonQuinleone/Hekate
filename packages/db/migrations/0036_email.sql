ALTER TYPE "public"."notification_kind" ADD VALUE 'due_soon';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "mail" jsonb;--> statement-breakpoint
ALTER TABLE "review_reviewers" ADD COLUMN "reminded_at" timestamp with time zone;