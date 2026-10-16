ALTER TYPE "public"."approval_rule" ADD VALUE 'share';--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "share" integer;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "remind" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_share_range" CHECK ("reviews"."share" is null or "reviews"."share" between 1 and 100);