ALTER TYPE "public"."audit_action" ADD VALUE 'guest.code_sent' BEFORE 'guest.revoke';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'guest.code_failed' BEFORE 'guest.revoke';--> statement-breakpoint
ALTER TABLE "guest_links" ADD COLUMN "code_hash" text;--> statement-breakpoint
ALTER TABLE "guest_links" ADD COLUMN "code_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_links" ADD COLUMN "code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guest_links" ADD COLUMN "code_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_links" ADD COLUMN "codes_sent" integer DEFAULT 0 NOT NULL;